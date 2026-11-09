//! Multi-device sync through a shared folder or WebDAV.
//! Each device writes its full synced state to `sync/devices/<device_id>/state.json` and merges the others'
//! with last-writer-wins on `updated_at`, plus tombstones for deletions. Rows use global keys (book uid,
//! annotation/note/card uuids, collection uid, tag name) — never local integer ids or file paths.
use crate::db::Db;
use crate::error::AppResult;
use crate::storage::{Store, Target};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct State {
    pub device_id: String,
    pub device_name: String,
    pub exported_at: String,
    pub books: Vec<Value>,
    pub collections: Vec<Value>,
    pub annotations: Vec<Value>,
    pub bookmarks: Vec<Value>,
    pub notes: Vec<Value>,
    pub progress: Vec<Value>,
    pub cards: Vec<Value>,
    pub reviews: Vec<Value>,
    pub tombstones: Vec<Value>,
    #[serde(default)]
    pub plans: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct SyncReport {
    pub pulled_devices: usize,
    pub applied: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub files_up: usize,
    pub files_down: usize,
    pub at: String,
    pub error: Option<String>,
}

fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }

pub fn device_id(c: &Connection) -> AppResult<String> {
    if let Some(id) = c.query_row("SELECT value FROM kv WHERE key = 'device_id'", [], |r| r.get::<_, String>(0)).optional()? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    c.execute("INSERT INTO kv (key, value) VALUES ('device_id', ?)", [&id])?;
    Ok(id)
}

/// Rows of an arbitrary SELECT as JSON objects (column name → value).
fn rows(c: &Connection, sql: &str) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(sql)?;
    let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let out = st
        .query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, n) in names.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(x) => Value::from(x),
                    rusqlite::types::ValueRef::Real(x) => Value::from(x),
                    rusqlite::types::ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).to_string()),
                    rusqlite::types::ValueRef::Blob(_) => Value::Null,
                };
                m.insert(n.clone(), v);
            }
            Ok(Value::Object(m))
        })?
        .collect::<Result<_, _>>()?;
    Ok(out)
}

pub fn export(c: &Connection, device_name: &str) -> AppResult<State> {
    let books = rows(c, "SELECT b.uid, b.title, b.subtitle, b.authors, b.year, b.language, b.publisher, b.isbn, b.doi, b.series, b.series_index,
        b.description, b.edition, b.place, b.num_pages, b.item_type, b.short_title, b.metadata_source, b.rating, b.status, b.favorite, b.added_at, b.updated_at,
        (SELECT json_group_array(json_object('hash', f.hash, 'format', f.format, 'name', replace(f.path, rtrim(f.path, replace(f.path, '/', '')), ''), 'size', f.size)) FROM files f WHERE f.book_id = b.id AND f.hash IS NOT NULL) AS files,
        (SELECT json_group_array(json_object('name', t.name, 'color', t.color)) FROM tags t JOIN book_tags bt ON bt.tag_id = t.id WHERE bt.book_id = b.id) AS tags,
        (SELECT json_group_array(c.uid) FROM collections c JOIN book_collections bc ON bc.collection_id = c.id WHERE bc.book_id = b.id) AS collections
        FROM books b")?;
    Ok(State {
        device_id: device_id(c)?,
        device_name: device_name.into(),
        exported_at: now(),
        books,
        collections: rows(c, "SELECT c.uid, c.name, c.sort, p.uid AS parent_uid, c.updated_at FROM collections c LEFT JOIN collections p ON p.id = c.parent_id")?,
        annotations: rows(c, "SELECT a.id, b.uid AS book_uid, a.kind, a.color, a.anchor, a.page_label, a.text, a.comment, a.tags, a.style, a.created_at, a.updated_at FROM annotations a JOIN books b ON b.id = a.book_id")?,
        bookmarks: rows(c, "SELECT m.id, b.uid AS book_uid, m.locator, m.label, m.created_at, m.updated_at FROM bookmarks m JOIN books b ON b.id = m.book_id")?,
        notes: rows(c, "SELECT n.id, b.uid AS book_uid, n.title, n.body, n.created_at, n.updated_at FROM notes n LEFT JOIN books b ON b.id = n.book_id")?,
        progress: rows(c, "SELECT b.uid AS book_uid, p.locator, p.percent, p.settings, p.updated_at FROM progress p JOIN books b ON b.id = p.book_id")?,
        cards: rows(c, "SELECT k.id, b.uid AS book_uid, k.annotation_id, k.front, k.back, k.fsrs, k.due, k.is_new, k.suspended, k.kind, k.media, k.created_at, k.updated_at FROM cards k LEFT JOIN books b ON b.id = k.book_id")?,
        reviews: rows(c, "SELECT card_id, rating, reviewed_at, seconds FROM reviews")?,
        tombstones: rows(c, "SELECT tbl, key, deleted_at FROM tombstones")?,
        plans: export_plans(c)?,
    })
}

/// Map `book_id` inside study-plan day/settings JSON between local ids and global book uids.
fn map_plan_books(v: &mut Value, f: &dyn Fn(&Value) -> Option<Value>, from: &str, to: &str) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(|x| map_plan_books(x, f, from, to)),
        Value::Object(o) => {
            if let Some(id) = o.remove(from) { if let Some(n) = f(&id) { o.insert(to.into(), n); } }
            for (_, x) in o.iter_mut() { map_plan_books(x, f, from, to); }
        }
        _ => {}
    }
}

