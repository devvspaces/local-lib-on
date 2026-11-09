//! Filesystem watcher for library folders. Debounces events and re-imports touched files.
use super::scan;
use crate::db::Db;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct LibraryWatcher {
    inner: Mutex<Option<RecommendedWatcher>>,
}

impl LibraryWatcher {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// (Re)start watching all configured folders.
    pub fn restart(&self, app: AppHandle, db: Db) {
        let folders = scan::watch_folders(&db).unwrap_or_default();
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[Watcher] failed to create watcher: {e}");
                return;
            }
        };
        for f in &folders {
            if let Err(e) = watcher.watch(f, RecursiveMode::Recursive) {
                eprintln!("[Watcher] cannot watch {}: {e}", f.display());
            }
        }
        *self.inner.lock().unwrap() = Some(watcher);

        std::thread::spawn(move || {
            let mut pending: HashSet<PathBuf> = HashSet::new();
            loop {
                match rx.recv_timeout(Duration::from_millis(1500)) {
                    Ok(Ok(ev)) => pending.extend(ev.paths),
                    Ok(Err(_)) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if pending.is_empty() {
                            continue;
                        }
                        let mut changed = false;
                        for p in pending.drain() {
                            if p.is_file() {
                                if let Ok(Some(o)) = scan::import_file(&db, &p) {
                                    changed |= !matches!(o, scan::ImportOutcome::Unchanged(_));
                                }
                            } else {
                                changed = true; // removal / rename source
                            }
                        }
                        let _ = scan::mark_missing(&db);
                        if changed {
                            let _ = app.emit("library_changed", ());
                        }
                    }
                    // sender dropped → watcher replaced
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    }
}
