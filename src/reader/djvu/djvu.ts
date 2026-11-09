// DjVu decoding via DjVu.js (GPL-2.0-or-later, bundled in public/djvu/ with its license).
// Loaded lazily as a classic script that defines the global `DjVu`.
import { fileUrl } from "@/lib/api";

export interface DjvuZone { x: number; y: number; width: number; height: number; text: string }
export interface DjvuPage {
  getWidth(): number;
  getHeight(): number;
  getDpi(): number;
  getImageData(rotate?: boolean): ImageData;
  getText(): string;
  getNormalizedTextZones(): DjvuZone[] | null;
}
export interface DjvuDoc {
  getPagesQuantity(): number;
  getPage(n: number): Promise<DjvuPage>;
  navm?: { getContents(): { description: string; url: string; children?: unknown[] }[] } | null;
}
interface DjvuGlobal { Document: new (buf: ArrayBuffer) => DjvuDoc }

let loading: Promise<DjvuGlobal> | null = null;
export function loadDjvuLib(): Promise<DjvuGlobal> {
  const g = (window as unknown as { DjVu?: DjvuGlobal }).DjVu;
  if (g) return Promise.resolve(g);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/djvu/djvu.js";
    s.onload = () => resolve((window as unknown as { DjVu: DjvuGlobal }).DjVu);
    s.onerror = () => reject(new Error("Could not load the DjVu decoder"));
    document.head.append(s);
  });
  return loading;
}

export async function openDjvu(path: string): Promise<DjvuDoc> {
  const DjVu = await loadDjvuLib();
  const buf = await (await fetch(fileUrl(path))).arrayBuffer();
  return new DjVu.Document(buf);
}

export interface DjvuToc { label: string; page?: number; children?: DjvuToc[] }
export function djvuToc(doc: DjvuDoc): DjvuToc[] {
  type B = { description: string; url: string; children?: B[] };
  const walk = (items: B[]): DjvuToc[] => items.map((b) => ({ label: b.description, page: Number(b.url?.match(/#(\d+)/)?.[1]) || undefined, children: b.children?.length ? walk(b.children) : undefined }));
  try { return walk((doc.navm?.getContents() ?? []) as B[]); } catch { return []; }
}

/** Page bitmap → canvas (decode is synchronous and CPU-heavy, so pages are decoded on demand). */
export async function pageCanvas(doc: DjvuDoc, n: number) {
  const page = await doc.getPage(n);
  const img = page.getImageData();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return { canvas: c, page };
}

/** DjVu text zones use page pixels with a bottom-left origin; convert to top-left. */
export function zonesTopLeft(zones: DjvuZone[], pageHeight: number) {
  return zones.filter((z) => z.text.trim()).map((z) => ({ x: z.x, y: pageHeight - z.y - z.height, w: z.width, h: z.height, text: z.text }));
}
