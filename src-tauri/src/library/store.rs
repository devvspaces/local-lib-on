//! SQL queries for books, collections, tags and saved searches.
use super::models::*;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension, Row};

fn book_from_row(r: &Row) -> rusqlite::Result<Book> {
    let authors: String = r.get("authors")?;
    Ok(Book {
        id: r.get("id")?,
        title: r.get("title")?,
        subtitle: r.get("subtitle")?,
        authors: serde_json::from_str(&authors).unwrap_or_default(),
        year: r.get("year")?,
        language: r.get("language")?,
        publisher: r.get("publisher")?,
        isbn: r.get("isbn")?,
        doi: r.get("doi")?,
        series: r.get("series")?,
        series_index: r.get("series_index")?,
        description: r.get("description")?,
        edition: r.get("edition")?,
        place: r.get("place")?,
        num_pages: r.get("num_pages")?,
        item_type: r.get("item_type")?,
        short_title: r.get("short_title")?,
        metadata_source: r.get("metadata_source")?,
        cover_path: r.get("cover_path")?,
        rating: r.get("rating")?,
        status: r.get("status")?,
        favorite: r.get::<_, i64>("favorite")? != 0,
        added_at: r.get("added_at")?,
        last_opened_at: r.get("last_opened_at")?,
        percent: r.get::<_, Option<f64>>("percent")?.unwrap_or(0.0),
        enriched: r.get::<_, i64>("enriched")? != 0,
        ..Default::default()
    })
}

const BOOK_SELECT: &str = "SELECT b.*, COALESCE(p.percent, 0) AS percent,
    EXISTS(SELECT 1 FROM kv WHERE kv.key = 'enriched:' || b.id) AS enriched
  FROM books b LEFT JOIN progress p ON p.book_id = b.id";

