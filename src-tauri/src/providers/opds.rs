//! Generic OPDS 1.x catalogs (Calibre content server, Standard Ebooks, Feedbooks, your own server...).
//! Users add catalogs by URL; each becomes a provider `opds:<id>`.
use super::*;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use tokio::sync::OnceCell;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalog {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

pub struct Opds {
    c: reqwest::Client,
    cat: Catalog,
    search_template: OnceCell<Option<String>>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Feed {
    pub title: String,
    pub entries: Vec<RemoteBook>,
    /// Navigation entries (sub-catalogs): (title, absolute href)
    pub navigation: Vec<(String, String)>,
    pub next: Option<String>,
    pub search: Option<(String, String)>, // (type, href)
}

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.as_ref() == key).map(|a| a.unescape_value().map(|v| v.to_string()).unwrap_or_default())
}

fn absolutize(base: &str, href: &str) -> String {
    reqwest::Url::parse(base).and_then(|b| b.join(href)).map(|u| u.to_string()).unwrap_or_else(|_| href.to_string())
}

pub fn parse_feed(xml: &str, base: &str, provider: &str) -> Feed {
    let mut r = Reader::from_str(xml);
    r.config_mut().trim_text(true);
    let mut feed = Feed::default();
    let mut cur: Option<RemoteBook> = None;
    let mut cur_nav: Option<(String, Option<String>)> = None;
    let mut path: Vec<String> = vec![];
    let mut text = String::new();

    let mut on_link = |e: &BytesStart, cur: &mut Option<RemoteBook>, cur_nav: &mut Option<(String, Option<String>)>, feed: &mut Feed, in_entry: bool| {
        let rel = attr(e, b"rel").unwrap_or_default();
        let ty = attr(e, b"type").unwrap_or_default();
        let Some(href) = attr(e, b"href") else { return };
        let href = absolutize(base, &href);
        if in_entry {
            if let Some(b) = cur.as_mut() {
                if rel.starts_with("http://opds-spec.org/acquisition") {
                    if let Some(f) = format_from_mime(&ty, &href) {
                        b.files.push(RemoteFile { url: href.clone(), format: f, size: attr(e, b"length").and_then(|s| s.parse().ok()), label: attr(e, b"title") });
                    }
                } else if rel == "http://opds-spec.org/image" || (rel == "http://opds-spec.org/image/thumbnail" && b.cover_url.is_none()) {
                    b.cover_url = Some(href.clone());
                } else if rel == "alternate" && ty.contains("html") {
                    b.web_url = Some(href.clone());
                }
            }
            if ty.contains("profile=opds-catalog") || ty.contains("kind=navigation") || rel == "subsection" || (ty.contains("atom+xml") && rel.is_empty()) {
                if let Some(n) = cur_nav.as_mut() { n.1 = Some(href); }
            }
        } else {
            match rel.as_str() {
                "next" => feed.next = Some(href),
                "search" => feed.search = Some((ty, href)),
                _ => {}
            }
        }
    };

    loop {
        let ev = r.read_event();
        match ev {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                let is_empty = matches!(ev, Ok(Event::Empty(_)));
                let in_entry = path.iter().any(|p| p == "entry");
                if name == "entry" && !is_empty {
                    cur = Some(RemoteBook { provider: provider.into(), access: "none".into(), ..Default::default() });
                    cur_nav = Some((String::new(), None));
                }
                if name == "link" {
                    on_link(e, &mut cur, &mut cur_nav, &mut feed, in_entry);
                }
                if !is_empty {
                    path.push(name);
                    text.clear();
                }
            }
            Ok(Event::Text(t)) => text.push_str(&t.unescape().unwrap_or_default()),
            Ok(Event::CData(t)) => text.push_str(&String::from_utf8_lossy(&t)),
            Ok(Event::End(_)) => {
                let name = path.pop().unwrap_or_default();
                let parent = path.last().cloned().unwrap_or_default();
                let t = text.trim().to_string();
                if let Some(b) = cur.as_mut() {
                    match (parent.as_str(), name.as_str()) {
                        ("entry", "id") => b.id = t.clone(),
                        ("entry", "title") => { b.title = t.clone(); if let Some(n) = cur_nav.as_mut() { n.0 = t.clone(); } }
                        ("author", "name") => b.authors.push(AuthorRef { name: t.clone(), id: None }),
                        ("entry", "summary") | ("entry", "content") => if b.description.is_none() && !t.is_empty() { b.description = Some(t.clone()) },
                        ("entry", "language") => b.language = Some(t.clone()),
                        ("entry", "publisher") => b.publisher = Some(t.clone()),
                        ("entry", "issued") | ("entry", "published") => if b.year.is_none() { b.year = t.get(0..4).and_then(|y| y.parse().ok()) },
                        ("entry", "identifier") => {
                            let v = t.trim_start_matches("urn:isbn:").to_string();
                            if t.starts_with("urn:isbn:") || v.chars().filter(|c| c.is_ascii_digit()).count() >= 10 && v.len() <= 17 { b.isbn = Some(v); }
                        }
                        _ => {}
                    }
                } else if parent == "feed" && name == "title" {
                    feed.title = t.clone();
                }
                if name == "entry" {
                    if let Some(mut b) = cur.take() {
                        let nav = cur_nav.take();
                        if !b.files.is_empty() {
                            b.access = "public".into();
                            feed.entries.push(b);
                        } else if let Some((title, Some(href))) = nav {
                            feed.navigation.push((title, href));
                        } else if !b.title.is_empty() {
                            feed.entries.push(b);
                        }
                    }
                }
                text.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    feed
}

impl Opds {
    pub fn new(c: reqwest::Client, cat: Catalog) -> Self {
        Self { c, cat, search_template: OnceCell::new() }
    }

    async fn get(&self, url: &str) -> AppResult<String> {
        let mut req = self.c.get(url).header("Accept", "application/atom+xml, application/opensearchdescription+xml, */*");
        if let Some(u) = &self.cat.username {
            req = req.basic_auth(u, self.cat.password.as_ref());
        }
        Ok(req.send().await?.error_for_status()?.text().await?)
    }

    pub async fn feed(&self, url: Option<&str>) -> AppResult<Feed> {
        let u = url.unwrap_or(&self.cat.url);
        let xml = self.get(u).await?;
        Ok(parse_feed(&xml, u, &self.meta().id))
    }

    async fn template(&self) -> AppResult<Option<String>> {
        self.search_template
            .get_or_try_init(|| async {
                let root = self.feed(None).await?;
                let Some((ty, href)) = root.search else { return Ok(None) };
                if href.contains("{searchTerms}") {
                    return Ok(Some(href));
                }
                if ty.contains("opensearchdescription") {
                    let xml = self.get(&href).await?;
                    let mut r = Reader::from_str(&xml);
                    let mut best: Option<String> = None;
                    loop {
                        match r.read_event() {
                            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.local_name().as_ref() == b"Url" => {
                                let t = attr(&e, b"type").unwrap_or_default();
                                if let Some(tpl) = attr(&e, b"template") {
                                    if t.contains("atom") || best.is_none() { best = Some(absolutize(&href, &tpl)); }
                                }
                            }
                            Ok(Event::Eof) | Err(_) => break,
                            _ => {}
                        }
                    }
                    return Ok(best);
                }
                Ok(None)
            })
            .await
            .cloned()
    }
}

#[async_trait]
impl Provider for Opds {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: format!("opds:{}", self.cat.id),
            name: self.cat.name.clone(),
            description: format!("OPDS catalog · {}", self.cat.url),
            search: true,
            fulltext: false,
            authors: false,
            download: true,
            builtin: false,
        }
    }

    async fn search(&self, q: &Query) -> AppResult<SearchPage> {
        let text = [q.text.as_deref(), q.title.as_deref(), q.author.as_deref(), q.subject.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let feed = if text.trim().is_empty() {
            self.feed(None).await?
        } else {
            let tpl = self.template().await?.ok_or_else(|| AppError::Unsupported(format!("{} has no search", self.cat.name)))?;
            let url = tpl.replace("{searchTerms}", &urlencoding::encode(text.trim())).replace("{startPage?}", &q.page.max(1).to_string()).replace("{startIndex?}", "")
                .replace("{count?}", "50").replace("{language?}", "");
            self.feed(Some(&url)).await?
        };
        Ok(SearchPage { has_more: feed.next.is_some(), items: feed.entries, total: None, page: q.page.max(1) })
    }

    async fn details(&self, id: &str) -> AppResult<RemoteBook> {
        // OPDS entries are complete in the feed; search for the id as a fallback.
        let page = self.search(&Query { text: Some(id.to_string()), ..Default::default() }).await?;
        page.items.into_iter().find(|b| b.id == id).ok_or_else(|| AppError::NotFound(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_acquisition_and_navigation() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
          <title>Catalog</title>
          <link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml"/>
          <link rel="next" href="?page=2"/>
          <entry><title>New releases</title><id>nav1</id><link type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="/new"/></entry>
          <entry><title>Moby Dick</title><id>urn:x:1</id><author><name>Herman Melville</name></author>
            <dc:language>en</dc:language><dc:issued>1851</dc:issued><dc:identifier>urn:isbn:9780142437247</dc:identifier>
            <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="/books/1.epub"/>
            <link rel="http://opds-spec.org/image" type="image/jpeg" href="/covers/1.jpg"/></entry>
        </feed>"#;
        let f = super::parse_feed(xml, "https://example.org/opds/", "opds:t");
        assert_eq!(f.title, "Catalog");
        assert_eq!(f.navigation, vec![("New releases".to_string(), "https://example.org/new".to_string())]);
        assert_eq!(f.entries.len(), 1);
        let b = &f.entries[0];
        assert_eq!(b.files[0].url, "https://example.org/books/1.epub");
        assert_eq!(b.files[0].format, "epub");
        assert_eq!(b.year, Some(1851));
        assert_eq!(b.isbn.as_deref(), Some("9780142437247"));
        assert_eq!(f.search.unwrap().1, "https://example.org/opensearch.xml");
        assert_eq!(f.next.as_deref(), Some("https://example.org/opds/?page=2"));
    }
}
