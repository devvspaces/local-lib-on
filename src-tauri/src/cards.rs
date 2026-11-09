//! Flashcards. Scheduling (FSRS) runs in the frontend with ts-fsrs; this stores card state and reviews.
use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    #[serde(default)]
    pub id: String,
    pub book_id: Option<i64>,
    pub annotation_id: Option<String>,
    pub front: String,
    #[serde(default)]
    pub back: String,
    pub fsrs: serde_json::Value,
    pub due: String,
    #[serde(default = "yes")]
    pub is_new: bool,
    #[serde(default)]
    pub suspended: bool,
    #[serde(default)]
    pub book_title: Option<String>,
    #[serde(default)]
    pub page_label: Option<String>,
    /// "basic" or "occlusion"
    #[serde(default = "basic")]
    pub kind: String,
    /// Occlusion data: {image, w, h, masks: [[x,y,w,h]…] (0..1), target, mode}
    #[serde(default)]
    pub media: Option<serde_json::Value>,
}
fn basic() -> String { "basic".into() }
fn yes() -> bool { true }

const SELECT: &str = "SELECT c.id, c.book_id, c.annotation_id, c.front, c.back, c.fsrs, c.due, c.is_new, c.suspended, b.title, a.page_label, c.kind, c.media
  FROM cards c LEFT JOIN books b ON b.id = c.book_id LEFT JOIN annotations a ON a.id = c.annotation_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Card> {
    let f: String = r.get(5)?;
    Ok(Card {
        id: r.get(0)?, book_id: r.get(1)?, annotation_id: r.get(2)?, front: r.get(3)?, back: r.get(4)?,
        fsrs: serde_json::from_str(&f).unwrap_or(serde_json::Value::Null), due: r.get(6)?,
        is_new: r.get::<_, i64>(7)? != 0, suspended: r.get::<_, i64>(8)? != 0, book_title: r.get(9)?, page_label: r.get(10)?,
        kind: r.get(11)?, media: r.get::<_, Option<String>>(12)?.and_then(|m| serde_json::from_str(&m).ok()),
    })
}

pub fn upsert(c: &Connection, card: &Card) -> AppResult<String> {
    let id = if card.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { card.id.clone() };
    c.execute(
        "INSERT INTO cards (id, book_id, annotation_id, front, back, fsrs, due, is_new, suspended, kind, media) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET front=excluded.front, back=excluded.back, fsrs=excluded.fsrs, due=excluded.due,
           is_new=excluded.is_new, suspended=excluded.suspended, kind=excluded.kind, media=excluded.media, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        params![id, card.book_id, card.annotation_id, card.front, card.back, card.fsrs.to_string(), card.due, card.is_new as i64, card.suspended as i64, card.kind, card.media.as_ref().map(|m| m.to_string())],
    )?;
    Ok(id)
}

/// Cards due now: reviews (not new) first, then up to `new_limit` new cards not yet introduced today.
pub fn due(c: &Connection, now: &str, book_id: Option<i64>, new_limit: i64, limit: i64) -> AppResult<Vec<Card>> {
    let new_today: i64 = c.query_row(
        "SELECT count(DISTINCT r.card_id) FROM reviews r WHERE date(r.reviewed_at,'localtime') = date('now','localtime')
           AND r.id = (SELECT min(id) FROM reviews r2 WHERE r2.card_id = r.card_id)",
        [],
        |r| r.get(0),
    )?;
    let mut out: Vec<Card> = c
        .prepare(&format!("{SELECT} WHERE c.suspended = 0 AND c.is_new = 0 AND c.due <= ?1 AND (?2 IS NULL OR c.book_id = ?2) ORDER BY c.due LIMIT ?3"))?
        .query_map(params![now, book_id, limit], row)?
        .collect::<Result<_, _>>()?;
    let room = (new_limit - new_today).max(0).min(limit - out.len() as i64);
    if room > 0 {
        let fresh: Vec<Card> = c
            .prepare(&format!("{SELECT} WHERE c.suspended = 0 AND c.is_new = 1 AND (?1 IS NULL OR c.book_id = ?1) ORDER BY c.created_at LIMIT ?2"))?
            .query_map(params![book_id, room], row)?
            .collect::<Result<_, _>>()?;
        out.extend(fresh);
    }
    Ok(out)
}

pub fn list(c: &Connection, book_id: Option<i64>) -> AppResult<Vec<Card>> {
    Ok(c.prepare(&format!("{SELECT} WHERE (?1 IS NULL OR c.book_id = ?1) ORDER BY c.created_at DESC"))?
        .query_map(params![book_id], row)?
        .collect::<Result<_, _>>()?)
}

#[derive(Debug, Serialize, Default)]
pub struct CardCounts { pub due: i64, pub new: i64, pub total: i64, pub reviewed_today: i64 }