fn hydrate(conn: &Connection, books: &mut [Book]) -> AppResult<()> {
    let mut files = conn.prepare_cached("SELECT id, path, format, size, missing FROM files WHERE book_id = ? ORDER BY id")?;
    let mut tags = conn.prepare_cached("SELECT t.id, t.name, t.color FROM tags t JOIN book_tags bt ON bt.tag_id = t.id WHERE bt.book_id = ? ORDER BY t.name")?;
    let mut cols = conn.prepare_cached("SELECT collection_id FROM book_collections WHERE book_id = ?")?;
    let mut ids = conn.prepare_cached("SELECT scheme, value FROM identifiers WHERE book_id = ?")?;
    for b in books.iter_mut() {
        b.files = files
            .query_map([b.id], |r| {
                Ok(BookFile { id: r.get(0)?, path: r.get(1)?, format: r.get(2)?, size: r.get(3)?, missing: r.get::<_, i64>(4)? != 0 })
            })?
            .collect::<Result<_, _>>()?;
        b.tags = tags
            .query_map([b.id], |r| Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        b.collection_ids = cols.query_map([b.id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        b.identifiers = ids
            .query_map([b.id], |r| Ok(Identifier { scheme: r.get(0)?, value: r.get(1)? }))?
            .collect::<Result<_, _>>()?;
    }
    Ok(())
}

pub fn list_books(conn: &Connection, f: &LibraryFilter) -> AppResult<Vec<Book>> {
    let mut sql = format!("{BOOK_SELECT} WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(t) = f.text.as_ref().filter(|t| !t.trim().is_empty()) {
        let like = format!("%{}%", t.trim());
        sql += " AND (b.title LIKE ? OR b.authors LIKE ? OR b.series LIKE ? OR b.isbn LIKE ? OR b.doi LIKE ?
                 OR EXISTS(SELECT 1 FROM files f WHERE f.book_id = b.id AND f.path LIKE ?))";
        for _ in 0..6 {
            args.push(Box::new(like.clone()));
        }
    }
    if let Some(c) = f.collection_id {
        // include sub-collections
        sql += " AND b.id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id)
                 SELECT book_id FROM book_collections WHERE collection_id IN sub)";
        args.push(Box::new(c));
    }
    for t in &f.tag_ids {
        sql += " AND EXISTS(SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = ?)";
        args.push(Box::new(*t));
    }
    if !f.formats.is_empty() {
        sql += &format!(
            " AND EXISTS(SELECT 1 FROM files f WHERE f.book_id = b.id AND f.format IN ({}))",
            vec!["?"; f.formats.len()].join(",")
        );
        for x in &f.formats {
            args.push(Box::new(x.clone()));
        }
    }
    if let Some(s) = &f.status {
        sql += " AND b.status = ?";
        args.push(Box::new(s.clone()));
    }
    if let Some(fav) = f.favorite {
        sql += " AND b.favorite = ?";
        args.push(Box::new(fav as i64));
    }
    if let Some(a) = &f.author {
        sql += " AND EXISTS(SELECT 1 FROM json_each(b.authors) WHERE json_each.value = ?)";
        args.push(Box::new(a.clone()));
    }
    if let Some(m) = f.missing {
        let op = if m { "" } else { "NOT " };
        sql += &format!(" AND {op}EXISTS(SELECT 1 FROM files f WHERE f.book_id = b.id AND f.missing = 1)");
    }
    let col = match f.sort.as_deref() {
        Some("title") => "b.title COLLATE NOCASE",
        Some("author") => "json_extract(b.authors, '$[0]') COLLATE NOCASE",
        Some("year") => "b.year",
        Some("opened") => "b.last_opened_at",
        Some("progress") => "percent",
        _ => "b.added_at",
    };
    let desc = f.desc.unwrap_or(!matches!(f.sort.as_deref(), Some("title") | Some("author")));
    sql += &format!(" ORDER BY {col} {} NULLS LAST, b.id DESC", if desc { "DESC" } else { "ASC" });

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let mut books: Vec<Book> = stmt.query_map(refs.as_slice(), book_from_row)?.collect::<Result<_, _>>()?;
    hydrate(conn, &mut books)?;
    Ok(books)
}

pub fn get_book(conn: &Connection, id: i64) -> AppResult<Book> {
    let mut b = conn
        .query_row(&format!("{BOOK_SELECT} WHERE b.id = ?"), [id], book_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("book {id}")))?;
    hydrate(conn, std::slice::from_mut(&mut b))?;
    Ok(b)
}

