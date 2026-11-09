-- Richer bibliographic fields (Zotero parity)
ALTER TABLE books ADD COLUMN edition TEXT;
ALTER TABLE books ADD COLUMN place TEXT;
ALTER TABLE books ADD COLUMN num_pages INTEGER;
ALTER TABLE books ADD COLUMN item_type TEXT NOT NULL DEFAULT 'book';
ALTER TABLE books ADD COLUMN short_title TEXT;
ALTER TABLE books ADD COLUMN metadata_source TEXT;

-- OCR results for scanned PDFs
CREATE TABLE ocr_pages (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page    INTEGER NOT NULL,
  words   TEXT NOT NULL,   -- JSON [[x0,y0,x1,y1,"word"], ...] in PDF points
  text    TEXT NOT NULL,
  PRIMARY KEY (book_id, page)
);

-- Reading goals, schedules, reminders
CREATE TABLE goals (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL,     -- daily_minutes | weekly_minutes | yearly_books | daily_pages
  target INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE schedules (
  id       INTEGER PRIMARY KEY,
  label    TEXT NOT NULL DEFAULT '',
  weekdays INTEGER NOT NULL DEFAULT 127,  -- bit 0 = Monday … bit 6 = Sunday
  time     TEXT NOT NULL,                 -- HH:MM local
  book_id  INTEGER REFERENCES books(id) ON DELETE SET NULL,
  minutes  INTEGER NOT NULL DEFAULT 30,
  enabled  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE reminders_log (
  key     TEXT PRIMARY KEY,   -- e.g. "schedule:3:2026-11-07" / "nudge:2026-11-07"
  sent_at TEXT NOT NULL
);
ALTER TABLE reading_sessions ADD COLUMN pages INTEGER;