pub fn counts(c: &Connection, now: &str, new_limit: i64) -> AppResult<CardCounts> {
    let q = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> AppResult<i64> { Ok(c.query_row(sql, p, |r| r.get(0))?) };
    let reviewed_today = q("SELECT count(*) FROM reviews WHERE date(reviewed_at,'localtime') = date('now','localtime')", &[])?;
    let due = q("SELECT count(*) FROM cards WHERE suspended = 0 AND is_new = 0 AND due <= ?", &[&now])?;
    let new_avail = q("SELECT count(*) FROM cards WHERE suspended = 0 AND is_new = 1", &[])?;
    let total = q("SELECT count(*) FROM cards", &[])?;
    let new_today: i64 = q("SELECT count(DISTINCT card_id) FROM reviews r WHERE date(reviewed_at,'localtime') = date('now','localtime') AND r.id = (SELECT min(id) FROM reviews r2 WHERE r2.card_id = r.card_id)", &[])?;
    Ok(CardCounts { due, new: new_avail.min((new_limit - new_today).max(0)), total, reviewed_today })
}

pub fn review(c: &Connection, id: &str, rating: i64, fsrs: &serde_json::Value, due: &str, seconds: Option<i64>) -> AppResult<()> {
    c.execute("UPDATE cards SET fsrs = ?, due = ?, is_new = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", params![fsrs.to_string(), due, id])?;
    c.execute("INSERT INTO reviews (card_id, rating, reviewed_at, seconds) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)", params![id, rating, seconds])?;
    Ok(())
}

pub fn delete(c: &Connection, id: &str) -> AppResult<()> {
    c.execute("DELETE FROM cards WHERE id = ?", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn queue_and_reviews() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let b = crate::library::store::insert_book(c, "B", &[], None)?;
            let mk = |front: &str, due: &str, is_new: bool| Card { id: String::new(), book_id: Some(b), annotation_id: None, front: front.into(), back: String::new(), fsrs: serde_json::json!({}), due: due.into(), is_new, suspended: false, book_title: None, page_label: None, kind: "basic".into(), media: None };
            let old = upsert(c, &mk("review me", "2026-01-01T00:00:00Z", false))?;
            upsert(c, &mk("later", "2999-01-01T00:00:00Z", false))?;
            for i in 0..5 { upsert(c, &mk(&format!("new {i}"), "2026-01-01T00:00:00Z", true))?; }
            let q = due(c, "2026-11-07T12:00:00Z", None, 3, 50)?;
            assert_eq!(q.len(), 4, "1 due review + 3 new (limit)");
            assert_eq!(q[0].front, "review me");
            review(c, &q[1].id, 3, &serde_json::json!({"state": 1}), "2026-11-08T00:00:00Z", Some(4))?;
            let n = counts(c, "2026-11-07T12:00:00Z", 3)?;
            assert_eq!((n.due, n.new, n.reviewed_today, n.total), (1, 2, 1, 7));
            delete(c, &old)?;
            Ok(())
        }).unwrap();
    }
}

/// Store an occlusion image (PNG bytes) by content hash under `dir`; returns the file name.
pub fn save_media(dir: &std::path::Path, png: &[u8]) -> AppResult<String> {
    if !png.starts_with(&[0x89, b'P', b'N', b'G']) { return Err(crate::error::AppError::other("not a PNG image")); }
    std::fs::create_dir_all(dir)?;
    let name = format!("{}.png", blake3::hash(png).to_hex());
    let p = dir.join(&name);
    if !p.exists() { std::fs::write(p, png)?; }
    Ok(name)
}

/// Media files referenced by cards (for sync and backups).
pub fn media_names(c: &Connection) -> AppResult<Vec<String>> {
    Ok(c.prepare("SELECT DISTINCT json_extract(media, '$.image') FROM cards WHERE media IS NOT NULL")?
        .query_map([], |r| r.get::<_, Option<String>>(0))?
        .filter_map(|r| r.ok().flatten())
        .filter(|n| is_media_name(n))
        .collect())
}

/// Only `<64 hex>.png` names are accepted from synced data (no paths).
pub fn is_media_name(n: &str) -> bool { n.len() == 68 && n.ends_with(".png") && n[..64].chars().all(|c| c.is_ascii_hexdigit()) }

#[cfg(test)]
mod media_tests {
    use super::*;

    #[test]
    fn occlusion_card_roundtrip_and_media_names() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let png = [&[0x89, b'P', b'N', b'G'][..], b"rest-of-image"].concat();
        let name = save_media(dir.path(), &png).unwrap();
        assert!(is_media_name(&name));
        assert_eq!(save_media(dir.path(), &png).unwrap(), name, "content-addressed");
        assert!(save_media(dir.path(), b"GIF89a").is_err());
        db.with(|c| {
            let card = Card { id: String::new(), book_id: None, annotation_id: None, front: "Diagram · label 2".into(), back: String::new(), fsrs: serde_json::json!({}), due: "2026-01-01T00:00:00Z".into(), is_new: true, suspended: false, book_title: None, page_label: None, kind: "occlusion".into(), media: Some(serde_json::json!({"image": name, "masks": [[0.1, 0.1, 0.2, 0.1]], "target": 0, "mode": "one"})) };
            let id = upsert(c, &card)?;
            let got = list(c, None)?.into_iter().find(|x| x.id == id).unwrap();
            assert_eq!(got.kind, "occlusion");
            assert_eq!(got.media.unwrap()["target"], 0);
            assert_eq!(media_names(c)?, vec![name.clone()]);
            Ok(())
        }).unwrap();
        assert!(!is_media_name("../../etc/passwd.png"));
    }
}
