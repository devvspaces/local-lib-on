//! Open Library (metadata, authors, editions) + Internet Archive (public-domain downloads, search inside).
use super::*;
use serde_json::Value;

pub struct OpenLibrary {
    c: reqwest::Client,
}

impl OpenLibrary {
    pub fn new(c: reqwest::Client) -> Self {
        Self { c }
    }

    async fn json(&self, url: &str) -> AppResult<Value> {
        let r = self.c.get(url).send().await?.error_for_status()?;
        Ok(r.json().await?)
    }

    fn doc_to_book(d: &Value) -> RemoteBook {
        let s = |k: &str| d.get(k).and_then(|v| v.as_str()).map(String::from);
        let key = s("key").unwrap_or_default(); // "/works/OL123W"
        let names: Vec<String> = d["author_name"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let keys: Vec<String> = d["author_key"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let access = match d["ebook_access"].as_str() {
            Some("public") => "public",
            Some("borrowable") | Some("printdisabled") => "borrow",
            _ => "none",
        };
        let ia = d["ia"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str()).map(String::from)
            .or_else(|| d["lending_identifier_s"].as_str().map(String::from));
        RemoteBook {
            provider: "openlibrary".into(),
            // Keep the IA identifier in the id so details() can resolve files without another search.
            id: match &ia { Some(ia) => format!("{}|{}", key.trim_start_matches("/works/"), ia), None => key.trim_start_matches("/works/").to_string() },
            title: s("title").unwrap_or_default(),
            subtitle: s("subtitle"),
            authors: names.into_iter().enumerate().map(|(i, n)| AuthorRef { name: n, id: keys.get(i).cloned() }).collect(),
            year: d["first_publish_year"].as_i64(),
            language: d["language"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str()).map(String::from),
            publisher: d["publisher"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str()).map(String::from),
            description: None,
            cover_url: d["cover_i"].as_i64().map(|c| format!("https://covers.openlibrary.org/b/id/{c}-M.jpg")),
            subjects: d["subject"].as_array().map(|a| a.iter().take(8).filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            isbn: d["isbn"].as_array().and_then(|a| a.iter().filter_map(|x| x.as_str()).find(|x| x.len() == 13).or(a.first().and_then(|x| x.as_str()))).map(String::from),
            doi: None,
            web_url: Some(format!("https://openlibrary.org{key}")),
            files: vec![],
            access: access.into(),
            edition_count: d["edition_count"].as_i64(),
        }
    }

    /// Resolve downloadable files from an Internet Archive item.
    async fn ia_files(&self, ia: &str) -> AppResult<(Vec<RemoteFile>, bool)> {
        let m = self.json(&format!("https://archive.org/metadata/{ia}")).await?;
        let restricted = m["metadata"]["access-restricted-item"].as_str() == Some("true")
            || m["is_dark"].as_bool() == Some(true);
        if restricted {
            return Ok((vec![], true));
        }
        let mut out = vec![];
        for f in m["files"].as_array().into_iter().flatten() {
            let name = f["name"].as_str().unwrap_or("");
            let fmt = f["format"].as_str().unwrap_or("");
            let format = match fmt {
                "Text PDF" | "Additional Text PDF" | "Image Container PDF" => "pdf",
                "EPUB" => "epub",
                "DjVuTXT" => "txt",
                _ if name.ends_with(".epub") => "epub",
                _ => continue,
            };
            if f["private"].as_str() == Some("true") {
                continue;
            }
            out.push(RemoteFile {
                url: format!("https://archive.org/download/{ia}/{}", urlencoding::encode(name).replace("%2F", "/")),
                format: format.into(),
                size: f["size"].as_str().and_then(|s| s.parse().ok()),
                label: Some(fmt.to_string()),
            });
        }
        out.sort_by_key(|f| match f.format.as_str() { "epub" => 0, "pdf" => 1, _ => 2 });
        Ok((out, false))
    }
}

const FIELDS: &str = "key,title,subtitle,author_name,author_key,first_publish_year,language,publisher,cover_i,subject,isbn,ebook_access,ia,lending_identifier_s,edition_count";

#[async_trait]
impl Provider for OpenLibrary {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "openlibrary".into(),
            name: "Open Library".into(),
            description: "Millions of book records, author pages, and free public-domain downloads via the Internet Archive. Supports searching inside books.".into(),
            search: true,
            fulltext: true,
            authors: true,
            download: true,
            builtin: true,
        }
    }

    async fn search(&self, q: &Query) -> AppResult<SearchPage> {
        let mut params: Vec<(&str, String)> = vec![("fields", FIELDS.into()), ("limit", "40".into()), ("page", (q.page.max(1)).to_string())];
        if let Some(t) = q.text.as_ref().filter(|s| !s.trim().is_empty()) { params.push(("q", t.clone())); }
        if let Some(t) = &q.title { params.push(("title", t.clone())); }
        if let Some(a) = &q.author { params.push(("author", a.clone())); }
        if let Some(s) = &q.subject { params.push(("subject", s.clone())); }
        if let Some(l) = &q.language { params.push(("language", l.clone())); }
        if q.downloadable { params.push(("ebook_access", "public".into())); }
        let url = reqwest::Url::parse_with_params("https://openlibrary.org/search.json", &params).map_err(|e| AppError::other(e.to_string()))?;
        let j = self.json(url.as_str()).await?;
        let items: Vec<RemoteBook> = j["docs"].as_array().into_iter().flatten().map(Self::doc_to_book).collect();
        let total = j["numFound"].as_u64();
        let page = q.page.max(1);
        Ok(SearchPage { has_more: total.map_or(false, |t| (page as u64) * 40 < t), items, total, page })
    }

    async fn details(&self, id: &str) -> AppResult<RemoteBook> {
        let (work, ia) = match id.split_once('|') { Some((w, i)) => (w.to_string(), Some(i.to_string())), None => (id.to_string(), None) };
        let w = self.json(&format!("https://openlibrary.org/works/{work}.json")).await?;
        // Search doc gives us author names/keys, IA ids and access in one call.
        let s = self.json(&format!("https://openlibrary.org/search.json?q=key:/works/{work}&fields={FIELDS}")).await?;
        let mut b = s["docs"].as_array().and_then(|a| a.first()).map(Self::doc_to_book).unwrap_or_else(|| RemoteBook {
            provider: "openlibrary".into(), id: id.into(), title: w["title"].as_str().unwrap_or("").into(), access: "none".into(), ..Default::default()
        });
        b.description = match &w["description"] { Value::String(s) => Some(s.clone()), Value::Object(o) => o.get("value").and_then(|v| v.as_str()).map(String::from), _ => None };
        if let Some(c) = w["covers"].as_array().and_then(|a| a.first()).and_then(|x| x.as_i64()) {
            b.cover_url = Some(format!("https://covers.openlibrary.org/b/id/{c}-L.jpg"));
        }
        let ia = ia.or_else(|| b.id.split_once('|').map(|(_, i)| i.to_string()));
        if let Some(ia) = ia {
            if b.access == "public" {
                match self.ia_files(&ia).await {
                    Ok((files, restricted)) => {
                        b.files = files;
                        if restricted { b.access = "borrow".into(); }
                    }
                    Err(e) => eprintln!("[OpenLibrary] IA metadata failed for {ia}: {e}"),
                }
            }
            if b.access != "public" {
                b.web_url = Some(format!("https://archive.org/details/{ia}"));
            }
        }
        Ok(b)
    }

    async fn author(&self, id: &str) -> AppResult<AuthorPage> {
        let a = self.json(&format!("https://openlibrary.org/authors/{id}.json")).await?;
        let name = a["name"].as_str().unwrap_or("").to_string();
        let works = self.json(&reqwest::Url::parse_with_params("https://openlibrary.org/search.json", &[("author_key", id), ("fields", FIELDS), ("limit", "100"), ("sort", "editions")]).unwrap().to_string()).await?;
        Ok(AuthorPage {
            id: id.into(),
            bio: match &a["bio"] { Value::String(s) => Some(s.clone()), Value::Object(o) => o.get("value").and_then(|v| v.as_str()).map(String::from), _ => None },
            photo_url: a["photos"].as_array().and_then(|p| p.first()).and_then(|x| x.as_i64()).filter(|x| *x > 0).map(|p| format!("https://covers.openlibrary.org/a/id/{p}-M.jpg")),
            birth_date: a["birth_date"].as_str().map(String::from),
            death_date: a["death_date"].as_str().map(String::from),
            books: works["docs"].as_array().into_iter().flatten().map(Self::doc_to_book).collect(),
            name,
        })
    }

    async fn fulltext(&self, q: &str, page: u32) -> AppResult<Vec<FulltextHit>> {
        let url = reqwest::Url::parse_with_params("https://openlibrary.org/search/inside.json", &[("q", q.to_string()), ("page", page.max(1).to_string())]).unwrap();
        let j = self.json(url.as_str()).await?;
        let mut out = vec![];
        for h in j["hits"]["hits"].as_array().into_iter().flatten() {
            let f = &h["fields"];
            let ed = &h["edition"];
            let ia = f["identifier"].as_str().unwrap_or("").to_string();
            let title = ed["title"].as_str().or(f["meta_title"].as_str()).unwrap_or(&ia).to_string();
            let snippets = h["highlight"]["text"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.replace("{{{", "<mark>").replace("}}}", "</mark>"))).collect()).unwrap_or_default();
            let work = ed["work"]["key"].as_str().map(|k| k.trim_start_matches("/works/").to_string());
            out.push(FulltextHit {
                book: RemoteBook {
                    provider: "openlibrary".into(),
                    id: match work { Some(w) => format!("{w}|{ia}"), None => format!("|{ia}") },
                    title,
                    authors: ed["authors"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str().map(|n| AuthorRef { name: n.into(), id: x["key"].as_str().map(|k| k.trim_start_matches("/authors/").to_string()) })).collect()).unwrap_or_default(),
                    year: f["year"].as_i64(),
                    cover_url: ed["cover_url"].as_str().map(String::from),
                    access: match ed["ebook_access"].as_str() { Some("public") => "public".into(), Some("borrowable") => "borrow".into(), _ => "none".into() },
                    web_url: Some(format!("https://archive.org/details/{ia}")),
                    ..Default::default()
                },
                snippets,
            });
        }
        Ok(out)
    }
}
