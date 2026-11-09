// Background full-text indexer: extracts text from un-indexed books one at a time while the app is idle
// and stores it in SQLite FTS5 (library-wide search across PDFs, EPUBs, etc.).
import { useEffect, useRef } from "react";
import { api, fileUrl, primaryFile } from "@/lib/api";
import { useApp } from "@/store/app";

async function extractPdf(path: string) {
  const { loadPdf, pageText } = await import("@/reader/pdf/pdfjs");
  const doc = await loadPdf(fileUrl(path));
  try {
    const out: { loc: string; text: string }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      out.push({ loc: `p${i}`, text: (await pageText(doc, i)).text });
      if (i % 20 === 0) await idle();
    }
    return out;
  } finally {
    doc.loadingTask.destroy();
  }
}

async function extractDjvu(path: string) {
  const { openDjvu } = await import("@/reader/djvu/djvu");
  const doc = await openDjvu(path);
  const out: { loc: string; text: string }[] = [];
  for (let p = 1; p <= doc.getPagesQuantity(); p++) {
    try { out.push({ loc: `p${p}`, text: (await doc.getPage(p)).getText() ?? "" }); } catch { /* skip */ }
    if (p % 10 === 0) await idle();
  }
  return out;
}

async function extractFoliate(path: string, format: string) {
  if (format === "txt" || format === "md") {
    const text = await (await fetch(fileUrl(path))).text();
    // Chunk plain text so hits point somewhere useful.
    return text.split(/\n{2,}/).reduce<{ loc: string; text: string }[]>((acc, para, i) => {
      const last = acc[acc.length - 1];
      if (last && last.text.length < 4000) last.text += "\n\n" + para;
      else acc.push({ loc: `s${i}`, text: para });
      return acc;
    }, []);
  }
  const { makeBook } = await import("foliate-js/view.js");
  const name = path.split("/").pop() ?? "book";
  const ext = name.split(".").pop()?.toLowerCase();
  let input: File;
  if (ext === "docx" || ext === "odt") {
    const { officeToEpubFile } = await import("@/lib/officeToEpub");
    input = (await officeToEpubFile(await (await fetch(fileUrl(path))).arrayBuffer(), name, ext)).file;
  } else input = new File([await (await fetch(fileUrl(path))).blob()], name);
  const book = await makeBook(input);
  const out: { loc: string; text: string }[] = [];
  for (const [i, s] of (book.sections as { createDocument?: () => Promise<Document> }[]).entries()) {
    if (!s.createDocument) continue;
    try {
      const d = await s.createDocument();
      out.push({ loc: `s${i}`, text: d.body?.textContent?.replace(/\s+/g, " ") ?? "" });
    } catch { /* skip */ }
    if (i % 10 === 0) await idle();
  }
  return out;
}

const idle = () => new Promise<void>((r) => ("requestIdleCallback" in window ? requestIdleCallback(() => r(), { timeout: 500 }) : setTimeout(r, 50)));

export function BackgroundIndexer() {
  const version = useApp((s) => s.libraryVersion);
  const running = useRef(false);
  const enabled = (() => { try { return localStorage.getItem("local-lib-fts") !== "off"; } catch { return true; } })();

  useEffect(() => {
    if (!enabled || running.current) return;
    running.current = true;
    let stop = false;
    (async () => {
      await new Promise((r) => setTimeout(r, 4000)); // let the UI settle first
      const failed = new Set<number>();
      while (!stop) {
        const ids = (await api.unindexedBooks().catch(() => [])).filter((i) => !failed.has(i));
        if (!ids.length) break;
        const id = ids[0];
        try {
          const book = await api.getBook(id);
          const f = primaryFile(book);
          if (!f || f.missing) { failed.add(id); continue; }
          const units = f.format === "pdf" ? await extractPdf(f.path) : f.format === "djvu" ? await extractDjvu(f.path) : await extractFoliate(f.path, f.format);
          // Batches keep each IPC payload modest for 1000-page books.
          for (let i = 0; i < Math.max(1, units.length); i += 100) await api.indexBookText(id, units.slice(i, i + 100), i === 0);
        } catch (e) {
          console.warn("[indexer] failed", id, e);
          failed.add(id);
          await api.indexBookText(id, [], true).catch(() => {}); // mark as attempted so we don't loop
        }
        await idle();
      }
      running.current = false;
    })();
    return () => { stop = true; running.current = false; };
  }, [version, enabled]);
  return null;
}
