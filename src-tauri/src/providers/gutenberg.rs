//! Project Gutenberg via the Gutendex API (public-domain ebooks, EPUB / plain text).
use super::*;
use serde_json::Value;

pub struct Gutenberg {
    c: reqwest::Client,
}

impl Gutenberg {
    pub fn new(c: reqwest::Client) -> Self {
        Self { c }
    }

    fn to_book(b: &Value) -> RemoteBook {
        let id = b["id"].as_i64().unwrap_or(0).to_string();
        let mut files: Vec<RemoteFile> = vec![];
        if let Some(fmts) = b["formats"].as_object() {
            for (mime, url) in fmts {
                let Some(url) = url.as_str() else { continue };
                if url.ends_with(".zip") || mime.starts_with("text/html") {
                    continue;
                }
                if let Some(f) = format_from_mime(mime, url) {
                    // Prefer the images-included EPUB3 over the noimages variant.
                    if files.iter().any(|x| x.format == f) {
                        continue;
                    }
                    files.push(RemoteFile { url: url.to_string(), format: f, size: None, label: Some(mime.clone()) });
                }
            }
        }
        files.sort_by_key(|f| match f.format.as_str() { "epub" => 0, "mobi" | "azw3" => 1, "txt" => 2, _ => 3 });
        let authors: Vec<AuthorRef> = b["authors"].as_array().into_iter().flatten().filter_map(|a| {
            let n = a["name"].as_str()?;
            // Gutenberg stores "Last, First"
            let name = match n.split_once(", ") { Some((l, f)) => format!("{f} {l}"), None => n.to_string() };
            Some(AuthorRef { id: Some(n.to_string()), name })
        }).collect();
        RemoteBook {
            provider: "gutenberg".into(),
            title: b["title"].as_str().unwrap_or("").to_string(),
            authors,
            language: b["languages"].as_array().and_then(|l| l.first()).and_then(|x| x.as_str()).map(String::from),
            subjects: b["subjects"].as_array().map(|a| a.iter().take(8).filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            description: b["summaries"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str()).map(String::from),
            cover_url: b["formats"]["image/jpeg"].as_str().map(String::from),
            web_url: Some(format!("https://www.gutenberg.org/ebooks/{id}")),
            publisher: Some("Project Gutenberg".into()),
            access: if files.is_empty() { "none".into() } else { "public".into() },
            edition_count: b["download_count"].as_i64(),
            id,
            files,
            ..Default::default()
        }
    }
}

/// Files for a Gutenberg ebook number, using gutenberg.org's stable download URL scheme.
fn pg_files(n: &str) -> Vec<RemoteFile> {
    vec![
        RemoteFile { url: format!("https://www.gutenberg.org/ebooks/{n}.epub3.images"), format: "epub".into(), size: None, label: Some("EPUB3 (with images)".into()) },
        RemoteFile { url: format!("https://www.gutenberg.org/ebooks/{n}.kf8.images"), format: "azw3".into(), size: None, label: Some("Kindle (KF8)".into()) },
        RemoteFile { url: format!("https://www.gutenberg.org/ebooks/{n}.txt.utf-8"), format: "txt".into(), size: None, label: Some("Plain text UTF-8".into()) },
    ]
}

impl Gutenberg {
    /// Fallback when Gutendex is down: Project Gutenberg's own OPDS search.
    pub async fn search_opds(&self, text: &str, page: u32) -> AppResult<SearchPage> {
        let start = (page.max(1) - 1) * 25 + 1;
        let url = reqwest::Url::parse_with_params("https://www.gutenberg.org/ebooks/search.opds/", &[("query", text.to_string()), ("start_index", start.to_string())]).unwrap();
        let xml = self.c.get(url).send().await?.error_for_status()?.text().await?;
        let feed = super::opds::parse_feed(&xml, "https://www.gutenberg.org/", "gutenberg");
        let re = regex::Regex::new(r"/ebooks/(\d+)\.opds").unwrap();
        let mut items = vec![];
        // Book entries are navigation links to /ebooks/<n>.opds; their <content> holds the author line.
        let raw_entries = super::opds::parse_feed(&xml, "https://www.gutenberg.org/", "gutenberg_nav");
        for (title, href) in raw_entries.navigation.iter() {
            let Some(n) = re.captures(href).map(|c| c[1].to_string()) else { continue };
            let author_line = xml.split(&format!("/ebooks/{n}.opds</id>")).nth(1).and_then(|rest| rest.split("<content type=\"text\">").nth(1)).and_then(|c| c.split("</content>").next()).unwrap_or("");
            let authors = if author_line.ends_with("downloads") { vec![] } else {
                author_line.split(" and ").map(|a| AuthorRef { name: a.trim().to_string(), id: None }).filter(|a| !a.name.is_empty()).collect()
            };
            items.push(RemoteBook {
                provider: "gutenberg".into(),
                id: n.clone(),
                title: title.clone(),
                authors,
                cover_url: Some(format!("https://www.gutenberg.org/cache/epub/{n}/pg{n}.cover.medium.jpg")),
                web_url: Some(format!("https://www.gutenberg.org/ebooks/{n}")),
                publisher: Some("Project Gutenberg".into()),
                files: pg_files(&n),
                access: "public".into(),
                ..Default::default()
            });
        }
        let _ = feed;
        Ok(SearchPage { has_more: raw_entries.next.is_some(), items, total: None, page: page.max(1) })
    }

