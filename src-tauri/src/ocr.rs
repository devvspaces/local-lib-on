//! Storage for OCR results of scanned PDF pages. Recognition runs in the webview (tesseract.js);
//! this module persists word boxes (PDF points) and feeds the recognized text into full-text search.
use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrPage {
    pub page: i64,
    /// [[x0, y0, x1, y1, "word"], …] in PDF user space
    pub words: serde_json::Value,
    pub text: String,
}

pub fn save_page(c: &mut Connection, book_id: i64, p: &OcrPage) -> AppResult<()> {
    let tx = c.transaction()?;
    tx.execute(
        "INSERT INTO ocr_pages (book_id, page, words, text) VALUES (?, ?, ?, ?)
         ON CONFLICT(book_id, page) DO UPDATE SET words = excluded.words, text = excluded.text",
        params![book_id, p.page, p.words.to_string(), p.text],
    )?;
    let loc = format!("p{}", p.page);
    tx.execute("DELETE FROM fts_pages WHERE book_id = ? AND loc = ?", params![book_id, loc])?;
    if !p.text.trim().is_empty() {
        tx.execute("INSERT INTO fts_pages (text, book_id, loc) VALUES (?, ?, ?)", params![p.text, book_id, loc])?;
    }
    tx.execute(
        "INSERT INTO fts_state (book_id, indexed_at, units) VALUES (?, datetime('now'), 1)
         ON CONFLICT(book_id) DO UPDATE SET indexed_at = excluded.indexed_at",
        [book_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn pages(c: &Connection, book_id: i64) -> AppResult<Vec<OcrPage>> {
    Ok(c.prepare("SELECT page, words, text FROM ocr_pages WHERE book_id = ? ORDER BY page")?
        .query_map([book_id], |r| {
            let w: String = r.get(1)?;
            Ok(OcrPage { page: r.get(0)?, words: serde_json::from_str(&w).unwrap_or(serde_json::Value::Null), text: r.get(2)? })
        })?
        .collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn ocr_text_is_searchable() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let b = crate::library::store::insert_book(c, "Scan", &[], None)?;
            save_page(c, b, &OcrPage { page: 3, words: serde_json::json!([[10, 10, 50, 20, "Quantum"]]), text: "Quantum entanglement".into() })?;
            save_page(c, b, &OcrPage { page: 3, words: serde_json::json!([]), text: "Quantum entanglement revised".into() })?;
            let hits = crate::reading::search_fulltext(c, "entangle", None, 10)?;
            assert_eq!(hits.len(), 1, "re-OCR replaces the page instead of duplicating");
            assert_eq!(hits[0].loc, "p3");
            assert_eq!(pages(c, b)?.len(), 1);
            Ok(())
        }).unwrap();
    }
}
