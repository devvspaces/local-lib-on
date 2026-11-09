# Local Lib

A fast, local-first desktop library and professional reader for PDFs and ebooks. It's built with Tauri 2, React 19 and Rust, using the same stack as coursera-dl-gui.

Your books stay where they are on disk. Local Lib indexes them, extracts real metadata and covers, remembers where you stopped, and gives you a reader you can do real study and research in.

## Features

### Library (Zotero-style organizing)
- **Watched folders.** Files are indexed where they are. New, moved and deleted files are picked up automatically, and duplicates are detected by content hash.
- **Automatic metadata and covers.** Metadata comes from embedded PDF/EPUB data, the ISBNs and DOIs and copyright page inside the book, and Crossref / Open Library / Google Books. It includes authors, edition, publisher, place, pages and every ISBN. Your manual edits are never overwritten.
- **Organizing.** Nested collections, colored tags, smart collections (saved searches) and author pages. Grid and list views, plus a "Continue reading" shelf.
- **Add by identifier.** Paste an ISBN, DOI or arXiv ID to create a reference entry.
- **Citations.** Any of 2,800+ official CSL styles (citeproc-js, fetched on demand and cached), with five built-in styles that work offline. Export BibTeX, RIS, CSL-JSON or a formatted bibliography (rich text for Word or Docs).
- **Cite while you write.** A global hotkey (⌥⌘C) opens a cite palette in any app. It copies or pastes the in-text citation and collects a bibliography basket.
- **Browser extension** (`extension/`). One click saves the paper or book you're viewing: it reads DOI, arXiv, ISBN and citation tags, downloads open-access PDFs, and lets you pick a collection. An optional Zotero-compatible mode lets the official Zotero Connector save into Local Lib.

### Reader (Okular / Readest-style)
- **Formats.** PDF (pdf.js); EPUB, MOBI/AZW3, FB2, CBZ and TXT/MD (foliate-js); DjVu (DjVu.js, with its text layer); Word DOCX and OpenDocument ODT (converted to EPUB in memory).
- **Remembers where you stopped:** page and offset, or EPUB CFI. Zoom, view mode, crop, theme and typography are remembered per book.
- **Side panels:** contents, thumbnails (filter by annotated or bookmarked), annotations, bookmarks, and find in document.
- **Selection modes:** text, area (copy as an image or text), and table (copy as TSV or Markdown). Also a magnifier and a hand tool.
- **Annotations:** highlight, underline, squiggly, strike-out, pop-up notes, text boxes, freehand ink, lines and arrows, rectangles and ellipses, and stamps. Colors have meanings (color-coding), and each annotation can carry tags and a comment.
- **PDF layout:** reflow into a single readable column (column-aware), auto-crop or manual crop of margins (odd/even pages), rotation, facing pages, and dark or sepia pages.
- **Split view:** a notebook, dictionary + Wikipedia, the AI assistant, or a second book side by side with linked paging.
- **Read aloud:** natural offline voices (Kokoro-82M and Piper via sherpa-onnx, downloaded on demand, nothing sent anywhere) or macOS system and Premium voices. Sentences are highlighted, and the next one is prepared while the current one plays, so there are no gaps.
- **Audiobook export:** any chapters, or the whole book, become an M4B audiobook read by the natural voices. It has chapter markers, title, author and cover, so it plays in Apple Books, QuickTime and podcast apps. Rendering runs in the background; progress and cancel are in Downloads.
- **Voice questions while listening:** hold ⌥⇧Space (or tap 🎙) and ask. Reading pauses, the answer is spoken in the same voice, then reading continues. Speech is recognized offline (Moonshine or Whisper via sherpa-onnx).
- **OCR for scanned PDFs:** Apple Vision on macOS (fast and accurate, 30 languages), or tesseract.js everywhere, with 25 languages downloaded on demand. Fully offline. Scans then support search, selection, highlighting and read-aloud.
- **PDF power features:**
  - Save an annotated copy with standard PDF annotations, so Preview, Acrobat and Zotero show them.
  - Annotations already in a PDF are imported automatically.
  - Fill PDF forms and save a filled copy.
  - Presentation mode with laser pointer and blackout.

### Notes and research
- **Markdown notebook.** Use it per book or globally. Drag in a highlight to create a quote with a back-link that jumps to the source.
- **Export:** Markdown (Obsidian-friendly, YAML front matter), Word `.docx` (highlight colors kept), plain text, BibTeX, RIS and CSL-JSON.
- **Library-wide full-text search** with SQLite FTS5. It supports phrases, AND/OR and NEAR, and hits open on the right page with the term highlighted.
- **Flashcards.** Spaced repetition (FSRS) from highlights, either as auto or manual clozes or with your comment as the question. Cards also come from Q:/A: notes and AI suggestions. Daily review queue, review goals and Anki export.
- **Image-occlusion cards:** select a diagram with the area tool, then **Occlusion cards**. Box the labels to learn, in hide-one or hide-all mode. The images sync and are included in backups.
- **AI assistant (bring your own key).** Use Claude (Anthropic API), Google Gemini (AI Studio key) or any OpenAI-compatible endpoint, including local Ollama or LM Studio.
  - **Research mode:** the assistant searches your library, reads pages and checks your highlights itself, then cites [book:page] links that open the reader. Proposed notes and flashcards are saved only when you confirm.
  - **Semantic search** ("Meaning") with local or Gemini embeddings, fused with keyword search.
  - **Chapter summaries:** "Summarize chapter" in the Contents panel (PDF, EPUB, DOCX…), cached in the Notebook.
  - **Book overview:** combines the chapter summaries (making only the missing ones) into a thesis, key ideas, a chapter-by-chapter outline and questions. Answers cite numbered passages from your books, and a citation jumps to that page. Keys are stored in the macOS Keychain.

