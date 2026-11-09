//! GitHub sources:
//!   - `repo`: a repository that contains book files (PDF/EPUB/…), listed via the git trees API.
//!   - `list`: an awesome-list markdown file (e.g. free-programming-books); links are parsed with their headings.
use super::*;
use crate::library::formats::{format_for, guess_from_filename};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    /// "owner/repo"
    pub repo: String,
    #[serde(default)]
    pub branch: Option<String>,
    /// repo: folder prefix to restrict to · list: path of the markdown file (default README.md)
    #[serde(default)]
    pub path: Option<String>,
    pub kind: String, // repo | list
}

pub struct GitHub {
    c: reqwest::Client,
    src: Source,
    token: Option<String>,
    cache: Mutex<Option<(Instant, Vec<RemoteBook>)>>,
}

#[derive(Deserialize)]
struct TreeItem {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    size: Option<u64>,
}

pub fn books_from_tree(src: &Source, branch: &str, tree: &[(String, String, Option<u64>)]) -> Vec<RemoteBook> {
    let prefix = src.path.as_deref().unwrap_or("").trim_matches('/');
    tree.iter()
        .filter(|(p, k, _)| k == "blob" && (prefix.is_empty() || p.starts_with(prefix)))
        .filter_map(|(p, _, size)| {
            let path = Path::new(p);
            let format = format_for(path)?;
            if matches!(format, "md" | "txt") {
                return None; // READMEs, licenses…
            }
            let g = guess_from_filename(path);
            let folder: Vec<String> = path.parent().map(|d| d.iter().map(|s| s.to_string_lossy().to_string()).collect()).unwrap_or_default();
            let enc = p.split('/').map(|s| urlencoding::encode(s).to_string()).collect::<Vec<_>>().join("/");
            Some(RemoteBook {
                provider: format!("github:{}", src.id),
                id: p.clone(),
                title: g.title,
                authors: g.authors.into_iter().map(|n| AuthorRef { name: n, id: None }).collect(),
                year: g.year,
                subjects: folder,
                web_url: Some(format!("https://github.com/{}/blob/{branch}/{enc}", src.repo)),
                files: vec![RemoteFile {
                    url: format!("https://raw.githubusercontent.com/{}/{branch}/{enc}", src.repo),
                    format: format.to_string(),
                    size: *size,
                    label: Some(p.clone()),
                }],
                access: "public".into(),
                publisher: Some(src.repo.clone()),
                ..Default::default()
            })
        })
        .collect()
}

/// Parse markdown links under their heading path. Direct book-file links are downloadable.
pub fn books_from_markdown(src: &Source, md: &str) -> Vec<RemoteBook> {
    let link = regex::Regex::new(r"\[([^\]]+)\]\((https?://[^)\s]+)\)").unwrap();
    let mut heads: Vec<(usize, String)> = vec![];
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for line in md.lines() {
        let t = line.trim_start();
        if let Some(h) = t.strip_prefix('#') {
            let level = 1 + h.chars().take_while(|c| *c == '#').count();
            let text = h.trim_start_matches('#').trim().replace(['[', ']'], "");
            heads.retain(|(l, _)| *l < level);
            heads.push((level, text));
            continue;
        }
        if !(t.starts_with("* ") || t.starts_with("- ") || t.starts_with("+ ")) {
            continue;
        }
        let Some(c) = link.captures(t) else { continue };
        let (title, url) = (c[1].trim().to_string(), c[2].to_string());
        if !seen.insert(url.clone()) {
            continue;
        }
        // "- [Title](url) - Author Name (PDF)" style annotations after the link.
        let rest = t[c.get(0).unwrap().end()..].trim();
        let author = rest.trim_start_matches(['-', '–', '—', ' ']).split(['(', '[']).next().unwrap_or("").trim();
        let fmt = format_for(Path::new(url.split(['?', '#']).next().unwrap_or(&url))).filter(|f| !matches!(*f, "md" | "txt"));
        let tag_fmt = regex::Regex::new(r"\((PDF|EPUB|MOBI)\b").unwrap().captures(rest).map(|m| m[1].to_lowercase());
        out.push(RemoteBook {
            provider: format!("github:{}", src.id),
            id: url.clone(),
            title,
            authors: if author.is_empty() || author.len() > 80 { vec![] } else { author.split(',').map(|a| AuthorRef { name: a.trim().into(), id: None }).collect() },
            subjects: heads.iter().map(|(_, h)| h.clone()).filter(|h| !h.is_empty()).collect(),
            description: tag_fmt.as_ref().map(|f| format!("Listed as {}", f.to_uppercase())),
            web_url: Some(url.clone()),
            files: fmt.map(|f| vec![RemoteFile { url: url.clone(), format: f.into(), size: None, label: None }]).unwrap_or_default(),
            access: if fmt.is_some() { "public".into() } else { "none".into() },
            publisher: Some(src.repo.clone()),
            ..Default::default()
        });
    }
    out
}

impl GitHub {
    pub fn new(c: reqwest::Client, src: Source, token: Option<String>) -> Self {
        Self { c, src, token, cache: Mutex::new(None) }
    }

    fn req(&self, url: &str) -> reqwest::RequestBuilder {
        let mut r = self.c.get(url).header("Accept", "application/vnd.github+json");
        if let Some(t) = self.token.as_ref().filter(|t| !t.is_empty()) {
            r = r.bearer_auth(t);
        }
        r
    }

