CREATE TABLE books (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  authors       TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  year          INTEGER,
  language      TEXT,
  publisher     TEXT,
  isbn          TEXT,
  doi           TEXT,
  series        TEXT,
  series_index  REAL,
  description   TEXT,
  cover_path    TEXT,
  rating        INTEGER,
  status        TEXT NOT NULL DEFAULT 'unread', -- unread | reading | finished
  favorite      INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_opened_at TEXT
);

CREATE TABLE files (
  id       INTEGER PRIMARY KEY,
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  path     TEXT NOT NULL UNIQUE,
  format   TEXT NOT NULL,
  size     INTEGER NOT NULL DEFAULT 0,
  hash     TEXT,
  mtime    INTEGER,
  missing  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX files_book ON files(book_id);
CREATE INDEX files_hash ON files(hash);

CREATE TABLE identifiers (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scheme  TEXT NOT NULL,   -- isbn | doi | arxiv | openlibrary | gutenberg | ...
  value   TEXT NOT NULL,
  PRIMARY KEY (scheme, value, book_id)
);
CREATE INDEX identifiers_book ON identifiers(book_id);

CREATE TABLE collections (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE book_collections (
  book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, collection_id)
);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);
CREATE TABLE book_tags (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

CREATE TABLE saved_searches (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  filter TEXT NOT NULL   -- JSON LibraryFilter
);

CREATE TABLE progress (
  book_id    INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  locator    TEXT,           -- JSON: {page, offset} for PDF, {cfi} for reflowable
  percent    REAL NOT NULL DEFAULT 0,
  settings   TEXT,           -- JSON: zoom, view mode, crop, reflow, theme overrides
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE reading_sessions (
  id        INTEGER PRIMARY KEY,
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at   TEXT NOT NULL,
  seconds    INTEGER NOT NULL,
  start_percent REAL,
  end_percent   REAL
);

CREATE TABLE annotations (
  id         TEXT PRIMARY KEY,          -- uuid
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,             -- highlight | underline | strike | squiggly | note | text | ink | line | arrow | rect | ellipse | stamp | area
  color      TEXT,
  anchor     TEXT NOT NULL,             -- JSON (page+rects in PDF space | cfi)
  page_label TEXT,
  text       TEXT,                      -- selected text
  comment    TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  style      TEXT,                      -- JSON (opacity, width, ink paths…)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX annotations_book ON annotations(book_id);

CREATE TABLE bookmarks (
  id         TEXT PRIMARY KEY,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  locator    TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX bookmarks_book ON bookmarks(book_id);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  book_id    INTEGER REFERENCES books(id) ON DELETE CASCADE,  -- NULL = global notebook
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',  -- markdown
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE note_links (
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, annotation_id)
);

CREATE VIRTUAL TABLE fts_pages USING fts5(text, book_id UNINDEXED, loc UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE fts_state (
  book_id   INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  indexed_at TEXT NOT NULL,
  units     INTEGER NOT NULL
);

CREATE TABLE watch_folders (
  path TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE saved_queries (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  query      TEXT NOT NULL,   -- JSON Query
  last_run   TEXT,
  last_result TEXT            -- JSON cached SyncResult
);
CREATE TABLE sync_ignored (
  provider TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  PRIMARY KEY (provider, remote_id)
);

CREATE TABLE downloads (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  remote_id  TEXT NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  format     TEXT NOT NULL,
  dest       TEXT,
  status     TEXT NOT NULL,   -- queued | downloading | paused | completed | failed | cancelled
  bytes      INTEGER NOT NULL DEFAULT 0,
  total      INTEGER,
  error      TEXT,
  meta       TEXT,            -- JSON RemoteBook to apply on import
  book_id    INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
