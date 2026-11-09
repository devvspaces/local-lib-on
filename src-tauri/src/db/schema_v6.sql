-- Semantic search: text chunks with embedding vectors (little-endian f32 BLOB).
CREATE TABLE chunks (
  id      INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  loc     TEXT NOT NULL,
  text    TEXT NOT NULL,
  model   TEXT NOT NULL,
  dim     INTEGER NOT NULL,
  vec     BLOB NOT NULL
);
CREATE INDEX chunks_book ON chunks(book_id);
CREATE INDEX chunks_model ON chunks(model);
-- Which (book, model) pairs are fully embedded.
CREATE TABLE chunk_state (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  model   TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (book_id, model)
);
-- Cached AI summaries (chapter / whole book).
CREATE TABLE summaries (
  id         INTEGER PRIMARY KEY,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,      -- "chapter:<index>" | "book"
  title      TEXT NOT NULL,
  text       TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (book_id, scope)
);
