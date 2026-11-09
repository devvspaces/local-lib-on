// OCR for scanned PDFs (tesseract.js, fully offline: worker/core/traineddata are served from public/tesseract).
// Recognized words are stored in PDF coordinates, so the reader can lay an invisible text layer over scans
// and every text feature (find, highlight, copy, TTS, reflow, library search) works.
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { PDFDocumentProxy } from "@/reader/pdf/pdfjs";

export type OcrWord = [number, number, number, number, string];
export interface OcrPage { page: number; words: OcrWord[]; text: string }

export const ocrApi = {
  save: (bookId: number, page: OcrPage) => invoke<void>("save_ocr_page", { bookId, page }),
  pages: (bookId: number) => invoke<OcrPage[]>("get_ocr_pages", { bookId }),
};

export type OcrEngine = "auto" | "vision" | "tesseract";
export const ocrPrefs = {
  get(): { engine: OcrEngine; lang: string } {
    try { return { engine: "auto", lang: "eng", ...JSON.parse(localStorage.getItem("local-lib-ocr") ?? "{}") }; } catch { return { engine: "auto", lang: "eng" }; }
  },
  set(p: Partial<{ engine: OcrEngine; lang: string }>) { try { localStorage.setItem("local-lib-ocr", JSON.stringify({ ...ocrPrefs.get(), ...p })); } catch { /* ignore */ } },
};
const isMac = navigator.userAgent.includes("Mac");
export const visionLanguages = () => invoke<string[]>("ocr_vision_languages").catch(() => [] as string[]);

/** Tesseract codes → BCP-47 for Vision. */
const TESS_TO_BCP47: Record<string, string> = { eng: "en-US", fra: "fr-FR", deu: "de-DE", spa: "es-ES", ita: "it-IT", por: "pt-BR", rus: "ru-RU", ukr: "uk-UA", chi_sim: "zh-Hans", chi_tra: "zh-Hant", jpn: "ja-JP", kor: "ko-KR", ara: "ar-SA", tha: "th-TH", vie: "vi-VT", tur: "tr-TR", pol: "pl-PL", nld: "nl-NL", swe: "sv-SE", nor: "nb-NO", dan: "da-DK", ind: "id-ID", msa: "ms-MY", ces: "cs-CZ", ron: "ro-RO" };
export const OCR_LANGS = Object.keys(TESS_TO_BCP47);

interface VisionWord { x0: number; y0: number; x1: number; y1: number; text: string; confidence: number }

export const useOcrJob = create<{ bookId: number | null; done: number; total: number; running: boolean }>(() => ({ bookId: null, done: 0, total: 0, running: false }));
let cancelFlag = false;
export const cancelOcr = () => { cancelFlag = true; };

/** Fraction of sampled pages that have (almost) no text layer. */
export async function scannedRatio(doc: PDFDocumentProxy, pageText: (d: PDFDocumentProxy, p: number) => Promise<{ text: string }>) {
  const n = doc.numPages;
  const sample = [...new Set([1, 2, 3, Math.ceil(n / 4), Math.ceil(n / 2), Math.ceil((3 * n) / 4), n].filter((p) => p >= 1 && p <= n))];
  let empty = 0;
  for (const p of sample) if ((await pageText(doc, p)).text.replace(/\s/g, "").length < 20) empty++;
  return empty / sample.length;
}

/** Convert tesseract word boxes (canvas px at `scale`) into PDF user-space rects. */
export function wordsToPdf(words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }[], toPdf: (x: number, y: number) => [number, number]): OcrWord[] {
  return words
    .filter((w) => w.text.trim() && w.confidence > 30)
    .map((w) => {
      const [ax, ay] = toPdf(w.bbox.x0, w.bbox.y0);
      const [bx, by] = toPdf(w.bbox.x1, w.bbox.y1);
      return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), w.text] as OcrWord;
    });
}