pub fn insert_book(
    conn: &Connection,
    title: &str,
    authors: &[String],
    year: Option<i64>,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO books (title, authors, year) VALUES (?, ?, ?)",
        params![title, serde_json::to_string(authors)?, year],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_book(conn: &Connection, id: i64, p: &BookPatch) -> AppResult<()> {
    let cur = get_book(conn, id)?;
    let enriched: bool = cur.enriched;
    // When auto-enriching, a field is replaceable if empty, or (for title/authors) if it
    // still holds the filename guess, i.e. the book was never enriched before.
    let take_s = |new: &Option<String>, old: &Option<String>| -> Option<String> {
        match new.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            Some(n) if !p.only_missing || old.as_deref().map_or(true, |o| o.trim().is_empty()) => Some(n.to_string()),
            _ => old.clone(),
        }
    };
    let title = match p.title.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(t) if !p.only_missing || !enriched => t.to_string(),
        _ => cur.title.clone(),
    };
    let authors = match &p.authors {
        Some(a) if !a.is_empty() && (!p.only_missing || !enriched || cur.authors.is_empty()) => a.clone(),
        _ => cur.authors.clone(),
    };
    let year = match p.year {
        Some(y) if !p.only_missing || cur.year.is_none() => Some(y),
        _ => cur.year,
    };
    let series_index = p.series_index.or(cur.series_index);
    let num_pages = match p.num_pages { Some(n) if !p.only_missing || cur.num_pages.is_none() => Some(n), _ => cur.num_pages };
    let item_type = match &p.item_type { Some(t) if !p.only_missing || cur.item_type == "book" => t.clone(), _ => cur.item_type.clone() };
    conn.execute(
        "UPDATE books SET title=?, subtitle=?, authors=?, year=?, language=?, publisher=?, isbn=?, doi=?, series=?,
           series_index=?, description=?, rating=?, status=?, favorite=?,
           edition=?, place=?, num_pages=?, item_type=?, short_title=?, metadata_source=?,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?",
        params![
            title,
            take_s(&p.subtitle, &cur.subtitle),
            serde_json::to_string(&authors)?,
            year,
            take_s(&p.language, &cur.language),
            take_s(&p.publisher, &cur.publisher),
            take_s(&p.isbn, &cur.isbn),
            take_s(&p.doi, &cur.doi),
            take_s(&p.series, &cur.series),
            series_index,
            take_s(&p.description, &cur.description),
            if p.only_missing { cur.rating } else { p.rating.or(cur.rating) },
            p.status.clone().unwrap_or(cur.status),
            p.favorite.unwrap_or(cur.favorite) as i64,
            take_s(&p.edition, &cur.edition),
            take_s(&p.place, &cur.place),
            num_pages,
            item_type,
            take_s(&p.short_title, &cur.short_title),
            p.metadata_source.clone().or(cur.metadata_source.clone()),
            id
        ],
    )?;
    if let Some(isbn) = p.isbn.as_ref().filter(|s| !s.is_empty()) {
        add_identifier(conn, id, "isbn", &normalize_isbn(isbn))?;
    }
    for isbn in p.isbns.iter().flatten().filter(|s| !s.is_empty()) {
        add_identifier(conn, id, "isbn", &normalize_isbn(isbn))?;
    }
    if let Some(doi) = p.doi.as_ref().filter(|s| !s.is_empty()) {
        add_identifier(conn, id, "doi", &doi.to_lowercase())?;
    }
    if p.only_missing {
        conn.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('enriched:' || ?, '1')", [id])?;
    }
    Ok(())
}

pub fn normalize_isbn(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x').collect::<String>().to_uppercase()
}

pub fn add_identifier(conn: &Connection, book_id: i64, scheme: &str, value: &str) -> AppResult<()> {
    conn.execute("INSERT OR IGNORE INTO identifiers (book_id, scheme, value) VALUES (?, ?, ?)", params![book_id, scheme, value])?;
    Ok(())
}

/// Move everything attached to book `from` onto `into`, then delete `from`. Rows that would collide with one
/// `into` already has (same tag, same progress row, …) are dropped in favour of `into`'s.
pub fn merge_book(conn: &Connection, from: i64, into: i64) -> AppResult<()> {
    if from == into { return Ok(()); }
    for t in ["files", "identifiers", "book_collections", "book_tags", "reading_sessions", "annotations", "bookmarks", "notes", "cards", "schedules", "summaries", "progress"] {
        conn.execute(&format!("UPDATE OR IGNORE {t} SET book_id = ?1 WHERE book_id = ?2"), params![into, from])?;
    }
    // Keep the user's status / favourite / rating from the reference entry when the new one has defaults.
    conn.execute(
        "UPDATE books SET
           status = CASE WHEN status = 'unread' THEN (SELECT status FROM books WHERE id = ?2) ELSE status END,
           favorite = MAX(favorite, (SELECT favorite FROM books WHERE id = ?2)),
           rating = COALESCE(rating, (SELECT rating FROM books WHERE id = ?2))
         WHERE id = ?1",
        params![into, from],
    )?;
    conn.execute("DELETE FROM books WHERE id = ?", [from])?;
    Ok(())
}