fn export_plans(c: &Connection) -> AppResult<Vec<Value>> {
    let mut out = rows(c, "SELECT id, title, settings, days, active, created_at, updated_at FROM study_plans")?;
    let uid_of = |id: &Value| id.as_i64().and_then(|i| c.query_row("SELECT uid FROM books WHERE id = ?", [i], |r| r.get::<_, String>(0)).ok()).map(Value::from);
    for p in &mut out {
        for k in ["settings", "days"] {
            let mut j: Value = serde_json::from_str(p[k].as_str().unwrap_or("null")).unwrap_or(Value::Null);
            map_plan_books(&mut j, &uid_of, "book_id", "book_uid");
            p[k] = Value::from(j.to_string());
        }
    }
    Ok(out)
}

fn s(v: &Value, k: &str) -> Option<String> { v[k].as_str().map(String::from) }
fn newer(remote: &Option<String>, local: &Option<String>) -> bool {
    match (remote, local) { (Some(r), Some(l)) => r > l, (Some(_), None) => true, _ => false }
}

/// Merge another device's state. `since` = when we last merged this device (for conflict detection).
pub fn merge(c: &mut Connection, st: &State, since: Option<&str>, report: &mut SyncReport) -> AppResult<()> {
    let tx = c.transaction()?;
    let book_id = |tx: &Connection, uid: &str| -> rusqlite::Result<Option<i64>> { tx.query_row("SELECT id FROM books WHERE uid = ?", [uid], |r| r.get(0)).optional() };
    let tomb = |tx: &Connection, tbl: &str, key: &str| -> rusqlite::Result<Option<String>> { tx.query_row("SELECT deleted_at FROM tombstones WHERE tbl = ? AND key = ?", [tbl, key], |r| r.get(0)).optional() };

    // Collections first (books reference them).
    for col in &st.collections {
        let Some(uid) = s(col, "uid") else { continue };
        let upd = s(col, "updated_at");
        if newer(&tomb(&tx, "collections", &uid)?, &upd) { continue; }
        let local: Option<String> = tx.query_row("SELECT updated_at FROM collections WHERE uid = ?", [&uid], |r| r.get(0)).optional()?;
        if local.is_none() || newer(&upd, &local) {
            tx.execute(
                "INSERT INTO collections (uid, name, sort, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(uid) DO UPDATE SET name = excluded.name, sort = excluded.sort, updated_at = excluded.updated_at",
                params![uid, s(col, "name").unwrap_or_default(), col["sort"].as_i64().unwrap_or(0), upd],
            )?;
            report.applied += 1;
        }
    }
    for col in &st.collections {
        if let (Some(uid), Some(p)) = (s(col, "uid"), s(col, "parent_uid")) {
            tx.execute("UPDATE collections SET parent_id = (SELECT id FROM collections WHERE uid = ?1) WHERE uid = ?2 AND parent_id IS NOT (SELECT id FROM collections WHERE uid = ?1)", params![p, uid])?;
        }
    }

    // Books: match by uid, else adopt a local book that holds the same file content.
    for b in &st.books {
        let Some(uid) = s(b, "uid") else { continue };
        let upd = s(b, "updated_at");
        if newer(&tomb(&tx, "books", &uid)?, &upd) { continue; }
        let hashes: Vec<String> = serde_json::from_str::<Vec<Value>>(b["files"].as_str().unwrap_or("[]")).unwrap_or_default().iter().filter_map(|f| s(f, "hash")).collect();
        let mut local = book_id(&tx, &uid)?;
        let mut adopted = false;
        if local.is_none() {
            for h in &hashes {
                if let Some(id) = tx.query_row("SELECT book_id FROM files WHERE hash = ?", [h], |r| r.get::<_, i64>(0)).optional()? {
                    tx.execute("UPDATE books SET uid = ? WHERE id = ?", params![uid, id])?;
                    local = Some(id);
                    // First match of the same file on this device: prefer the other device's metadata,
                    // unless it was edited by hand here.
                    let manual: Option<String> = tx.query_row("SELECT metadata_source FROM books WHERE id = ?", [id], |r| r.get(0))?;
                    adopted = manual.as_deref() != Some("manual");
                    break;
                }
            }
        }
        let local_upd: Option<String> = match local { Some(id) => tx.query_row("SELECT updated_at FROM books WHERE id = ?", [id], |r| r.get(0)).optional()?, None => None };
        if local.is_some() && !adopted && !newer(&upd, &local_upd) { continue; }
        let id = match local {
            Some(id) => id,
            None => {
                tx.execute("INSERT INTO books (uid, title) VALUES (?, ?)", params![uid, s(b, "title").unwrap_or_default()])?;
                tx.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('enriched:' || ?, '1')", [tx.last_insert_rowid()])?;
                tx.last_insert_rowid()
            }
        };
        tx.execute(
            "UPDATE books SET title=?2, subtitle=?3, authors=?4, year=?5, language=?6, publisher=?7, isbn=?8, doi=?9, series=?10, series_index=?11,
               description=?12, edition=?13, place=?14, num_pages=?15, item_type=COALESCE(?16,'book'), short_title=?17, metadata_source=?18, rating=?19,
               status=COALESCE(?20,'unread'), favorite=COALESCE(?21,0) WHERE id=?1",
            params![id, s(b, "title"), s(b, "subtitle"), s(b, "authors").unwrap_or_else(|| "[]".into()), b["year"].as_i64(), s(b, "language"), s(b, "publisher"),
                s(b, "isbn"), s(b, "doi"), s(b, "series"), b["series_index"].as_f64(), s(b, "description"), s(b, "edition"), s(b, "place"), b["num_pages"].as_i64(),
                s(b, "item_type"), s(b, "short_title"), s(b, "metadata_source"), b["rating"].as_i64(), s(b, "status"), b["favorite"].as_i64()],
        )?;
        // Tags and collections (membership is part of the book record).
        tx.execute("DELETE FROM book_tags WHERE book_id = ?", [id])?;
        for t in serde_json::from_str::<Vec<Value>>(b["tags"].as_str().unwrap_or("[]")).unwrap_or_default() {
            let Some(name) = s(&t, "name") else { continue };
            tx.execute("INSERT INTO tags (name, color) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET color = COALESCE(tags.color, excluded.color)", params![name, s(&t, "color")])?;
            tx.execute("INSERT OR IGNORE INTO book_tags (book_id, tag_id) SELECT ?, id FROM tags WHERE name = ?", params![id, name])?;
        }
        tx.execute("DELETE FROM book_collections WHERE book_id = ?", [id])?;
        for cu in serde_json::from_str::<Vec<String>>(b["collections"].as_str().unwrap_or("[]")).unwrap_or_default() {
            tx.execute("INSERT OR IGNORE INTO book_collections (book_id, collection_id) SELECT ?, id FROM collections WHERE uid = ?", params![id, cu])?;
        }
        // Membership triggers bumped updated_at; restore the remote timestamp so we don't echo it as a new change.
        tx.execute("UPDATE books SET updated_at = ? WHERE id = ?", params![upd, id])?;
        report.applied += 1;
    }

    // Annotations / bookmarks / cards: plain LWW keyed by uuid.
    for a in &st.annotations {
        let (Some(id), Some(bu)) = (s(a, "id"), s(a, "book_uid")) else { continue };
        let upd = s(a, "updated_at");
        if newer(&tomb(&tx, "annotations", &id)?, &upd) { continue; }
        let Some(bid) = book_id(&tx, &bu)? else { continue };
        let local: Option<String> = tx.query_row("SELECT updated_at FROM annotations WHERE id = ?", [&id], |r| r.get(0)).optional()?;
        if local.is_some() && !newer(&upd, &local) { continue; }
        tx.execute(
            "INSERT INTO annotations (id, book_id, kind, color, anchor, page_label, text, comment, tags, style, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9,'[]'), ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, color=excluded.color, anchor=excluded.anchor, page_label=excluded.page_label,
               text=excluded.text, comment=excluded.comment, tags=excluded.tags, style=excluded.style, updated_at=excluded.updated_at",
            params![id, bid, s(a, "kind"), s(a, "color"), s(a, "anchor"), s(a, "page_label"), s(a, "text"), s(a, "comment"), s(a, "tags"), s(a, "style"), s(a, "created_at"), upd],
        )?;
        report.applied += 1;
    }
    for m in &st.bookmarks {
        let (Some(id), Some(bu)) = (s(m, "id"), s(m, "book_uid")) else { continue };
        let upd = s(m, "updated_at");
        if newer(&tomb(&tx, "bookmarks", &id)?, &upd) { continue; }
        let Some(bid) = book_id(&tx, &bu)? else { continue };
        let local: Option<String> = tx.query_row("SELECT updated_at FROM bookmarks WHERE id = ?", [&id], |r| r.get(0)).optional()?;
        if local.is_some() && !newer(&upd, &local) { continue; }
        tx.execute(
            "INSERT INTO bookmarks (id, book_id, locator, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET locator=excluded.locator, label=excluded.label",
            params![id, bid, s(m, "locator"), s(m, "label"), s(m, "created_at"), upd],
        )?;
        tx.execute("UPDATE bookmarks SET updated_at = ? WHERE id = ?", params![upd, id])?;
        report.applied += 1;
    }
    // Notes: LWW, but keep both when edited on both sides since the last merge.
    for n in &st.notes {
        let Some(id) = s(n, "id") else { continue };
        let upd = s(n, "updated_at");
        if newer(&tomb(&tx, "notes", &id)?, &upd) { continue; }
        let bid = match s(n, "book_uid") { Some(u) => match book_id(&tx, &u)? { Some(b) => Some(b), None => continue }, None => None };
        let local: Option<(String, String)> = tx.query_row("SELECT updated_at, body FROM notes WHERE id = ?", [&id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let body = s(n, "body").unwrap_or_default();
        if let Some((lu, lbody)) = &local {
            if lbody == &body { continue; }
            let changed_here = since.map_or(false, |c| lu.as_str() > c);
            let changed_there = since.map_or(false, |c| upd.as_deref().map_or(false, |u| u > c));
            if changed_here && changed_there {
                let copy = format!("{id}-conflict-{}", &st.device_id[..st.device_id.len().min(6)]);
                tx.execute(
                    "INSERT OR REPLACE INTO notes (id, book_id, title, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![copy, bid, format!("{} (conflict copy from {})", s(n, "title").unwrap_or_default(), st.device_name), body, s(n, "created_at"), upd],
                )?;
                report.conflicts += 1;
                continue;
            }
            if !newer(&upd, &Some(lu.clone())) { continue; }
        }
        tx.execute(
            "INSERT INTO notes (id, book_id, title, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET book_id=excluded.book_id, title=excluded.title, body=excluded.body, updated_at=excluded.updated_at",
            params![id, bid, s(n, "title").unwrap_or_default(), body, s(n, "created_at"), upd],
        )?;
        report.applied += 1;
    }
    for p in &st.progress {
        let Some(bu) = s(p, "book_uid") else { continue };
        let Some(bid) = book_id(&tx, &bu)? else { continue };
        let upd = s(p, "updated_at");
        let local: Option<String> = tx.query_row("SELECT updated_at FROM progress WHERE book_id = ?", [bid], |r| r.get(0)).optional()?;
        if local.is_some() && !newer(&upd, &local) { continue; }
        tx.execute(
            "INSERT INTO progress (book_id, locator, percent, settings, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(book_id) DO UPDATE SET locator=excluded.locator, percent=excluded.percent, settings=excluded.settings, updated_at=excluded.updated_at",
            params![bid, s(p, "locator"), p["percent"].as_f64().unwrap_or(0.0), s(p, "settings"), upd],
        )?;
        report.applied += 1;
    }
    for k in &st.cards {
        let Some(id) = s(k, "id") else { continue };
        let upd = s(k, "updated_at");
        if newer(&tomb(&tx, "cards", &id)?, &upd) { continue; }
        let bid = match s(k, "book_uid") { Some(u) => book_id(&tx, &u)?, None => None };
        let local: Option<String> = tx.query_row("SELECT updated_at FROM cards WHERE id = ?", [&id], |r| r.get(0)).optional()?;
        if local.is_some() && !newer(&upd, &local) { continue; }
        let ann = s(k, "annotation_id").filter(|a| tx.query_row("SELECT 1 FROM annotations WHERE id = ?", [a], |_| Ok(())).optional().ok().flatten().is_some());
        tx.execute(
            "INSERT INTO cards (id, book_id, annotation_id, front, back, fsrs, due, is_new, suspended, created_at, updated_at, kind, media) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET front=excluded.front, back=excluded.back, fsrs=excluded.fsrs, due=excluded.due, is_new=excluded.is_new, suspended=excluded.suspended, updated_at=excluded.updated_at, kind=excluded.kind, media=excluded.media",
            params![id, bid, ann, s(k, "front"), s(k, "back").unwrap_or_default(), s(k, "fsrs").unwrap_or_else(|| "{}".into()), s(k, "due"), k["is_new"].as_i64().unwrap_or(1), k["suspended"].as_i64().unwrap_or(0), s(k, "created_at"), upd, s(k, "kind").unwrap_or_else(|| "basic".into()), s(k, "media")],
        )?;
        report.applied += 1;
    }
    for p in &st.plans {
        let Some(id) = s(p, "id") else { continue };
        let upd = s(p, "updated_at");
        if newer(&tomb(&tx, "study_plans", &id)?, &upd) { continue; }
        let local: Option<String> = tx.query_row("SELECT updated_at FROM study_plans WHERE id = ?", [&id], |r| r.get(0)).optional()?;
        if local.is_some() && !newer(&upd, &local) { continue; }
        let id_of = |u: &Value| u.as_str().and_then(|u| tx.query_row("SELECT id FROM books WHERE uid = ?", [u], |r| r.get::<_, i64>(0)).ok()).map(Value::from);
        let conv = |k: &str| { let mut j: Value = serde_json::from_str(p[k].as_str().unwrap_or("null")).unwrap_or(Value::Null); map_plan_books(&mut j, &id_of, "book_uid", "book_id"); j.to_string() };
        let (settings, days) = (conv("settings"), conv("days"));
        tx.execute(
            "INSERT INTO study_plans (id, title, settings, days, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, settings=excluded.settings, days=excluded.days, active=excluded.active, updated_at=excluded.updated_at",
            params![id, s(p, "title").unwrap_or_default(), settings, days, p["active"].as_i64().unwrap_or(1), s(p, "created_at"), upd],
        )?;
        report.applied += 1;
    }
    for r in &st.reviews {
        let (Some(card), Some(at)) = (s(r, "card_id"), s(r, "reviewed_at")) else { continue };
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM reviews WHERE card_id = ? AND reviewed_at = ?)", params![card, at], |x| x.get(0))?;
        let card_ok: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cards WHERE id = ?)", [&card], |x| x.get(0))?;
        if !exists && card_ok {
            tx.execute("INSERT INTO reviews (card_id, rating, reviewed_at, seconds) VALUES (?, ?, ?, ?)", params![card, r["rating"].as_i64().unwrap_or(3), at, r["seconds"].as_i64()])?;
        }
    }

    // Deletions: remove the local row if it wasn't changed after the deletion.
    for t in &st.tombstones {
        let (Some(tbl), Some(key), Some(at)) = (s(t, "tbl"), s(t, "key"), s(t, "deleted_at")) else { continue };
        let (sql_upd, sql_del) = match tbl.as_str() {
            "books" => ("SELECT updated_at FROM books WHERE uid = ?", "DELETE FROM books WHERE uid = ?"),
            "annotations" => ("SELECT updated_at FROM annotations WHERE id = ?", "DELETE FROM annotations WHERE id = ?"),
            "bookmarks" => ("SELECT updated_at FROM bookmarks WHERE id = ?", "DELETE FROM bookmarks WHERE id = ?"),
            "notes" => ("SELECT updated_at FROM notes WHERE id = ?", "DELETE FROM notes WHERE id = ?"),
            "cards" => ("SELECT updated_at FROM cards WHERE id = ?", "DELETE FROM cards WHERE id = ?"),
            "study_plans" => ("SELECT updated_at FROM study_plans WHERE id = ?", "DELETE FROM study_plans WHERE id = ?"),
            "collections" => ("SELECT updated_at FROM collections WHERE uid = ?", "DELETE FROM collections WHERE uid = ?"),
            _ => continue,
        };
        let local: Option<String> = tx.query_row(sql_upd, [&key], |r| r.get(0)).optional()?;
        if let Some(lu) = local {
            if lu < at {
                tx.execute(sql_del, [&key])?;
                report.deleted += 1;
            }
        }
        tx.execute("INSERT INTO tombstones (tbl, key, deleted_at) VALUES (?1, ?2, ?3) ON CONFLICT(tbl, key) DO UPDATE SET deleted_at = max(deleted_at, excluded.deleted_at)", params![tbl, key, at])?;
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub enabled: bool,
    pub target: Option<Target>,
    #[serde(default)]
    pub sync_files: bool,
    #[serde(default = "default_name")]
    pub device_name: String,
    #[serde(default)]
    pub backup_daily: bool,
    #[serde(default = "default_keep")]
    pub backup_keep: usize,
    /// End-to-end encryption on (key lives in the Keychain).
    #[serde(default)]
    pub encrypted: bool,
}
fn default_name() -> String { "This Mac".into() }
fn default_keep() -> usize { 10 }
impl Default for SyncConfig {
    fn default() -> Self { Self { enabled: false, target: None, sync_files: false, device_name: default_name(), backup_daily: false, backup_keep: 10, encrypted: false } }
}

/// Push our state, pull everyone else's, and (optionally) exchange book files.
pub async fn run(db: &Db, target: &Store, cfg: &SyncConfig, download_dir: &Path, media_dir: Option<&Path>) -> AppResult<SyncReport> {
    let mut report = SyncReport { at: now(), ..Default::default() };
    let me = db.with(|c| device_id(c))?;

    // Pull first so our push already contains merged state.
    for dev in target.list("sync/devices").await? {
        if dev == me { continue; }
        let Some(bytes) = target.get(&format!("sync/devices/{dev}/state.json")).await? else { continue };
        let Ok(st) = serde_json::from_slice::<State>(&bytes) else { continue };
        let since: Option<String> = db.with(|c| Ok(c.query_row("SELECT seen_at FROM sync_cursors WHERE device_id = ?", [&dev], |r| r.get(0)).optional()?))?;
        if since.as_deref().map_or(false, |s| st.exported_at.as_str() <= s) { continue; }
        db.with(|c| merge(c, &st, since.as_deref(), &mut report))?;
        db.with(|c| remember_remote_files(c, &st))?;
        db.with(|c| Ok(c.execute("INSERT INTO sync_cursors (device_id, seen_at) VALUES (?1, ?2) ON CONFLICT(device_id) DO UPDATE SET seen_at = ?2", params![dev, st.exported_at]).map(|_| ())?))?;
        report.pulled_devices += 1;
    }

    if cfg.sync_files {
        let remote: HashSet<String> = target.list("sync/files").await?.into_iter().collect();
        // Upload local files that aren't there yet.
        let local: Vec<(String, String, String)> = db.with(|c| Ok(c.prepare("SELECT hash, format, path FROM files WHERE missing = 0 AND hash IS NOT NULL")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?))?;
        for (h, fmt, path) in &local {
            let name = format!("{h}.{fmt}");
            if !remote.contains(&name) {
                if let Ok(bytes) = std::fs::read(path) {
                    target.put(&format!("sync/files/{name}"), bytes).await?;
                    report.files_up += 1;
                }
            }
        }
        // Download files for books we only know from other devices.
        let wanted: Vec<(i64, String, String, String)> = db.with(|c| {
            let mut out = vec![];
            for dev in remote_book_files(c)? { out.push(dev); }
            Ok(out)
        })?;
        let _ = &wanted;
        let mut by_hash: HashMap<String, (i64, String, String)> = HashMap::new();
        for (bid, h, fmt, title) in wanted { by_hash.entry(h).or_insert((bid, fmt, title)); }
        for (h, (bid, fmt, title)) in by_hash {
            let name = format!("{h}.{fmt}");
            if !remote.contains(&name) { continue; }
            let Some(bytes) = target.get(&format!("sync/files/{name}")).await? else { continue };
            std::fs::create_dir_all(download_dir)?;
            let safe = crate::downloads::sanitize_name(&title);
            let mut dest = download_dir.join(format!("{safe}.{fmt}"));
            if dest.exists() { dest = download_dir.join(format!("{safe} ({}).{fmt}", &h[..6])); }
            std::fs::write(&dest, &bytes)?;
            db.with(|c| Ok(c.execute("INSERT OR IGNORE INTO files (book_id, path, format, size, hash, mtime) VALUES (?, ?, ?, ?, ?, ?)", params![bid, dest.to_string_lossy(), fmt, bytes.len() as i64, h, chrono::Utc::now().timestamp()]).map(|_| ())?))?;
            report.files_down += 1;
        }
    }

    // Card images (image-occlusion) are small: always synced, content-addressed under sync/media/.
    if let Some(media_dir) = media_dir {
        let remote: HashSet<String> = target.list("sync/media").await?.into_iter().collect();
        for name in db.with(|c| crate::cards::media_names(c))? {
            let local = media_dir.join(&name);
            if local.exists() {
                if !remote.contains(&name) { if let Ok(b) = std::fs::read(&local) { target.put(&format!("sync/media/{name}"), b).await?; } }
            } else if remote.contains(&name) {
                if let Some(b) = target.get(&format!("sync/media/{name}")).await? {
                    // Content-addressed: only accept bytes that match their name.
                    if format!("{}.png", blake3::hash(&b).to_hex()) == name { std::fs::create_dir_all(media_dir)?; std::fs::write(&local, b)?; }
                }
            }
        }
    }

    let st = db.with(|c| export(c, &cfg.device_name))?;
    target.put(&format!("sync/devices/{me}/state.json"), serde_json::to_vec(&st)?).await?;
    Ok(report)
}

/// (book_id, hash, format, title) for synced books that have no local file but whose state lists one.
/// The hashes come from the remote state we stored in kv during merge (`remote_files:<uid>`).
fn remote_book_files(c: &Connection) -> AppResult<Vec<(i64, String, String, String)>> {
    let mut st = c.prepare(
        "SELECT b.id, json_extract(j.value, '$.hash'), json_extract(j.value, '$.format'), b.title
         FROM books b JOIN kv ON kv.key = 'remote_files:' || b.uid, json_each(kv.value) j
         WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.book_id = b.id)",
    )?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Remember which file hashes other devices have for each book (used for on-demand file download).
pub fn remember_remote_files(c: &Connection, st: &State) -> AppResult<()> {
    for b in &st.books {
        if let (Some(uid), Some(files)) = (s(b, "uid"), b["files"].as_str()) {
            if files != "[]" {
                c.execute("INSERT INTO kv (key, value) VALUES ('remote_files:' || ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![uid, files])?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::store;
    use crate::reading::{self, Annotation, Note};

    fn ann(book: i64, id: &str, comment: &str) -> Annotation {
        Annotation { id: id.into(), book_id: book, kind: "highlight".into(), color: Some("#ffd400".into()), anchor: serde_json::json!({"page": 1, "rects": []}), page_label: None, text: Some("t".into()), comment: Some(comment.into()), tags: vec![], style: None, created_at: String::new(), updated_at: String::new() }
    }

    #[test]
    fn two_devices_converge() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let shared = tempfile::tempdir().unwrap();
            let dl = tempfile::tempdir().unwrap();
            let folder = Target::Folder { path: shared.path().to_string_lossy().to_string() };
            // Run the whole two-device scenario through an encrypted store.
            let (_, key) = crate::crypto::new_header("test passphrase").unwrap();
            let target = Store { target: folder.clone(), key: Some(key) };
            let cfg = SyncConfig { enabled: true, target: Some(folder), ..Default::default() };
            let a = Db::open_in_memory().unwrap();
            let b = Db::open_in_memory().unwrap();

            // Device A: a book (with a file hash), a collection, an annotation and a note.
            let (book_a, note_id) = a.with(|c| {
                let id = store::insert_book(c, "Shared Book", &["Ada".into()], Some(2020))?;
                c.execute("INSERT INTO files (book_id, path, format, size, hash) VALUES (?, '/a/x.pdf', 'pdf', 1, 'hash1')", [id])?;
                let col = store::create_collection(c, "Reading list", None)?;
                store::set_book_collection(c, &[id], col, true)?;
                reading::upsert_annotation(c, &ann(id, "ann-1", "from A"))?;
                let n = reading::upsert_note(c, &Note { id: String::new(), book_id: Some(id), title: "N".into(), body: "v1".into(), created_at: String::new(), updated_at: String::new() })?;
                c.execute("INSERT INTO study_plans (id, title, settings, days) VALUES ('plan-1', 'Finish it', ?1, ?2)", params![
                    serde_json::json!({"books": [{"book_id": id}]}).to_string(),
                    serde_json::json!([{"date": "2026-11-09", "book_id": id, "unit": "p", "from": 1, "to": 20}]).to_string()])?;
                Ok((id, n.id))
            }).unwrap();
            let (media_a, media_b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let png = [&[0x89, b'P', b'N', b'G'][..], b"diagram"].concat();
            let img = crate::cards::save_media(media_a.path(), &png).unwrap();
            a.with(|c| { c.execute("INSERT INTO cards (id, front, fsrs, due, kind, media) VALUES ('occ-1', 'Diagram', '{}', '2026-01-01', 'occlusion', ?)", [serde_json::json!({"image": img, "masks": [], "target": 0}).to_string()])?; Ok(()) }).unwrap();
            // Device B already has the same file locally (different path) → should adopt, not duplicate.
            b.with(|c| {
                let id = store::insert_book(c, "x", &[], None)?;
                c.execute("INSERT INTO files (book_id, path, format, size, hash) VALUES (?, '/b/x.pdf', 'pdf', 1, 'hash1')", [id])?;
                Ok(())
            }).unwrap();

            run(&a, &target, &cfg, dl.path(), Some(media_a.path())).await.unwrap();
            let dev_dir = std::fs::read_dir(shared.path().join("sync/devices")).unwrap().next().unwrap().unwrap().path();
            let raw = std::fs::read(dev_dir.join("state.json")).unwrap();
            assert!(crate::crypto::is_sealed(&raw) && !String::from_utf8_lossy(&raw).contains("Shared Book"), "state is encrypted at rest");
            let r = run(&b, &target, &cfg, dl.path(), Some(media_b.path())).await.unwrap();
            assert_eq!(r.pulled_devices, 1);
            assert_eq!(std::fs::read(media_b.path().join(&img)).unwrap(), png, "card image synced");
            b.with(|c| {
                let n: i64 = c.query_row("SELECT count(*) FROM books", [], |x| x.get(0))?;
                assert_eq!(n, 1, "matched by file hash, no duplicate");
                let t: String = c.query_row("SELECT title FROM books", [], |x| x.get(0))?;
                assert_eq!(t, "Shared Book");
                let in_col: i64 = c.query_row("SELECT count(*) FROM book_collections bc JOIN collections c ON c.id = bc.collection_id WHERE c.name = 'Reading list'", [], |x| x.get(0))?;
                assert_eq!(in_col, 1);
                assert_eq!(reading::list_annotations(c, None)?.len(), 1);
                let bid: i64 = c.query_row("SELECT id FROM books", [], |x| x.get(0))?;
                let days: String = c.query_row("SELECT days FROM study_plans WHERE id = 'plan-1'", [], |x| x.get(0))?;
                let days: Value = serde_json::from_str(&days).unwrap();
                assert_eq!(days[0]["book_id"], bid, "plan day points at B's local book id");
                let kind: String = c.query_row("SELECT kind FROM cards WHERE id = 'occ-1'", [], |x| x.get(0))?;
                assert_eq!(kind, "occlusion");
                Ok(())
            }).unwrap();

            // B edits the annotation and deletes nothing; A deletes the note; both sync.
            std::thread::sleep(std::time::Duration::from_millis(5));
            b.with(|c| {
                let bid: i64 = c.query_row("SELECT id FROM books", [], |x| x.get(0))?;
                reading::upsert_annotation(c, &ann(bid, "ann-1", "edited on B")).map(|_| ())
            }).unwrap();
            a.with(|c| reading::delete_note(c, &note_id)).unwrap();
            run(&b, &target, &cfg, dl.path(), None).await.unwrap();
            run(&a, &target, &cfg, dl.path(), None).await.unwrap();
            run(&b, &target, &cfg, dl.path(), None).await.unwrap();
            a.with(|c| { assert_eq!(reading::list_annotations(c, Some(book_a))?[0].comment.as_deref(), Some("edited on B")); Ok(()) }).unwrap();
            b.with(|c| { assert!(reading::list_notes(c, None, true)?.is_empty(), "deletion propagated"); Ok(()) }).unwrap();
        });
    }

    #[test]
    fn concurrent_note_edits_keep_both() {
        let a = Db::open_in_memory().unwrap();
        let mut report = SyncReport::default();
        a.with(|c| {
            reading::upsert_note(c, &Note { id: "n1".into(), book_id: None, title: "Ideas".into(), body: "local edit".into(), created_at: String::new(), updated_at: String::new() })?;
            let remote = State {
                device_id: "devB123".into(), device_name: "iPad".into(), exported_at: now(),
                notes: vec![serde_json::json!({"id": "n1", "book_uid": null, "title": "Ideas", "body": "remote edit", "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2999-01-01T00:00:00.000Z"})],
                ..Default::default()
            };
            merge(c, &remote, Some("2000-01-01T00:00:00.000Z"), &mut report)?;
            let notes = reading::list_notes(c, None, true)?;
            assert_eq!(notes.len(), 2);
            assert!(notes.iter().any(|n| n.title.contains("conflict copy from iPad") && n.body == "remote edit"));
            assert!(notes.iter().any(|n| n.id == "n1" && n.body == "local edit"));
            Ok(())
        }).unwrap();
        assert_eq!(report.conflicts, 1);
    }
}