/** Render a page to an opaque canvas (white background — recognizers misread text on transparency). */
async function renderForOcr(doc: PDFDocumentProxy, p: number, scale: number) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp, background: "#ffffff" } as Parameters<typeof page.render>[0]).promise;
  return { canvas, vp };
}

async function tesseractWorker(lang: string) {
  const { createWorker } = await import("tesseract.js");
  const base = new URL("/tesseract/", window.location.href).href;
  let langPath = `${base}lang`;
  if (lang !== "eng") {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    langPath = convertFileSrc(await invoke<string>("tesseract_lang", { lang }));
  }
  return createWorker(lang, 1, { workerPath: `${base}worker.min.js`, corePath: `${base}core`, langPath, gzip: true, workerBlobURL: false });
}

export async function ocrBook(bookId: number, doc: PDFDocumentProxy, onPage: (p: OcrPage) => void, opts: { pages?: number[]; lang?: string } = {}) {
  const { pageText } = await import("@/reader/pdf/pdfjs");
  const prefs = ocrPrefs.get();
  const lang = opts.lang ?? prefs.lang;
  const useVision = isMac && prefs.engine !== "tesseract";
  let worker: Awaited<ReturnType<typeof tesseractWorker>> | null = useVision ? null : await tesseractWorker(lang);
  cancelFlag = false;
  const done = new Set((await ocrApi.pages(bookId)).map((p) => p.page));
  const todo: number[] = [];
  for (const p of opts.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)) {
    if (done.has(p)) continue;
    if ((await pageText(doc, p, true)).text.replace(/\s/g, "").length >= 20) continue; // has a real text layer
    todo.push(p);
  }
  useOcrJob.setState({ bookId, done: 0, total: todo.length, running: true });
  try {
    for (const [i, p] of todo.entries()) {
      if (cancelFlag) break;
      const { canvas, vp } = await renderForOcr(doc, p, 2.2);
      let res: OcrPage | null = null;
      if (!worker) {
        try {
          const b64 = canvas.toDataURL("image/png");
          const vw = await invoke<VisionWord[]>("ocr_vision", { pngBase64: b64, languages: [TESS_TO_BCP47[lang] ?? "en-US"], fast: false });
          const W = canvas.width, H = canvas.height;
          const words = wordsToPdf(vw.map((w) => ({ text: w.text, confidence: w.confidence * 100, bbox: { x0: w.x0 * W, y0: w.y0 * H, x1: w.x1 * W, y1: w.y1 * H } })), (x, y) => vp.convertToPdfPoint(x, y) as [number, number]);
          res = { page: p, words, text: visionText(vw) };
        } catch (e) {
          console.warn("[ocr] Vision failed, falling back to Tesseract", e);
          worker = await tesseractWorker(lang);
        }
      }
      if (!res) {
        const { data } = await worker!.recognize(canvas, {}, { blocks: true, text: true });
        const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((pa) => pa.lines.flatMap((l) => l.words)));
        res = { page: p, words: wordsToPdf(words, (x, y) => vp.convertToPdfPoint(x, y) as [number, number]), text: data.text };
      }
      await ocrApi.save(bookId, res);
      onPage(res);
      useOcrJob.setState({ done: i + 1 });
    }
  } finally {
    await worker?.terminate();
    useOcrJob.setState({ running: false });
  }
}

/** Reading-order text from Vision words (lines top→bottom, words left→right). */
export function visionText(words: { x0: number; y0: number; text: string }[]) {
  const lines: { y: number; ws: { x0: number; text: string }[] }[] = [];
  for (const w of [...words].sort((a, b) => a.y0 - b.y0)) {
    const l = lines.find((L) => Math.abs(L.y - w.y0) < 0.006);
    if (l) l.ws.push(w); else lines.push({ y: w.y0, ws: [w] });
  }
  return lines.map((l) => l.ws.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(" ")).join("\n");
}
