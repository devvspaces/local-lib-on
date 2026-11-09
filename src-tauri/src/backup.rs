//! Backups: a consistent SQLite snapshot (VACUUM INTO) + covers, zipped, written to a Target.
//! Restore stages files that are swapped in on next launch (before the database is opened).
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::storage::{Store, Target};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn build_zip(db: &Db, data_dir: &Path) -> AppResult<(String, Vec<u8>)> {
    let snap = data_dir.join(format!("snapshot-{}.sqlite3", uuid::Uuid::new_v4().simple()));
    db.with(|c| Ok(c.execute("VACUUM INTO ?", [snap.to_string_lossy().to_string()]).map(|_| ())?))?;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file("library.sqlite3", opts).map_err(|e| AppError::other(e.to_string()))?;
        z.write_all(&std::fs::read(&snap)?)?;
        for sub in ["covers", "card-media"] {
            let dir = data_dir.join(sub);
            if !dir.is_dir() { continue; }
            for e in std::fs::read_dir(dir)?.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                z.start_file(format!("{sub}/{name}"), zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).map_err(|e| AppError::other(e.to_string()))?;
                z.write_all(&std::fs::read(e.path())?)?;
            }
        }
        z.finish().map_err(|e| AppError::other(e.to_string()))?;
    }
    let _ = std::fs::remove_file(&snap);
    let name = format!("LocalLib-backup-{}.zip", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    Ok((name, buf.into_inner()))
}

pub async fn backup(db: &Db, data_dir: &Path, target: &Store, keep: usize) -> AppResult<String> {
    let (name, bytes) = build_zip(db, data_dir)?;
    target.put(&format!("backups/{name}"), bytes).await?;
    let mut all: Vec<String> = target.list("backups").await?.into_iter().filter(|n| n.starts_with("LocalLib-backup-") && n.ends_with(".zip")).collect();
    all.sort();
    if all.len() > keep {
        for old in &all[..all.len() - keep] {
            target.delete(&format!("backups/{old}")).await?;
        }
    }
    Ok(name)
}

pub async fn list(target: &Store) -> AppResult<Vec<String>> {
    let mut all: Vec<String> = target.list("backups").await?.into_iter().filter(|n| n.ends_with(".zip")).collect();
    all.sort();
    all.reverse();
    Ok(all)
}

/// Download + verify a backup and stage it; it's applied by `apply_pending_restore` on next launch.
pub async fn stage_restore(target: &Store, name: &str, data_dir: &Path) -> AppResult<()> {
    let bytes = target.get(&format!("backups/{name}")).await?.ok_or_else(|| AppError::NotFound(name.into()))?;
    let stage = data_dir.join("restore-pending");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(stage.join("covers"))?;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| AppError::other(e.to_string()))?;
    let mut has_db = false;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| AppError::other(e.to_string()))?;
        let Some(name) = f.enclosed_name() else { continue }; // refuses path traversal
        let out = stage.join(name);
        if let Some(d) = out.parent() { std::fs::create_dir_all(d)?; }
        let mut v = vec![];
        f.read_to_end(&mut v)?;
        if out.file_name().map_or(false, |n| n == "library.sqlite3") {
            // sanity: must be an SQLite database
            if !v.starts_with(b"SQLite format 3\0") { return Err(AppError::other("backup does not contain a valid database")); }
            has_db = true;
        }
        std::fs::write(out, v)?;
    }
    if !has_db { return Err(AppError::other("backup has no library.sqlite3")); }
    Ok(())
}

/// Called at startup before opening the DB.
pub fn apply_pending_restore(data_dir: &Path) {
    let stage = data_dir.join("restore-pending");
    let staged_db = stage.join("library.sqlite3");
    if !staged_db.exists() { return; }
    let live = data_dir.join("library.sqlite3");
    let keep = data_dir.join(format!("library.before-restore-{}.sqlite3", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let _ = std::fs::rename(&live, &keep);
    for ext in ["-wal", "-shm"] { let _ = std::fs::remove_file(PathBuf::from(format!("{}{ext}", live.display()))); }
    if std::fs::rename(&staged_db, &live).is_ok() {
        for sub in ["covers", "card-media"] {
            if !stage.join(sub).is_dir() { continue; }
            let dir = data_dir.join(sub);
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::rename(stage.join(sub), &dir);
        }
        eprintln!("[Backup] restored; previous database kept at {}", keep.display());
    }
    let _ = std::fs::remove_dir_all(&stage);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_restore_roundtrip() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let data = tempfile::tempdir().unwrap();
            let remote = tempfile::tempdir().unwrap();
            let db = Db::open(&data.path().join("library.sqlite3")).unwrap();
            db.with(|c| crate::library::store::insert_book(c, "Kept", &[], None).map(|_| ())).unwrap();
            std::fs::create_dir_all(data.path().join("covers")).unwrap();
            std::fs::write(data.path().join("covers/1.jpg"), b"jpg").unwrap();
            let target = Store::plain(Target::Folder { path: remote.path().to_string_lossy().to_string() });
            for _ in 0..3 { backup(&db, data.path(), &target, 2).await.unwrap(); std::thread::sleep(std::time::Duration::from_millis(1100)); }
            let names = list(&target).await.unwrap();
            assert_eq!(names.len(), 2, "pruned to keep=2");
            db.with(|c| Ok(c.execute("DELETE FROM books", []).map(|_| ())?)).unwrap();
            drop(db);
            stage_restore(&target, &names[0], data.path()).await.unwrap();
            apply_pending_restore(data.path());
            let db = Db::open(&data.path().join("library.sqlite3")).unwrap();
            let n: i64 = db.with(|c| Ok(c.query_row("SELECT count(*) FROM books", [], |r| r.get(0))?)).unwrap();
            assert_eq!(n, 1);
            assert!(data.path().join("covers/1.jpg").exists());
        });
    }
}
