// Renders an image-occlusion card in review (and as a thumbnail in the cards list).
import { useEffect, useState } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { fileUrl } from "@/lib/api";
import { visibleMasks, type OcclusionMedia } from "@/lib/cards";
import { cn } from "@/lib/utils";

let mediaDir: Promise<string> | null = null;
const cardImageUrl = async (name: string) => { mediaDir ??= appDataDir().then((d) => join(d, "card-media")); return fileUrl(await join(await mediaDir, name)); };

export function OcclusionView({ media, revealed, thumb }: { media: OcclusionMedia; revealed: boolean; thumb?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { cardImageUrl(media.image).then(setSrc); }, [media.image]);
  if (!src) return <div className={thumb ? "h-8 w-12 rounded bg-secondary" : "h-48 rounded bg-secondary"} />;
  return (
    <div className={cn("relative mx-auto w-fit overflow-hidden rounded border bg-white", thumb && "h-8")}>
      <img src={src} alt="Diagram" className={thumb ? "h-8 w-auto" : "block max-h-[55vh] max-w-full"} draggable={false} />
      {visibleMasks(media, revealed).map(({ r, i, target, hidden }) => (
        <div key={i} className={cn("absolute", hidden ? (target ? "bg-orange-500" : "bg-slate-500") : "border-2 border-orange-500")} style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}>
          {hidden && target && !thumb && <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white">?</span>}
        </div>
      ))}
    </div>
  );
}
