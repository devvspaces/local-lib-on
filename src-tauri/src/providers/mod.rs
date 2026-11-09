//! Online book providers. Each provider implements `Provider`; the registry routes calls by id.
//! Adding a provider = one file implementing the trait + one line in `Registry::new`.
pub mod arxiv;
pub mod github;
pub mod gutenberg;
pub mod openlibrary;
pub mod opds;

use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthorRef {
    pub name: String,
    /// Provider-specific author id (for author pages). None when the provider only knows names.
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemoteFile {
    pub url: String,
    pub format: String, // pdf | epub | mobi | txt | ...
    pub size: Option<u64>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemoteBook {
    pub provider: String,
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<AuthorRef>,
    pub year: Option<i64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub cover_url: Option<String>,
    pub subjects: Vec<String>,
    pub isbn: Option<String>,
    pub doi: Option<String>,
    pub web_url: Option<String>,
    /// Downloadable files. May be empty in search results and filled by `details`.
    pub files: Vec<RemoteFile>,
    /// "public" (free download), "borrow" (lending library, open in browser), "none" (metadata only).
    pub access: String,
    pub edition_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Query {
    pub text: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub language: Option<String>,
    /// Only items that can be downloaded.
    pub downloadable: bool,
    pub page: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SearchPage {
    pub items: Vec<RemoteBook>,
    pub total: Option<u64>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthorPage {
    pub id: String,
    pub name: String,
    pub bio: Option<String>,
    pub photo_url: Option<String>,
    pub birth_date: Option<String>,
    pub death_date: Option<String>,
    pub books: Vec<RemoteBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FulltextHit {
    pub book: RemoteBook,
    pub snippets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub search: bool,
    pub fulltext: bool,
    pub authors: bool,
    pub download: bool,
    pub builtin: bool,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn meta(&self) -> ProviderMeta;
    async fn search(&self, q: &Query) -> AppResult<SearchPage>;
    async fn details(&self, id: &str) -> AppResult<RemoteBook>;
    async fn author(&self, _id: &str) -> AppResult<AuthorPage> {
        Err(AppError::Unsupported(format!("{}: author pages", self.meta().name)))
    }
    async fn fulltext(&self, _q: &str, _page: u32) -> AppResult<Vec<FulltextHit>> {
        Err(AppError::Unsupported(format!("{}: full-text search", self.meta().name)))
    }
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("LocalLib/", env!("CARGO_PKG_VERSION"), " (desktop library app)"))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client")
}

/// GET JSON with retry on 429/5xx (public APIs like Gutendex are occasionally overloaded).
pub async fn get_json_retry(c: &reqwest::Client, url: reqwest::Url) -> AppResult<serde_json::Value> {
    let mut delay = 600;
    for attempt in 0..3 {
        let r = c.get(url.clone()).send().await?;
        let st = r.status();
        if st.is_success() {
            return Ok(r.json().await?);
        }
        if attempt < 2 && (st.as_u16() == 429 || st.is_server_error()) {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            delay *= 3;
            continue;
        }
        r.error_for_status()?;
    }
    Err(AppError::other("unreachable"))
}

#[derive(Clone)]
pub struct Registry {
    providers: Arc<std::sync::RwLock<HashMap<String, Arc<dyn Provider>>>>,
}

impl Registry {
    pub fn new(opds_catalogs: Vec<opds::Catalog>) -> Self {
        let client = http();
        let mut m: HashMap<String, Arc<dyn Provider>> = HashMap::new();
        let builtins: Vec<Arc<dyn Provider>> = vec![
            Arc::new(openlibrary::OpenLibrary::new(client.clone())),
            Arc::new(gutenberg::Gutenberg::new(client.clone())),
            Arc::new(arxiv::Arxiv::new(client.clone())),
        ];
        for p in builtins {
            m.insert(p.meta().id, p);
        }
        let reg = Registry { providers: Arc::new(std::sync::RwLock::new(m)) };
        reg.set_opds(opds_catalogs);
        reg
    }

    pub fn set_github(&self, sources: Vec<github::Source>, token: Option<String>) {
        let client = http();
        let mut m = self.providers.write().unwrap();
        m.retain(|k, _| !k.starts_with("github:"));
        for s in sources {
            let p = Arc::new(github::GitHub::new(client.clone(), s, token.clone()));
            m.insert(p.meta().id, p);
        }
    }

    pub fn set_opds(&self, catalogs: Vec<opds::Catalog>) {
        let client = http();
        let mut m = self.providers.write().unwrap();
        m.retain(|k, _| !k.starts_with("opds:"));
        for c in catalogs {
            let p = Arc::new(opds::Opds::new(client.clone(), c));
            m.insert(p.meta().id, p);
        }
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<dyn Provider>> {
        self.providers.read().unwrap().get(id).cloned().ok_or_else(|| AppError::NotFound(format!("provider {id}")))
    }

    pub fn list(&self) -> Vec<ProviderMeta> {
        let mut v: Vec<_> = self.providers.read().unwrap().values().map(|p| p.meta()).collect();
        v.sort_by_key(|m| (!m.builtin, m.name.clone()));
        v
    }
}

/// Map a MIME type or file extension to our format id.
pub fn format_from_mime(mime: &str, url: &str) -> Option<String> {
    let m = mime.split(';').next().unwrap_or("").trim();
    let f = match m {
        "application/pdf" => "pdf",
        "application/epub+zip" => "epub",
        "application/x-mobipocket-ebook" => "mobi",
        "application/vnd.amazon.ebook" | "application/x-mobi8-ebook" => "azw3",
        "application/x-fictionbook+xml" | "application/fb2+zip" => "fb2",
        "application/vnd.comicbook+zip" | "application/x-cbz" => "cbz",
        "text/plain" => "txt",
        _ => {
            let ext = url.split('?').next()?.rsplit('.').next()?.to_ascii_lowercase();
            return match ext.as_str() {
                "pdf" | "epub" | "mobi" | "azw3" | "fb2" | "cbz" | "txt" => Some(ext),
                _ => None,
            };
        }
    };
    Some(f.to_string())
}

/// Live checks against real APIs: `cargo test live_ -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    #[ignore]
    fn live_openlibrary() {
        rt().block_on(async {
            let p = openlibrary::OpenLibrary::new(http());
            let r = p.search(&Query { text: Some("pride and prejudice".into()), downloadable: true, ..Default::default() }).await.unwrap();
            println!("OL: {} results, first={:?} access={}", r.total.unwrap_or(0), r.items[0].title, r.items[0].access);
            let d = p.details(&r.items[0].id).await.unwrap();
            println!("OL details: files={:?}", d.files.iter().map(|f| (&f.format, f.size)).collect::<Vec<_>>());
            let a = p.author(r.items[0].authors[0].id.as_ref().unwrap()).await.unwrap();
            let _ = &a;
            println!("OL author: {} books={}", a.name, a.books.len());
            let ft = p.fulltext("it is a truth universally acknowledged", 1).await.unwrap();
            println!("OL inside: {} hits, first={:?}", ft.len(), ft.first().map(|h| (&h.book.title, h.snippets.first())));
            assert!(!r.items.is_empty());
        });
    }

    #[test]
    #[ignore]
    fn live_github() {
        rt().block_on(async {
            let list = github::GitHub::new(http(), github::Source { id: "fpb".into(), name: "FPB".into(), repo: "EbookFoundation/free-programming-books".into(), branch: None, path: Some("books/free-programming-books-langs.md".into()), kind: "list".into() }, None);
            let r = list.search(&Query { text: Some("rust".into()), ..Default::default() }).await.unwrap();
            println!("GH list: {} rust items, first={:?} {:?} files={}", r.total.unwrap_or(0), r.items[0].title, r.items[0].subjects, r.items[0].files.len());
            let all = list.search(&Query { downloadable: true, ..Default::default() }).await.unwrap();
            println!("GH list: {} direct-download items", all.total.unwrap_or(0));
            assert!(!r.items.is_empty());
        });
    }

    #[test]
    #[ignore]
    fn live_gutenberg_arxiv() {
        rt().block_on(async {
            let g = gutenberg::Gutenberg::new(http());
            let r = g.search(&Query { author: Some("austen".into()), ..Default::default() }).await.unwrap();
            println!("PG: {} results, first={:?} files={:?}", r.items.len(), r.items[0].title, r.items[0].files.iter().map(|f| &f.format).collect::<Vec<_>>());
            let fb = g.search_opds("pride prejudice", 1).await.unwrap();
            println!("PG opds: {} items, first={:?} by {:?}", fb.items.len(), fb.items[0].title, fb.items[0].authors.first().map(|a| &a.name));
            let d = g.details(&fb.items[0].id).await.unwrap();
            println!("PG details: {:?} files={:?}", d.title, d.files.iter().map(|f| &f.format).collect::<Vec<_>>());
            let x = arxiv::Arxiv::new(http());
            let r = x.search(&Query { text: Some("attention is all you need".into()), ..Default::default() }).await.unwrap();
            println!("arXiv: {} results, first={:?} pdf={:?}", r.total.unwrap_or(0), r.items[0].title, r.items[0].files.first().map(|f| &f.url));
            assert!(!r.items.is_empty());
        });
    }
}
