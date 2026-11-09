import { getStroke } from "perfect-freehand";
import type { PageViewport } from "pdfjs-dist";
import type { Annotation } from "@/lib/api";
import { toViewport, pointToViewport, type Rect } from "./geometry";
import { MessageSquare } from "lucide-react";

export function strokePath(points: [number, number][], size: number): string {
  const s = getStroke(points, { size, thinning: 0.35, smoothing: 0.6, streamline: 0.5 });
  if (!s.length) return "";
  const d = s.reduce((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length];
    acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    return acc;
  }, ["M", ...s[0], "Q"] as (string | number)[]);
  d.push("Z");
  return d.join(" ");
}

function squiggle(x1: number, x2: number, y: number, amp: number) {
  const step = Math.max(amp * 2, 3);
  let d = `M ${x1} ${y}`;
  for (let x = x1, up = true; x < x2; x += step, up = !up) d += ` Q ${x + step / 2} ${y + (up ? -amp : amp)} ${Math.min(x + step, x2)} ${y}`;
  return d;
}

/** SVG overlay drawing stored annotations for one page, in viewport coordinates. */
export function AnnotationLayer({ vp, annotations, selectedId, draft }: {
  vp: PageViewport; annotations: Annotation[]; selectedId?: string | null; draft?: React.ReactNode;
}) {
  const scale = vp.scale;
  return (
    <svg className="pointer-events-none absolute inset-0 z-[3]" width={vp.width} height={vp.height} style={{ mixBlendMode: "normal" }}>
      {annotations.map((a) => {
        if (!("page" in a.anchor)) return null;
        const color = a.color ?? "#ffd400";
        const rects = (a.anchor.rects ?? []).map((r) => toViewport(vp, r as Rect));
        const sel = a.id === selectedId;
        const opacity = a.style?.opacity ?? 1;
        const width = (a.style?.width ?? 2) * scale;
        switch (a.kind) {
          case "highlight":
            return (
              <g key={a.id} style={{ mixBlendMode: "multiply" }} opacity={opacity}>
                {rects.map((r, i) => <rect key={i} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill={color} fillOpacity={0.42} rx={1.5} stroke={sel ? color : "none"} strokeWidth={sel ? 1.5 : 0} />)}
              </g>
            );
          case "underline":
            return <g key={a.id}>{rects.map((r, i) => <line key={i} x1={r[0]} x2={r[2]} y1={r[3] - 0.5} y2={r[3] - 0.5} stroke={color} strokeWidth={Math.max(1.2, scale * 1.1)} />)}</g>;
          case "strike":
            return <g key={a.id}>{rects.map((r, i) => <line key={i} x1={r[0]} x2={r[2]} y1={(r[1] + r[3]) / 2} y2={(r[1] + r[3]) / 2} stroke={color} strokeWidth={Math.max(1.2, scale * 1.1)} />)}</g>;
          case "squiggly":
            return <g key={a.id}>{rects.map((r, i) => <path key={i} d={squiggle(r[0], r[2], r[3] - 1, Math.max(1, scale * 1.2))} stroke={color} fill="none" strokeWidth={Math.max(1, scale)} />)}</g>;
          case "area":
            return <g key={a.id}>{rects.map((r, i) => <rect key={i} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill={color} fillOpacity={0.08} stroke={color} strokeWidth={1.5} strokeDasharray="5 3" />)}</g>;
          case "rect":
            return <g key={a.id}>{rects.map((r, i) => <rect key={i} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill="none" stroke={color} strokeWidth={width} opacity={opacity} />)}</g>;
          case "ellipse":
            return <g key={a.id}>{rects.map((r, i) => <ellipse key={i} cx={(r[0] + r[2]) / 2} cy={(r[1] + r[3]) / 2} rx={(r[2] - r[0]) / 2} ry={(r[3] - r[1]) / 2} fill="none" stroke={color} strokeWidth={width} opacity={opacity} />)}</g>;
          case "line":
          case "arrow": {
            const pts = (a.anchor.points ?? []).map(([x, y]) => pointToViewport(vp, x, y));
            if (pts.length < 2) return null;
            const [[x1, y1], [x2, y2]] = pts;
            const ang = Math.atan2(y2 - y1, x2 - x1);
            const head = Math.max(8, width * 4);
            return (
              <g key={a.id} stroke={color} strokeWidth={width} strokeLinecap="round" opacity={opacity}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} />
                {a.kind === "arrow" && (
                  <path fill="none" d={`M ${x2 - head * Math.cos(ang - 0.45)} ${y2 - head * Math.sin(ang - 0.45)} L ${x2} ${y2} L ${x2 - head * Math.cos(ang + 0.45)} ${y2 - head * Math.sin(ang + 0.45)}`} />
                )}
              </g>
            );
          }
          case "ink": {
            const paths = a.anchor.paths ?? [];
            return (
              <g key={a.id} fill={color} opacity={opacity}>
                {paths.map((p, i) => <path key={i} d={strokePath(p.map(([x, y]) => pointToViewport(vp, x, y)), width * 1.6)} />)}
              </g>
            );
          }
          case "text": {
            const r = rects[0];
            if (!r) return null;
            return (
              <foreignObject key={a.id} x={r[0]} y={r[1]} width={Math.max(40, r[2] - r[0])} height={Math.max(20, r[3] - r[1])}>
                <div style={{ fontSize: 11 * scale, color, lineHeight: 1.25, border: sel ? `1px dashed ${color}` : "none", width: "100%", height: "100%", overflow: "hidden", fontFamily: "Source Sans 3, sans-serif", whiteSpace: "pre-wrap" }}>{a.comment}</div>
              </foreignObject>
            );
          }
          case "stamp": {
            const r = rects[0];
            if (!r) return null;
            return (
              <g key={a.id} transform={`rotate(-8 ${(r[0] + r[2]) / 2} ${(r[1] + r[3]) / 2})`}>
                <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill="none" stroke={color} strokeWidth={2} rx={4} />
                <text x={(r[0] + r[2]) / 2} y={(r[1] + r[3]) / 2} dominantBaseline="central" textAnchor="middle" fill={color} fontWeight={700} fontSize={(r[3] - r[1]) * 0.55} fontFamily="Source Sans 3, sans-serif">{a.style?.stamp ?? "★"}</text>
              </g>
            );
          }
          default:
            return null;
        }
      })}
      {/* Comment markers for any annotation that carries a note */}
      {annotations.map((a) => {
        if (!("page" in a.anchor) || !(a.comment || a.kind === "note") || a.kind === "text") return null;
        const r = toViewport(vp, (a.anchor.rects?.[0] ?? [0, 0, 0, 0]) as Rect);
        const x = a.kind === "note" ? r[0] : Math.min(vp.width - 16, r[2] + 2);
        const y = a.kind === "note" ? r[1] : r[1] - 10;
        return (
          <foreignObject key={`c-${a.id}`} x={x} y={y} width={18} height={18}>
            <MessageSquare style={{ width: 16, height: 16, color: "#fff", fill: a.color ?? "#ffd400", stroke: "#5a4a00", strokeWidth: 1.5 }} />
          </foreignObject>
        );
      })}
      {draft}
    </svg>
  );
}