    fn gutendex(&self) -> reqwest::Client {
        reqwest::Client::builder().user_agent("LocalLib (desktop library app)").timeout(std::time::Duration::from_secs(8)).build().unwrap_or_else(|_| self.c.clone())
    }
}

#[async_trait]
impl Provider for Gutenberg {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "gutenberg".into(),
            name: "Project Gutenberg".into(),
            description: "70,000+ free public-domain ebooks (EPUB, Kindle, plain text).".into(),
            search: true,
            fulltext: false,
            authors: true,
            download: true,
            builtin: true,
        }
    }

    async fn search(&self, q: &Query) -> AppResult<SearchPage> {
        let text = [q.text.as_deref(), q.title.as_deref(), q.author.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let mut params: Vec<(&str, String)> = vec![("page", q.page.max(1).to_string())];
        if !text.trim().is_empty() { params.push(("search", text)); }
        if let Some(s) = &q.subject { params.push(("topic", s.clone())); }
        if let Some(l) = &q.language { params.push(("languages", l.chars().take(2).collect())); }
        let url = reqwest::Url::parse_with_params("https://gutendex.com/books/", &params).map_err(|e| AppError::other(e.to_string()))?;
        let j: Value = match get_json_retry(&self.gutendex(), url).await {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[Gutenberg] gutendex unavailable ({e}); using gutenberg.org OPDS");
                let text = [q.text.as_deref(), q.title.as_deref(), q.author.as_deref(), q.subject.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" ");
                return self.search_opds(&text, q.page).await;
            }
        };
        Ok(SearchPage {
            items: j["results"].as_array().into_iter().flatten().map(Self::to_book).collect(),
            total: j["count"].as_u64(),
            page: q.page.max(1),
            has_more: j["next"].is_string(),
        })
    }

    async fn details(&self, id: &str) -> AppResult<RemoteBook> {
        match get_json_retry(&self.gutendex(), reqwest::Url::parse(&format!("https://gutendex.com/books/{id}")).unwrap()).await {
            Ok(j) => Ok(Self::to_book(&j)),
            Err(_) => {
                let xml = self.c.get(format!("https://www.gutenberg.org/ebooks/{id}.opds")).send().await?.error_for_status()?.text().await?;
                let feed = super::opds::parse_feed(&xml, "https://www.gutenberg.org/", "gutenberg");
                let mut b = feed.entries.into_iter().find(|e| !e.files.is_empty()).unwrap_or_default();
                b.provider = "gutenberg".into();
                b.id = id.to_string();
                if b.files.is_empty() { b.files = pg_files(id); }
                b.files.retain(|f| !f.url.ends_with(".zip"));
                b.cover_url.get_or_insert(format!("https://www.gutenberg.org/cache/epub/{id}/pg{id}.cover.medium.jpg"));
                b.web_url = Some(format!("https://www.gutenberg.org/ebooks/{id}"));
                b.access = "public".into();
                Ok(b)
            }
        }
    }

    async fn author(&self, id: &str) -> AppResult<AuthorPage> {
        let page = self.search(&Query { text: Some(id.replace(',', "")), ..Default::default() }).await?;
        let books: Vec<RemoteBook> = page.items.into_iter().filter(|b| b.authors.iter().any(|a| a.id.as_deref() == Some(id))).collect();
        let name = books.first().and_then(|b| b.authors.iter().find(|a| a.id.as_deref() == Some(id))).map(|a| a.name.clone()).unwrap_or_else(|| id.to_string());
        Ok(AuthorPage { id: id.into(), name, books, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gutendex_record() {
        let j: Value = serde_json::json!({
            "id": 1342, "title": "Pride and Prejudice",
            "authors": [{"name": "Austen, Jane"}], "languages": ["en"], "subjects": ["England -- Fiction"],
            "formats": {"application/epub+zip": "https://www.gutenberg.org/ebooks/1342.epub3.images",
                        "text/plain; charset=us-ascii": "https://www.gutenberg.org/ebooks/1342.txt.utf-8",
                        "image/jpeg": "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg",
                        "text/html": "https://www.gutenberg.org/ebooks/1342.html.images"},
            "download_count": 50000
        });
        let b = Gutenberg::to_book(&j);
        assert_eq!(b.authors[0].name, "Jane Austen");
        assert_eq!(b.files[0].format, "epub");
        assert_eq!(b.files.len(), 2);
        assert_eq!(b.access, "public");
    }
}