### Discover, sync and downloads
- **Built-in sources:** Open Library + Internet Archive (search inside books), Project Gutenberg and arXiv.
- **Your own sources:** any OPDS catalog (e.g. Standard Ebooks, your Calibre server) and GitHub sources (repos that contain book files, or awesome-lists such as free-programming-books).
- **Sync.** A saved query (an author, topic or repo) lists everything you don't have yet. Download the missing items in one click.
- **Downloads:** a queue with resume, pause and retry. Finished books are auto-imported with the provider's metadata and cover.

### Sync & backup
- **Sync across devices** through a cloud folder (iCloud Drive, Dropbox, Google Drive, OneDrive), direct Dropbox/OneDrive/Google Drive sign-in ([setup](docs/cloud-setup.md)) or WebDAV. Optional end-to-end encryption (Argon2id + XChaCha20-Poly1305). It covers notes, highlights, progress, collections, tags, flashcards and reviews, and optionally the book files themselves (stored once by content hash).
- **Conflicts:** last-writer-wins per item, with deletions propagated. If a note is edited on two devices, both versions are kept.
- **Backups:** daily or on-demand zipped snapshots with pruning, plus one-click restore. The previous database is kept on restore.

### Integrations
- **KOReader** progress sync (kosync protocol; your own server or KOReader's). It asks "Continue from your Kobo at 63%?" when the e-reader is ahead.
- **Readwise:** send highlights, notes and tags; already-sent ones are skipped.

### Reading habits
- **Goals:** minutes or hours per day or week, pages per day, books per year.
- **Study plans:** pick books and a finish date (or minutes a day). You get daily assignments that follow the chapters, with review days. "Today" appears on the Reading tab and the library home, missed days roll forward, and optional AI adds focus questions. Plans sync.
- **Tracking:** streaks, a yearly heatmap, time per book and an estimated time left.
- **Reminders:** reading schedules with native notifications, plus an evening nudge if the daily goal isn't met.

## Install

Download the latest build for macOS (Apple Silicon or Intel), Windows or Linux from
[Releases](https://github.com/devvspaces/local-lib-on/releases). The app updates itself after that (Settings → Library → About & updates).

macOS builds aren't notarized yet, so after moving the app to Applications, run once:

```sh
xattr -cr "/Applications/Local Lib.app"
```

On Windows and Linux, audiobook export needs `ffmpeg` (`winget install ffmpeg`, or your package manager).

## Development

```bash
bun install          # also copies pdf.js + tesseract assets into public/
bun tauri dev        # run the app
bun run build        # typecheck + production frontend build
bunx vitest run      # frontend unit tests
cd src-tauri && cargo test --lib                    # backend unit tests
cd src-tauri && cargo test live_ -- --ignored --nocapture   # live provider checks (network)
```

### Where data lives
- **Library database:** `~/Library/Application Support/com.locallib.app/library.sqlite3`. Holds books, notes, annotations, the FTS index, OCR text and stats.
- **Covers:** `…/com.locallib.app/covers/`.
- **Downloads:** `~/Books/Local Lib/` by default; change it on the Downloads screen.
- **Your book files are never modified.**

### Architecture
- **`src-tauri/src/`** (Rust):
  - `library/`: scanning, watcher, store
  - `providers/`: Open Library, Gutenberg, arXiv, OPDS, GitHub
  - `downloads.rs`, `sync.rs` (provider sync), `reading.rs` (progress, annotations, notes, FTS), `tracker.rs`, `ocr.rs`, `llm.rs`
  - `cards.rs`, `csl.rs`, `connector.rs`, `cloudsync.rs` + `storage.rs` + `backup.rs` + `cloud.rs` + `crypto.rs` (device sync, cloud and encryption, backups)
  - `agent.rs` (tool-using assistant), `embeddings.rs`, `tts.rs` (sherpa-onnx), `ocr_vision.rs` (Apple Vision), `integrations.rs` (KOReader, Readwise)
- **`src/`** (React):
  - `views/`: library, discover, sync, downloads, search, notebook, stats, settings
  - `reader/`: `pdf/` (pdf.js engine, layout analysis), `foliate/`, panels, panes, tts
  - `lib/`: api, enrichment, citations, export, indexer, assistant

## License
GPL-3.0-or-later (see `LICENSE`). DjVu support bundles DjVu.js (GPL-2.0-or-later, `public/djvu/LICENSE.md`).

The browser extension lives in [`extension/`](extension/README.md).

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.
