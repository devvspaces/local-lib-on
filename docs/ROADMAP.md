# Roadmap

What's shipped is in the README. Below is what's next, each with a short design so it can be picked up directly.

## Writing and citing
- **Live Word / LibreOffice / Google Docs citation fields** (phase 2 of cite-while-you-write). Implement the Zotero word-processor integration protocol (`/connector/document/execCommand` / `respond` over the local connector) so the official Zotero Word and LibreOffice plugins work against Local Lib. Citations then become live fields that re-render when the style changes, and the bibliography updates automatically. Today's palette copies or pastes static text.
- **Signed browser extension** in the Chrome Web Store and Firefox Add-ons, with auto-detected Local Lib pairing instead of pasting a token.
- **Citation key and Better-BibTeX-style auto-export:** keep a `.bib` file in sync for LaTeX projects.

## Sync
- **Incremental ops log.** Replace each device's full `state.json` with append-only change files once libraries grow very large (more than 50k annotations). The current merge logic and tombstones already support it.
- **Hardcover / Goodreads-style reading-status export**, and KOReader *highlight* import (from its `.sdr` sidecar files).
- **iCloud native (CloudKit)** for zero-setup Apple sync.

## Reader
- **Handwriting:** stylus pressure and palm rejection for ink, plus handwritten-note pages in the notebook. Pairs with an iPad build.
- **Embedded media** (sound and movie annotations) and PDF attachments panel.
- **More formats:** XPS, PostScript (ghostscript-wasm), CHM, RTF; DjVu annotation export.
- **Word-level Vision OCR boxes** (the current bindings give line boxes that are split proportionally); handwriting recognition for ink notes.
- **Synced scrolling by content** for translations (align by paragraph rather than page delta).

## Learning and AI
- **Occlusion from EPUB images** (today: PDF area selection) and polygon masks.
- **Voice questions in other languages** (multilingual Moonshine/Whisper models) and a hands-free wake word.
- **Audiobook:** per-chapter voices (dialogue), pronunciation dictionary, and DjVu/scan support via OCR text.

## Platforms
- **Mobile** (Tauri 2 mobile: iOS/iPadOS and Android), sharing the Rust core and SQLite, with folder or WebDAV sync as the bridge.
- **Apple notarization:** add Developer ID secrets so macOS builds open without `xattr` (the release workflow already supports it; see docs/RELEASING.md). Windows code signing (Azure Trusted Signing) and Linux ARM64 builds.
- **Zotero import:** one-way import of `zotero.sqlite` (declined for now; revisit later).
