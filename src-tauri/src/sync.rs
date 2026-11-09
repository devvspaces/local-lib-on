//! Provider sync (the coursera-dl-gui idea applied to books): run a saved query against a provider,
//! then diff the results against the local library to list what you don't have yet.
use crate::db::Db;
use crate::error::AppResult;
use crate::providers::{Query, RemoteBook, Registry};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: i64,
    pub name: String,
    pub provider: String,
    pub query: Query,
    pub last_run: Option<String>,
    pub last_result: Option<SyncResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncItem {
    pub book: RemoteBook,
    /// in_library | missing | ignored
    pub status: String,
    pub local_book_id: Option<i64>,
    /// how it matched: provider-id | isbn | doi | title-author
    pub matched_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncResult {
    pub items: Vec<SyncItem>,
    pub missing: usize,
    pub in_library: usize,
    pub ran_at: String,
}

/// Lowercase, strip punctuation/diacritics-ish and leading articles; keep it cheap and predictable.
pub fn norm_title(s: &str) -> String {
    let s = s.split(&[':', '(', '['][..]).next().unwrap_or(s).to_lowercase();
    let s: String = s.chars().map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' }).collect();
    let words: Vec<&str> = s.split_whitespace().collect();
    let words = match words.first() { Some(&"the") | Some(&"a") | Some(&"an") => &words[1..], _ => &words[..] };
    words.join(" ")
}

fn last_name(s: &str) -> String {
    let s = s.trim();
    let n = if s.contains(',') { s.split(',').next().unwrap_or(s) } else { s.split_whitespace().last().unwrap_or(s) };
    n.to_lowercase()
}

struct LocalIndex {
    ids: std::collections::HashMap<(String, String), i64>,
    titles: Vec<(i64, String, Vec<String>)>,
}

fn local_index(c: &Connection) -> AppResult<LocalIndex> {
    let mut ids = std::collections::HashMap::new();
    for row in c.prepare("SELECT scheme, value, book_id FROM identifiers")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
        let (s, v, b) = row?;
        ids.insert((s, v.to_lowercase()), b);
    }
    let mut titles = vec![];
    for row in c.prepare("SELECT id, title, authors FROM books")?.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
        let (id, t, a) = row?;
        let authors: Vec<String> = serde_json::from_str::<Vec<String>>(&a).unwrap_or_default().iter().map(|x| last_name(x)).collect();
        titles.push((id, norm_title(&t), authors));
    }
    Ok(LocalIndex { ids, titles })
}

pub fn match_book(idx: &LocalIndex, b: &RemoteBook) -> Option<(i64, &'static str)> {
    if let Some(id) = idx.ids.get(&(b.provider.clone(), b.id.to_lowercase())) {
        return Some((*id, "provider-id"));
    }
    if let Some(isbn) = &b.isbn {
        let n = crate::library::store::normalize_isbn(isbn).to_lowercase();
        if let Some(id) = idx.ids.get(&("isbn".into(), n)) { return Some((*id, "isbn")); }
    }
    if let Some(doi) = &b.doi {
        if let Some(id) = idx.ids.get(&("doi".into(), doi.to_lowercase())) { return Some((*id, "doi")); }
    }
    let t = norm_title(&b.title);
    if t.len() < 3 {
        return None;
    }
    let ra: Vec<String> = b.authors.iter().map(|a| last_name(&a.name)).collect();
    idx.titles
        .iter()
        .find(|(_, lt, la)| *lt == t && (ra.is_empty() || la.is_empty() || ra.iter().any(|x| la.contains(x))))
        .map(|(id, _, _)| (*id, "title-author"))
}

pub fn diff(c: &Connection, items: Vec<RemoteBook>) -> AppResult<SyncResult> {
    let idx = local_index(c)?;
    let ignored: std::collections::HashSet<(String, String)> = c
        .prepare("SELECT provider, remote_id FROM sync_ignored")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut out = SyncResult { ran_at: chrono::Utc::now().to_rfc3339(), ..Default::default() };
    for b in items {
        let m = match_book(&idx, &b);
        let status = if m.is_some() { "in_library" } else if ignored.contains(&(b.provider.clone(), b.id.clone())) { "ignored" } else { "missing" };
        if status == "missing" { out.missing += 1; } else if status == "in_library" { out.in_library += 1; }
        out.items.push(SyncItem { status: status.into(), local_book_id: m.map(|x| x.0), matched_by: m.map(|x| x.1.to_string()), book: b });
    }
    Ok(out)
}

