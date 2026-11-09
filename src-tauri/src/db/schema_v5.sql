-- Cross-device sync: global identities, updated_at everywhere, tombstones for deletions.
ALTER TABLE books ADD COLUMN uid TEXT;
UPDATE books SET uid = COALESCE((SELECT f.hash FROM files f WHERE f.book_id = books.id AND f.hash IS NOT NULL ORDER BY f.id LIMIT 1), lower(hex(randomblob(16))));
CREATE UNIQUE INDEX books_uid ON books(uid);

ALTER TABLE collections ADD COLUMN uid TEXT;
UPDATE collections SET uid = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX collections_uid ON collections(uid);
ALTER TABLE collections ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

ALTER TABLE bookmarks ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
UPDATE bookmarks SET updated_at = created_at;

CREATE TABLE tombstones (
  tbl        TEXT NOT NULL,
  key        TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (tbl, key)
);
CREATE TABLE sync_cursors (
  device_id TEXT PRIMARY KEY,
  seen_at   TEXT NOT NULL
);

-- New books / collections get a uid automatically.
CREATE TRIGGER books_uid_ins AFTER INSERT ON books WHEN NEW.uid IS NULL
BEGIN UPDATE books SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER collections_uid_ins AFTER INSERT ON collections WHEN NEW.uid IS NULL
BEGIN UPDATE collections SET uid = lower(hex(randomblob(16))), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

-- Tag / collection membership changes count as a change to the book.
CREATE TRIGGER bt_ins AFTER INSERT ON book_tags BEGIN UPDATE books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.book_id; END;
CREATE TRIGGER bt_del AFTER DELETE ON book_tags BEGIN UPDATE books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.book_id; END;
CREATE TRIGGER bc_ins AFTER INSERT ON book_collections BEGIN UPDATE books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.book_id; END;
CREATE TRIGGER bc_del AFTER DELETE ON book_collections BEGIN UPDATE books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.book_id; END;
CREATE TRIGGER col_upd AFTER UPDATE OF name, parent_id ON collections BEGIN UPDATE collections SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER bm_upd AFTER UPDATE OF label, locator ON bookmarks BEGIN UPDATE bookmarks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

-- Deletions → tombstones (also fire for cascaded deletes).
CREATE TRIGGER t_books AFTER DELETE ON books BEGIN INSERT OR REPLACE INTO tombstones VALUES ('books', OLD.uid, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER t_ann AFTER DELETE ON annotations BEGIN INSERT OR REPLACE INTO tombstones VALUES ('annotations', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER t_bm AFTER DELETE ON bookmarks BEGIN INSERT OR REPLACE INTO tombstones VALUES ('bookmarks', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER t_notes AFTER DELETE ON notes BEGIN INSERT OR REPLACE INTO tombstones VALUES ('notes', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER t_cards AFTER DELETE ON cards BEGIN INSERT OR REPLACE INTO tombstones VALUES ('cards', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER t_cols AFTER DELETE ON collections BEGIN INSERT OR REPLACE INTO tombstones VALUES ('collections', OLD.uid, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
-- Re-creating something clears its tombstone.
CREATE TRIGGER t_ann_ins AFTER INSERT ON annotations BEGIN DELETE FROM tombstones WHERE tbl = 'annotations' AND key = NEW.id; END;
CREATE TRIGGER t_notes_ins AFTER INSERT ON notes BEGIN DELETE FROM tombstones WHERE tbl = 'notes' AND key = NEW.id; END;
