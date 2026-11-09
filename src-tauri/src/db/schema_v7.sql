-- Image-occlusion flashcards and study plans.
ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'basic';   -- basic | occlusion
ALTER TABLE cards ADD COLUMN media TEXT;                           -- JSON {image, w, h, masks, target, mode}

CREATE TABLE study_plans (
  id         TEXT PRIMARY KEY,                -- uuid (synced)
  title      TEXT NOT NULL,
  settings   TEXT NOT NULL DEFAULT '{}',      -- JSON: books, budget, weekdays…
  days       TEXT NOT NULL DEFAULT '[]',      -- JSON [{date, book_id, kind, unit, from, to, label, minutes, focus, done_at}]
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER t_plans AFTER DELETE ON study_plans BEGIN INSERT OR REPLACE INTO tombstones VALUES ('study_plans', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