/// A "Save reference" entry (no file) and a later download of the same remote item end up as two books sharing
/// a provider identifier. Fold each file-less one into its twin that has the file. Returns how many were merged.
pub fn merge_reference_duplicates(conn: &Connection) -> AppResult<usize> {
    let pairs: Vec<(i64, i64)> = conn.prepare(
        "SELECT r.book_id, MIN(d.book_id) FROM identifiers r
         JOIN identifiers d ON d.scheme = r.scheme AND d.value = r.value AND d.book_id <> r.book_id
         WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.book_id = r.book_id)
           AND EXISTS (SELECT 1 FROM files f WHERE f.book_id = d.book_id)
         GROUP BY r.book_id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (from, into) in &pairs { merge_book(conn, *from, *into)?; }
    Ok(pairs.len())
}

pub fn set_cover(conn: &Connection, id: i64, path: &str) -> AppResult<()> {
    conn.execute("UPDATE books SET cover_path = ? WHERE id = ?", params![path, id])?;
    Ok(())
}

pub fn touch_opened(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE books SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           status = CASE WHEN status = 'unread' THEN 'reading' ELSE status END WHERE id = ?",
        [id],
    )?;
    Ok(())
}

pub fn delete_book(conn: &Connection, id: i64) -> AppResult<Vec<String>> {
    let paths: Vec<String> = conn
        .prepare("SELECT path FROM files WHERE book_id = ?")?
        .query_map([id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    conn.execute("DELETE FROM fts_pages WHERE book_id = ?", [id])?;
    conn.execute("DELETE FROM books WHERE id = ?", [id])?;
    Ok(paths)
}

// ── Collections ────────────────────────────────────────────

pub fn list_collections(conn: &Connection) -> AppResult<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.parent_id, c.name, (SELECT count(*) FROM book_collections bc WHERE bc.collection_id = c.id)
         FROM collections c ORDER BY c.sort, c.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| Ok(Collection { id: r.get(0)?, parent_id: r.get(1)?, name: r.get(2)?, count: r.get(3)? }))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn create_collection(conn: &Connection, name: &str, parent_id: Option<i64>) -> AppResult<i64> {
    conn.execute("INSERT INTO collections (name, parent_id) VALUES (?, ?)", params![name, parent_id])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_collection(conn: &Connection, id: i64, name: &str) -> AppResult<()> {
    conn.execute("UPDATE collections SET name = ? WHERE id = ?", params![name, id])?;
    Ok(())
}

pub fn move_collection(conn: &Connection, id: i64, parent_id: Option<i64>) -> AppResult<()> {
    // refuse cycles
    if let Some(p) = parent_id {
        let cyc: bool = conn.query_row(
            "WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id)
             SELECT EXISTS(SELECT 1 FROM sub WHERE id = ?)",
            params![id, p],
            |r| r.get(0),
        )?;
        if cyc {
            return Err(AppError::other("cannot move a collection into itself"));
        }
    }
    conn.execute("UPDATE collections SET parent_id = ? WHERE id = ?", params![parent_id, id])?;
    Ok(())
}

pub fn delete_collection(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM collections WHERE id = ?", [id])?;
    Ok(())
}

pub fn set_book_collection(conn: &Connection, book_ids: &[i64], collection_id: i64, member: bool) -> AppResult<()> {
    for b in book_ids {
        if member {
            conn.execute("INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)", params![b, collection_id])?;
        } else {
            conn.execute("DELETE FROM book_collections WHERE book_id = ? AND collection_id = ?", params![b, collection_id])?;
        }
    }
    Ok(())
}

// ── Tags ───────────────────────────────────────────────────

pub fn list_tags(conn: &Connection) -> AppResult<Vec<(Tag, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, (SELECT count(*) FROM book_tags bt WHERE bt.tag_id = t.id) FROM tags t ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? }, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn upsert_tag(conn: &Connection, name: &str, color: Option<&str>) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET color = COALESCE(excluded.color, tags.color)",
        params![name.trim(), color],
    )?;
    Ok(conn.query_row("SELECT id FROM tags WHERE name = ?", [name.trim()], |r| r.get(0))?)
}

