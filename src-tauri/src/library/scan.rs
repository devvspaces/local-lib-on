//! Indexing of local files: folder scans, single-file import, hashing / dedupe, missing detection.
use super::formats::{format_for, guess_from_filename};
use super::models::ScanReport;
use super::store;
use crate::db::Db;
use crate::error::AppResult;
use rusqlite::{params, OptionalExtension};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn mtime(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Debug, PartialEq)]
pub enum ImportOutcome {
    Unchanged(i64),
    Added(i64),
    Moved(i64),
    /// Same content already in library under another path that still exists → attached as extra file.
    Duplicate(i64),
}

/// Import or refresh one file. Returns the book id.
pub fn import_file(db: &Db, path: &Path) -> AppResult<Option<ImportOutcome>> {
    let Some(format) = format_for(path) else { return Ok(None) };
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() || meta.len() == 0 {
        return Ok(None);
    }
    let path_s = path.to_string_lossy().to_string();
    let size = meta.len() as i64;
    let mt = mtime(&meta);

    // Fast path: known path with same size + mtime.
    let known = db.with(|c| {
        Ok(c.query_row("SELECT id, book_id, size, mtime FROM files WHERE path = ?", [&path_s], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<i64>>(3)?))
        })
        .optional()?)
    })?;
    if let Some((fid, book_id, s, m)) = known {
        if s == size && m == Some(mt) {
            db.with(|c| Ok(c.execute("UPDATE files SET missing = 0 WHERE id = ?", [fid])?))?;
            return Ok(Some(ImportOutcome::Unchanged(book_id)));
        }
        let h = hash_file(path)?;
        db.with(|c| Ok(c.execute("UPDATE files SET size=?, mtime=?, hash=?, missing=0 WHERE id=?", params![size, mt, h, fid])?))?;
        return Ok(Some(ImportOutcome::Unchanged(book_id)));
    }

    let hash = hash_file(path)?;
    db.with(|c| {
        let tx = c.transaction()?;
        // Re-check the path under the lock: a concurrent import (e.g. a drop event delivered twice) may have
        // added it while we were hashing.
        if let Some(book_id) = tx.query_row("SELECT book_id FROM files WHERE path = ?", [&path_s], |r| r.get::<_, i64>(0)).optional()? {
            return Ok(Some(ImportOutcome::Unchanged(book_id)));
        }
        // Same content seen before?
        let existing: Option<(i64, i64, String)> = tx
            .query_row("SELECT id, book_id, path FROM files WHERE hash = ? ORDER BY missing DESC LIMIT 1", [&hash], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let outcome = match existing {
            Some((fid, book_id, old_path)) if !Path::new(&old_path).exists() => {
                tx.execute("UPDATE files SET path=?, size=?, mtime=?, missing=0 WHERE id=?", params![path_s, size, mt, fid])?;
                ImportOutcome::Moved(book_id)
            }
            Some((_, book_id, _)) => {
                tx.execute(
                    "INSERT INTO files (book_id, path, format, size, hash, mtime) VALUES (?, ?, ?, ?, ?, ?)",
                    params![book_id, path_s, format, size, hash, mt],
                )?;
                ImportOutcome::Duplicate(book_id)
            }
            None => {
                let g = guess_from_filename(path);
                let book_id = store::insert_book(&tx, &g.title, &g.authors, g.year)?;
                tx.execute(
                    "INSERT INTO files (book_id, path, format, size, hash, mtime) VALUES (?, ?, ?, ?, ?, ?)",
                    params![book_id, path_s, format, size, hash, mt],
                )?;
                ImportOutcome::Added(book_id)
            }
        };
        tx.commit()?;
        Ok(Some(outcome))
    })
}