    async fn branch(&self) -> AppResult<String> {
        if let Some(b) = self.src.branch.as_ref().filter(|b| !b.is_empty()) {
            return Ok(b.clone());
        }
        let j: serde_json::Value = self.req(&format!("https://api.github.com/repos/{}", self.src.repo)).send().await?.error_for_status()?.json().await?;
        Ok(j["default_branch"].as_str().unwrap_or("main").to_string())
    }

    async fn all(&self) -> AppResult<Vec<RemoteBook>> {
        let mut c = self.cache.lock().await;
        if let Some((t, items)) = c.as_ref() {
            if t.elapsed() < Duration::from_secs(600) {
                return Ok(items.clone());
            }
        }
        let branch = self.branch().await?;
        let items = if self.src.kind == "list" {
            let path = self.src.path.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "README.md".into());
            let url = format!("https://raw.githubusercontent.com/{}/{branch}/{}", self.src.repo, path.trim_start_matches('/'));
            let md = self.c.get(url).send().await?.error_for_status()?.text().await?;
            books_from_markdown(&self.src, &md)
        } else {
            let j: serde_json::Value = self.req(&format!("https://api.github.com/repos/{}/git/trees/{branch}?recursive=1", self.src.repo)).send().await?.error_for_status()?.json().await?;
            let tree: Vec<TreeItem> = serde_json::from_value(j["tree"].clone()).unwrap_or_default();
            let t: Vec<(String, String, Option<u64>)> = tree.into_iter().map(|i| (i.path, i.kind, i.size)).collect();
            books_from_tree(&self.src, &branch, &t)
        };
        *c = Some((Instant::now(), items.clone()));
        Ok(items)
    }
}

#[async_trait]
impl Provider for GitHub {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: format!("github:{}", self.src.id),
            name: self.src.name.clone(),
            description: format!("GitHub {} · {}", if self.src.kind == "list" { "reading list" } else { "repository" }, self.src.repo),
            search: true,
            fulltext: false,
            authors: false,
            download: true,
            builtin: false,
        }
    }

    async fn search(&self, q: &Query) -> AppResult<SearchPage> {
        let all = self.all().await?;
        let terms: Vec<String> = [q.text.as_deref(), q.title.as_deref(), q.author.as_deref(), q.subject.as_deref()]
            .into_iter().flatten().flat_map(|s| s.split_whitespace()).map(|s| s.to_lowercase()).collect();
        let matched: Vec<RemoteBook> = all
            .into_iter()
            .filter(|b| !q.downloadable || b.access == "public")
            .filter(|b| {
                if terms.is_empty() { return true; }
                let hay = format!("{} {} {} {}", b.title, b.id, b.subjects.join(" "), b.authors.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(" ")).to_lowercase();
                let words: Vec<&str> = hay.split(|c: char| !c.is_alphanumeric() && c != '+' && c != '#').filter(|w| !w.is_empty()).collect();
                terms.iter().all(|t| words.iter().any(|w| w.starts_with(t.as_str())))
            })
            .collect();
        // Rank: exact word in headings/title first, then prefix matches, then author-only matches.
        let score = |b: &RemoteBook| -> i32 {
            let words = |s: &str| s.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '+' && c != '#').filter(|w| !w.is_empty()).map(String::from).collect::<Vec<_>>();
            let (subj, title) = (words(&b.subjects.join(" ")), words(&b.title));
            terms.iter().map(|t| {
                if subj.iter().any(|w| w == t) { 4 } else if title.iter().any(|w| w == t) { 3 } else if title.iter().any(|w| w.starts_with(t.as_str())) { 2 } else { 0 }
            }).sum()
        };
        let mut matched = matched;
        matched.sort_by_key(|b| -score(b));
        let per = 60usize;
        let page = q.page.max(1) as usize;
        let total = matched.len();
        let items = matched.into_iter().skip((page - 1) * per).take(per).collect();
        Ok(SearchPage { items, total: Some(total as u64), page: page as u32, has_more: page * per < total })
    }

    async fn details(&self, id: &str) -> AppResult<RemoteBook> {
        self.all().await?.into_iter().find(|b| b.id == id).ok_or_else(|| AppError::NotFound(id.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(kind: &str) -> Source {
        Source { id: "t".into(), name: "T".into(), repo: "o/r".into(), branch: None, path: None, kind: kind.into() }
    }

    #[test]
    fn tree_filters_books() {
        let t = vec![
            ("README.md".into(), "blob".into(), Some(10)),
            ("algorithms/Jane Doe - Graphs (2020).pdf".into(), "blob".into(), Some(1000)),
            ("algorithms".into(), "tree".into(), None),
            ("novels/x.epub".into(), "blob".into(), Some(5)),
        ];
        let b = books_from_tree(&src("repo"), "main", &t);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].title, "Graphs");
        assert_eq!(b[0].subjects, vec!["algorithms"]);
        assert_eq!(b[0].files[0].url, "https://raw.githubusercontent.com/o/r/main/algorithms/Jane%20Doe%20-%20Graphs%20%282020%29.pdf");
    }

    #[test]
    fn markdown_lists() {
        let md = "# Books\n## Go\n* [An Introduction to Programming in Go](http://www.golang-book.com) - Caleb Doxsey\n* [Go Book](https://example.org/go.pdf) - A. Writer (PDF)\n### Web\n- [Web Dev](https://x.org/web.epub)\nNot a list [x](https://y.org)\n";
        let b = books_from_markdown(&src("list"), md);
        assert_eq!(b.len(), 3);
        assert_eq!(b[0].access, "none");
        assert_eq!(b[0].authors[0].name, "Caleb Doxsey");
        assert_eq!(b[1].files[0].format, "pdf");
        assert_eq!(b[2].subjects, vec!["Books", "Go", "Web"]);
    }
}