pub fn update_tag(conn: &Connection, id: i64, name: &str, color: Option<&str>) -> AppResult<()> {
    conn.execute("UPDATE tags SET name = ?, color = ? WHERE id = ?", params![name, color, id])?;
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM tags WHERE id = ?", [id])?;
    Ok(())
}

pub fn set_book_tag(conn: &Connection, book_ids: &[i64], tag_id: i64, on: bool) -> AppResult<()> {
    for b in book_ids {
        if on {
            conn.execute("INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)", params![b, tag_id])?;
        } else {
            conn.execute("DELETE FROM book_tags WHERE book_id = ? AND tag_id = ?", params![b, tag_id])?;
        }
    }
    Ok(())
}

// ── Saved searches ─────────────────────────────────────────

pub fn list_saved_searches(conn: &Connection) -> AppResult<Vec<SavedSearch>> {
    let mut stmt = conn.prepare("SELECT id, name, filter FROM saved_searches ORDER BY name COLLATE NOCASE")?;
    let rows = stmt
        .query_map([], |r| {
            let f: String = r.get(2)?;
            Ok(SavedSearch { id: r.get(0)?, name: r.get(1)?, filter: serde_json::from_str(&f).unwrap_or_default() })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn save_search(conn: &Connection, id: Option<i64>, name: &str, filter: &LibraryFilter) -> AppResult<i64> {
    let json = serde_json::to_string(filter)?;
    match id {
        Some(id) => {
            conn.execute("UPDATE saved_searches SET name = ?, filter = ? WHERE id = ?", params![name, json, id])?;
            Ok(id)
        }
        None => {
            conn.execute("INSERT INTO saved_searches (name, filter) VALUES (?, ?)", params![name, json])?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn delete_saved_search(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM saved_searches WHERE id = ?", [id])?;
    Ok(())
}

pub fn list_authors(conn: &Connection) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT j.value, count(*) FROM books b, json_each(b.authors) j GROUP BY j.value ORDER BY j.value COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Books whose metadata/cover haven't been extracted yet and whose file is present.
pub fn unenriched(conn: &Connection) -> AppResult<Vec<i64>> {
    Ok(conn
        .prepare(
            "SELECT b.id FROM books b WHERE NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'enriched:' || b.id)
               AND EXISTS (SELECT 1 FROM files f WHERE f.book_id = b.id AND f.missing = 0) ORDER BY b.id",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?)
}

pub fn reset_enriched(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    for id in ids {
        conn.execute("DELETE FROM kv WHERE key = 'enriched:' || ?", [id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_entry_merges_into_download() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.with(|c| {
            let r = insert_book(c, "Ansible for DevOps", &["Jeff Geerling".into()], None)?;
            add_identifier(c, r, "github", "geerlingguy/ansible-for-devops:book.pdf")?;
            c.execute("UPDATE books SET favorite = 1 WHERE id = ?", [r])?;
            c.execute("INSERT INTO annotations (id, book_id, kind, anchor) VALUES ('a1', ?, 'highlight', '{}')", [r])?;
            let d = insert_book(c, "ansible-for-devops", &[], None)?;
            c.execute("INSERT INTO files (book_id, path, format, size, hash) VALUES (?, '/tmp/x.pdf', 'pdf', 1, 'h')", [d])?;
            add_identifier(c, d, "github", "geerlingguy/ansible-for-devops:book.pdf")?;
            assert_eq!(merge_reference_duplicates(c)?, 1);
            let books: i64 = c.query_row("SELECT COUNT(*) FROM books", [], |x| x.get(0))?;
            let ann: i64 = c.query_row("SELECT book_id FROM annotations WHERE id = 'a1'", [], |x| x.get(0))?;
            let fav: i64 = c.query_row("SELECT favorite FROM books WHERE id = ?", [d], |x| x.get(0))?;
            assert_eq!((books, ann, fav), (1, d, 1));
            assert_eq!(merge_reference_duplicates(c)?, 0, "idempotent");
            Ok(())
        }).unwrap();
    }
}
