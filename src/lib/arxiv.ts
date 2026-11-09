import type { LookupResult } from "@/lib/metadataLookup";
import { providers } from "@/lib/providers";

/** arXiv metadata via the Rust provider (no CORS issues). */
export async function fetchArxiv(id: string): Promise<LookupResult & { pdfUrl: string }> {
  const b = await providers.details("arxiv", id);
  return {
    title: b.title,
    authors: b.authors.map((a) => a.name),
    year: b.year ?? undefined,
    description: b.description ?? undefined,
    doi: b.doi ?? undefined,
    publisher: "arXiv",
    pdfUrl: b.files[0]?.url ?? `https://arxiv.org/pdf/${id}`,
  };
}
