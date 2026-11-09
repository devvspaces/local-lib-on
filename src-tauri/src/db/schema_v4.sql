-- Flashcards (spaced repetition, FSRS state kept as JSON from ts-fsrs)
CREATE TABLE cards (
  id            TEXT PRIMARY KEY,
  book_id       INTEGER REFERENCES books(id) ON DELETE CASCADE,
  annotation_id TEXT REFERENCES annotations(id) ON DELETE SET NULL,
  front         TEXT NOT NULL,
  back          TEXT NOT NULL DEFAULT '',
  fsrs          TEXT NOT NULL,       -- JSON Card from ts-fsrs
  due           TEXT NOT NULL,       -- ISO time, indexed for the review queue
  is_new        INTEGER NOT NULL DEFAULT 1,
  suspended     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cards_due ON cards(due) WHERE suspended = 0;
CREATE INDEX cards_book ON cards(book_id);
CREATE UNIQUE INDEX cards_annotation ON cards(annotation_id) WHERE annotation_id IS NOT NULL;
CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL,      -- 1 Again · 2 Hard · 3 Good · 4 Easy
  reviewed_at TEXT NOT NULL,
  seconds     INTEGER
);
CREATE INDEX reviews_time ON reviews(reviewed_at);
