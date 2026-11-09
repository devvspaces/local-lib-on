//! arXiv preprints (Atom API). Every paper has a free PDF.
use super::*;
use quick_xml::events::Event;
use quick_xml::Reader;

pub struct Arxiv {
    c: reqwest::Client,
}

impl Arxiv {
    pub fn new(c: reqwest::Client) -> Self {
        Self { c }
    }

    async fn query(&self, params: &[(&str, String)]) -> AppResult<(Vec<RemoteBook>, Option<u64>)> {
        let url = reqwest::Url::parse_with_params("https://export.arxiv.org/api/query", params).map_err(|e| AppError::other(e.to_string()))?;
        let xml = self.c.get(url).send().await?.error_for_status()?.text().await?;
        Ok(parse_feed(&xml))
    }
}

/// Minimal Atom parser for the arXiv API response.
pub fn parse_feed(xml: &str) -> (Vec<RemoteBook>, Option<u64>) {
    let mut r = Reader::from_str(xml);
    r.config_mut().trim_text(true);
    let mut out = vec![];
    let mut total = None;
    let mut cur: Option<RemoteBook> = None;
    let mut path: Vec<String> = vec![];
    let mut text = String::new();
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "entry" {
                    cur = Some(RemoteBook { provider: "arxiv".into(), access: "public".into(), publisher: Some("arXiv".into()), ..Default::default() });
                }
                path.push(name);
                text.clear();
            }
            Ok(Event::Empty(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if let (Some(b), "link") = (cur.as_mut(), name.as_str()) {
                    let mut href = None;
                    let mut title = None;
                    for a in e.attributes().flatten() {
                        match a.key.as_ref() {
                            b"href" => href = Some(String::from_utf8_lossy(&a.value).to_string()),
                            b"title" => title = Some(String::from_utf8_lossy(&a.value).to_string()),
                            _ => {}
                        }
                    }
                    if let (Some(h), Some("pdf")) = (href, title.as_deref()) {
                        b.files.push(RemoteFile { url: h.replace("http://", "https://"), format: "pdf".into(), size: None, label: Some("PDF".into()) });
                    }
                }
                if let (Some(b), "arxiv:primary_category") = (cur.as_mut(), name.as_str()) {
                    for a in e.attributes().flatten() {
                        if a.key.as_ref() == b"term" { b.subjects.push(String::from_utf8_lossy(&a.value).to_string()); }
                    }
                }
            }
            Ok(Event::Text(t)) => text.push_str(&t.unescape().unwrap_or_default()),
            Ok(Event::End(_)) => {
                let name = path.pop().unwrap_or_default();
                let parent = path.last().map(String::as_str).unwrap_or("");
                let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if let Some(b) = cur.as_mut() {
                    match (parent, name.as_str()) {
                        ("entry", "id") => {
                            let id = t.rsplit("/abs/").next().unwrap_or(&t).to_string();
                            b.web_url = Some(t.replace("http://", "https://"));
                            b.id = id.split('v').next().map(String::from).filter(|s| !s.is_empty()).unwrap_or(id);
                        }
                        ("entry", "title") => b.title = t.clone(),
                        ("entry", "summary") => b.description = Some(t.clone()),
                        ("entry", "published") => b.year = t.get(0..4).and_then(|y| y.parse().ok()),
                        ("author", "name") => b.authors.push(AuthorRef { name: t.clone(), id: Some(t.clone()) }),
                        ("entry", "arxiv:doi") => b.doi = Some(t.clone()),
                        _ => {}
                    }
                }
                if name == "opensearch:totalResults" {
                    total = t.parse().ok();
                }
                if name == "entry" {
                    if let Some(b) = cur.take() {
                        if !b.id.is_empty() { out.push(b); }
                    }
                }
                text.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (out, total)
}

#[async_trait]
impl Provider for Arxiv {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "arxiv".into(),
            name: "arXiv".into(),
            description: "Open-access preprints in physics, maths, CS, biology, economics and more.".into(),
            search: true,
            fulltext: false,
            authors: true,
            download: true,
            builtin: true,
        }
    }

    async fn search(&self, q: &Query) -> AppResult<SearchPage> {
        let mut terms = vec![];
        if let Some(t) = q.text.as_ref().filter(|s| !s.trim().is_empty()) { terms.push(format!("all:{}", quote(t))); }
        if let Some(t) = &q.title { terms.push(format!("ti:{}", quote(t))); }
        if let Some(a) = &q.author { terms.push(format!("au:{}", quote(a))); }
        if let Some(s) = &q.subject { terms.push(format!("cat:{s}")); }
        if terms.is_empty() { return Ok(SearchPage::default()); }
        let page = q.page.max(1);
        let (items, total) = self.query(&[
            ("search_query", terms.join(" AND ")),
            ("start", ((page - 1) * 40).to_string()),
            ("max_results", "40".into()),
            ("sortBy", "relevance".into()),
        ]).await?;
        Ok(SearchPage { has_more: total.map_or(false, |t| (page as u64) * 40 < t), items, total, page })
    }

    async fn details(&self, id: &str) -> AppResult<RemoteBook> {
        let (items, _) = self.query(&[("id_list", id.to_string())]).await?;
        items.into_iter().next().ok_or_else(|| AppError::NotFound(format!("arXiv {id}")))
    }

    async fn author(&self, id: &str) -> AppResult<AuthorPage> {
        let (books, _) = self.query(&[("search_query", format!("au:{}", quote(id))), ("max_results", "100".into()), ("sortBy", "submittedDate".into())]).await?;
        Ok(AuthorPage { id: id.into(), name: id.into(), books, ..Default::default() })
    }
}

fn quote(s: &str) -> String {
    let s = s.trim().replace('"', "");
    if s.contains(' ') { format!("\"{s}\"") } else { s }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_atom() {
        let xml = r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <opensearch:totalResults>1</opensearch:totalResults>
        <entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
        <title>Attention Is All
          You Need</title><summary>The dominant sequence models...</summary>
        <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
        <arxiv:doi>10.48550/x</arxiv:doi>
        <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
        <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
        <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/></entry></feed>"#;
        let (items, total) = super::parse_feed(xml);
        assert_eq!(total, Some(1));
        let b = &items[0];
        assert_eq!(b.id, "1706.03762");
        assert_eq!(b.title, "Attention Is All You Need");
        assert_eq!(b.authors.len(), 2);
        assert_eq!(b.year, Some(2017));
        assert_eq!(b.files[0].url, "https://arxiv.org/pdf/1706.03762v7");
        assert_eq!(b.subjects, vec!["cs.CL"]);
    }
}