pub fn scan_folder(db: &Db, root: &Path, report: &mut ScanReport) {
    for entry in WalkDir::new(root).follow_links(true).into_iter().filter_entry(|e| {
        // skip hidden dirs / files and macOS bundles
        e.depth() == 0 || !e.file_name().to_str().map_or(false, |s| s.starts_with('.'))
    }) {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                report.errors.push(e.to_string());
                continue;
            }
        };
        if !entry.file_type().is_file() || format_for(entry.path()).is_none() {
            continue;
        }
        report.scanned += 1;
        match import_file(db, entry.path()) {
            Ok(Some(ImportOutcome::Added(_))) | Ok(Some(ImportOutcome::Duplicate(_))) => report.added += 1,
            Ok(Some(ImportOutcome::Moved(_))) => report.moved += 1,
            Ok(_) => {}
            Err(e) => report.errors.push(format!("{}: {e}", entry.path().display())),
        }
    }
}

/// Flag files whose path no longer exists (they may come back, e.g. external drive).
pub fn mark_missing(db: &Db) -> AppResult<usize> {
    let all: Vec<(i64, String, bool)> = db.with(|c| {
        Ok(c.prepare("SELECT id, path, missing FROM files")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)))?
            .collect::<Result<_, _>>()?)
    })?;
    let mut missing = 0;
    db.with(|c| {
        for (id, p, was) in &all {
            let now = !Path::new(p).exists();
            if now {
                missing += 1;
            }
            if now != *was {
                c.execute("UPDATE files SET missing = ? WHERE id = ?", params![now as i64, id])?;
            }
        }
        Ok(())
    })?;
    Ok(missing)
}

pub fn watch_folders(db: &Db) -> AppResult<Vec<PathBuf>> {
    db.with(|c| {
        Ok(c.prepare("SELECT path FROM watch_folders ORDER BY path")?
            .query_map([], |r| Ok(PathBuf::from(r.get::<_, String>(0)?)))?
            .collect::<Result<_, _>>()?)
    })
}

pub fn scan_all(db: &Db) -> AppResult<ScanReport> {
    let mut report = ScanReport::default();
    for root in watch_folders(db)? {
        if root.exists() {
            scan_folder(db, &root, &mut report);
        } else {
            report.errors.push(format!("folder not found: {}", root.display()));
        }
    }
    report.missing = mark_missing(db)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::models::LibraryFilter;

    #[test]
    fn concurrent_import_of_same_path_is_safe() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory().unwrap();
        let f = dir.path().join("Offer letter.docx");
        std::fs::write(&f, vec![7u8; 200_000]).unwrap();
        let hs: Vec<_> = (0..4).map(|_| { let (db, f) = (db.clone(), f.clone()); std::thread::spawn(move || import_file(&db, &f)) }).collect();
        for h in hs { assert!(h.join().unwrap().is_ok(), "no UNIQUE constraint error"); }
        let n: i64 = db.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?)).unwrap();
        let b: i64 = db.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?)).unwrap();
        assert_eq!((n, b), (1, 1));
    }

    #[test]
    fn import_dedupe_move_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory().unwrap();
        let a = dir.path().join("Jane Doe - A Book (2020).pdf");
        std::fs::write(&a, b"%PDF-1.4 fake").unwrap();
        std::fs::write(dir.path().join("budget.xlsx"), b"x").unwrap();

        let mut r = ScanReport::default();
        scan_folder(&db, dir.path(), &mut r);
        assert_eq!((r.scanned, r.added), (1, 1));

        // rescan: unchanged
        let mut r = ScanReport::default();
        scan_folder(&db, dir.path(), &mut r);
        assert_eq!(r.added, 0);

        // move file → same book, path updated
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let b = sub.join("renamed.pdf");
        std::fs::rename(&a, &b).unwrap();
        let mut r = ScanReport::default();
        scan_folder(&db, dir.path(), &mut r);
        assert_eq!(r.moved, 1);

        let books = db.with(|c| store::list_books(c, &LibraryFilter::default())).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title, "A Book");
        assert_eq!(books[0].authors, vec!["Jane Doe"]);
        assert_eq!(books[0].files[0].path, b.to_string_lossy());

        std::fs::remove_file(&b).unwrap();
        assert_eq!(mark_missing(&db).unwrap(), 1);
        let books = db.with(|c| store::list_books(c, &LibraryFilter { missing: Some(true), ..Default::default() })).unwrap();
        assert_eq!(books.len(), 1);
    }
}