/// Run a saved query: fetch up to `max_pages` pages so "everything by this author" really means everything.
pub async fn run(db: &Db, reg: &Registry, id: i64, max_pages: u32) -> AppResult<SyncResult> {
    let (provider, query): (String, String) = db.with(|c| Ok(c.query_row("SELECT provider, query FROM saved_queries WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))?))?;
    let mut q: Query = serde_json::from_str(&query)?;
    let p = reg.get(&provider)?;
    let mut items = vec![];
    for page in 1..=max_pages.max(1) {
        q.page = page;
        let res = p.search(&q).await?;
        let more = res.has_more;
        items.extend(res.items);
        if !more { break; }
    }
    // De-duplicate by provider id.
    let mut seen = std::collections::HashSet::new();
    items.retain(|b| seen.insert(b.id.clone()));
    let result = db.with(|c| diff(c, items))?;
    db.with(|c| {
        c.execute("UPDATE saved_queries SET last_run = ?, last_result = ? WHERE id = ?", params![result.ran_at, serde_json::to_string(&result)?, id])?;
        Ok(())
    })?;
    Ok(result)
}

pub fn list(db: &Db) -> AppResult<Vec<SavedQuery>> {
    db.with(|c| {
        Ok(c.prepare("SELECT id, name, provider, query, last_run, last_result FROM saved_queries ORDER BY name COLLATE NOCASE")?
            .query_map([], |r| {
                let q: String = r.get(3)?;
                let lr: Option<String> = r.get(5)?;
                Ok(SavedQuery { id: r.get(0)?, name: r.get(1)?, provider: r.get(2)?, query: serde_json::from_str(&q).unwrap_or_default(), last_run: r.get(4)?, last_result: lr.and_then(|s| serde_json::from_str(&s).ok()) })
            })?
            .collect::<Result<_, _>>()?)
    })
}

pub fn save(db: &Db, id: Option<i64>, name: &str, provider: &str, q: &Query) -> AppResult<i64> {
    let json = serde_json::to_string(q)?;
    db.with(|c| match id {
        Some(id) => { c.execute("UPDATE saved_queries SET name=?, provider=?, query=? WHERE id=?", params![name, provider, json, id])?; Ok(id) }
        None => { c.execute("INSERT INTO saved_queries (name, provider, query) VALUES (?, ?, ?)", params![name, provider, json])?; Ok(c.last_insert_rowid()) }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::AuthorRef;

    #[test]
    fn diff_matches_by_identifier_and_title() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = crate::library::store::insert_book(c, "The Pragmatic Programmer: 20th Anniversary", &["David Thomas".into(), "Andrew Hunt".into()], None)?;
            let b = crate::library::store::insert_book(c, "Whatever", &[], None)?;
            crate::library::store::add_identifier(c, b, "gutenberg", "84")?;
            let remote = |id: &str, title: &str, author: &str| RemoteBook { provider: "gutenberg".into(), id: id.into(), title: title.into(), authors: vec![AuthorRef { name: author.into(), id: None }], ..Default::default() };
            let r = diff(c, vec![
                remote("84", "Frankenstein", "Mary Shelley"),
                remote("1", "Pragmatic Programmer", "Andy Hunt"),
                remote("2", "Dracula", "Bram Stoker"),
            ])?;
            assert_eq!(r.items[0].matched_by.as_deref(), Some("provider-id"));
            assert_eq!(r.items[1].local_book_id, Some(a));
            assert_eq!(r.items[2].status, "missing");
            assert_eq!((r.missing, r.in_library), (1, 2));
            Ok(())
        }).unwrap();
    }

    #[test]
    fn title_normalization() {
        assert_eq!(norm_title("The Art of Computer Programming, Vol. 1: Fundamental Algorithms"), "art of computer programming vol 1");
    }
}
