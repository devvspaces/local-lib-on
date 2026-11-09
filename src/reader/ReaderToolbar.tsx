import { Mic, Headphones,
  ArrowRight, BookA, Bookmark, Circle, Columns2, Crop, Expand, Eraser, Hand, Highlighter, Minus, MousePointer2, NotebookPen, PanelLeft, PanelRight,
  PenLine, Plus, RotateCw, ScanSearch, Search, Square, SquareDashed, Stamp, StickyNote, Strikethrough, Table2, Type, Underline, WrapText, ZoomIn, Rows3, FileText, BookOpenText, ChevronLeft, ChevronRight, Info, Download,
} from "lucide-react";
import { Pause, Play, SkipForward, Sparkles, Volume2 } from "lucide-react";
import type { AnnotationKind, ReaderSettings } from "@/lib/api";
import { useTts } from "./tts";
import { useVoiceAsk } from "./voiceAsk";
import { VoicePicker } from "./VoicePicker";
import { cn } from "@/lib/utils";
import { ToolButton } from "@/components/ui/tooltip-button";
import { Menu, MenuCheck, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { HIGHLIGHT_COLORS, type ToolMode } from "./types";
import type { PaneKind } from "@/store/app";

export const ANNOTATION_TOOLS: { kind: AnnotationKind; label: string; icon: typeof Highlighter; pdfOnly?: boolean; key?: string }[] = [
  { kind: "highlight", label: "Highlighter", icon: Highlighter, key: "1" },
  { kind: "underline", label: "Underline", icon: Underline, key: "2" },
  { kind: "squiggly", label: "Squiggly", icon: PenLine },
  { kind: "strike", label: "Strike out", icon: Strikethrough },
  { kind: "note", label: "Pop-up note", icon: StickyNote, pdfOnly: true },
  { kind: "text", label: "Inline text box", icon: Type, pdfOnly: true },
  { kind: "ink", label: "Freehand ink", icon: PenLine, pdfOnly: true, key: "3" },
  { kind: "line", label: "Straight line", icon: Minus, pdfOnly: true },
  { kind: "arrow", label: "Arrow", icon: ArrowRight, pdfOnly: true },
  { kind: "rect", label: "Rectangle", icon: Square, pdfOnly: true },
  { kind: "ellipse", label: "Ellipse", icon: Circle, pdfOnly: true },
  { kind: "stamp", label: "Stamp", icon: Stamp, pdfOnly: true },
];

interface Props {
  compact?: boolean;
  onTts: (action: "play" | "pause" | "resume" | "stop" | "skip") => void;
  ttsStatus: "idle" | "playing" | "paused";
  onVoiceAsk: () => void;
  isPdf: boolean;
  settings: ReaderSettings;
  onSettings: (s: Partial<ReaderSettings>) => void;
  tool: ToolMode;
  setTool: (t: ToolMode) => void;
  annoBar: boolean;
  setAnnoBar: (v: boolean) => void;
  leftOpen: boolean;
  toggleLeft: () => void;
  pane: PaneKind | null;
  setPane: (p: PaneKind | null) => void;
  label: string;
  page?: number;
  pageCount?: number;
  onPage: (p: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onFind: () => void;
  bookmarked: boolean;
  onBookmark: () => void;
  onAutoCrop: () => void;
  onInfo: () => void;
  onExport: () => void;
  onAudiobook: () => void;
  onPdfAction: (a: "annotated" | "filled" | "present" | "reimport") => void;
  color: string;
  setColor: (c: string) => void;
}

export function ReaderToolbar(p: Props) {
  const zoom = p.settings.zoom ?? "fit-width";
  const zoomPct = typeof zoom === "number" ? `${Math.round(zoom * 100)}%` : zoom === "fit-width" ? "Fit width" : "Fit page";
  const z = (d: number) => {
    const cur = typeof zoom === "number" ? zoom : 1.2;
    p.onSettings({ zoom: Math.min(6, Math.max(0.25, Math.round((cur + d) * 100) / 100)) });
  };
  const selectTool = (t: ToolMode["type"]) => p.setTool({ type: t } as ToolMode);
  const activeKind = p.tool.type === "annotate" ? p.tool.kind : null;
  const fontSize = p.settings.font?.size ?? 18;

  return (
    <div className="shrink-0 border-b bg-card">
      <div className="flex h-10 items-center gap-0.5 px-2">
        <ToolButton label="Sidebar" shortcut="⌘⇧S" active={p.leftOpen} onClick={p.toggleLeft}><PanelLeft /></ToolButton>
        <div className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Previous" shortcut="←" onClick={p.onPrev}><ChevronLeft /></ToolButton>
        {p.isPdf && p.page && p.pageCount ? (
          <form onSubmit={(e) => { e.preventDefault(); const v = Number(new FormData(e.currentTarget).get("p")); if (v) p.onPage(v); }} className="flex items-center gap-1 text-xs">
            <input name="p" key={p.page} defaultValue={p.page} className="h-6 w-12 rounded border bg-background text-center tabular-nums outline-none focus:ring-2 focus:ring-ring" aria-label="Page" />
            <span className="text-muted-foreground tabular-nums">/ {p.pageCount}</span>
          </form>
        ) : (
          <span className="max-w-64 truncate px-1 text-xs text-muted-foreground" title={p.label}>{p.label}</span>
        )}
        <ToolButton label="Next" shortcut="→" onClick={p.onNext}><ChevronRight /></ToolButton>
        <div className="mx-1 h-5 w-px bg-border" />

        {/* Selection modes (Okular) */}
        <ToolButton label="Text selection" shortcut="⌘4" active={p.tool.type === "select"} onClick={() => selectTool("select")}><MousePointer2 /></ToolButton>
        {p.isPdf && <>
          <ToolButton label="Area selection" shortcut="⌘3" active={p.tool.type === "area"} onClick={() => selectTool("area")}><SquareDashed /></ToolButton>
          <ToolButton label="Table selection" shortcut="⌘5" active={p.tool.type === "table"} onClick={() => selectTool("table")}><Table2 /></ToolButton>
          <ToolButton label="Magnifier" shortcut="⌘6" active={p.tool.type === "magnifier"} onClick={() => selectTool("magnifier")}><ScanSearch /></ToolButton>
          <ToolButton label="Hand (pan)" active={p.tool.type === "hand"} onClick={() => selectTool("hand")}><Hand /></ToolButton>
        </>}
        <ToolButton label="Annotation toolbar" shortcut="⌘⇧A" active={p.annoBar} onClick={() => p.setAnnoBar(!p.annoBar)}><Highlighter /></ToolButton>

        <div className="flex-1" />

        {p.isPdf ? (
          <>
            <ToolButton label="Zoom out" shortcut="⌘−" onClick={() => z(-0.1)}><Minus /></ToolButton>
            <Menu>
              <MenuTrigger asChild><button className="h-7 min-w-16 rounded-md px-1.5 text-xs tabular-nums hover:bg-secondary cursor-pointer">{zoomPct}</button></MenuTrigger>
              <MenuContent align="center">
                <MenuCheck checked={zoom === "fit-width"} onSelect={() => p.onSettings({ zoom: "fit-width" })}>Fit width <span className="ml-auto text-[11px] text-muted-foreground">⌘0</span></MenuCheck>
                <MenuCheck checked={zoom === "fit-page"} onSelect={() => p.onSettings({ zoom: "fit-page" })}>Fit page</MenuCheck>
                <MenuSeparator />
                {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => <MenuCheck key={v} checked={zoom === v} onSelect={() => p.onSettings({ zoom: v })}>{v * 100}%</MenuCheck>)}
              </MenuContent>
            </Menu>
            <ToolButton label="Zoom in" shortcut="⌘+" onClick={() => z(0.1)}><Plus /></ToolButton>
            <div className="mx-1 h-5 w-px bg-border" />
            <Menu>
              <MenuTrigger asChild><ToolButton label="View mode"><Rows3 /></ToolButton></MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>Layout</MenuLabel>
                <MenuCheck checked={(p.settings.viewMode ?? "continuous") === "continuous"} onSelect={() => p.onSettings({ viewMode: "continuous" })}>Continuous</MenuCheck>
                <MenuCheck checked={p.settings.viewMode === "single"} onSelect={() => p.onSettings({ viewMode: "single" })}>Single page (snap)</MenuCheck>
                <MenuCheck checked={p.settings.viewMode === "facing"} onSelect={() => p.onSettings({ viewMode: "facing" })}>Facing pages</MenuCheck>
                <MenuSeparator />
                <MenuLabel>Page color</MenuLabel>
                {(["normal", "sepia", "dark"] as const).map((t) => <MenuCheck key={t} checked={(p.settings.pdfTheme ?? "normal") === t} onSelect={() => p.onSettings({ pdfTheme: t })} className="capitalize">{t === "dark" ? "Dark (invert)" : t}</MenuCheck>)}
              </MenuContent>
            </Menu>
            <ToolButton label="Rotate" onClick={() => p.onSettings({ rotation: ((p.settings.rotation ?? 0) + 90) % 360 })}><RotateCw /></ToolButton>
            <Menu>
              <MenuTrigger asChild><ToolButton label="Crop margins" active={!!p.settings.crop}><Crop /></ToolButton></MenuTrigger>
              <MenuContent align="end" className="w-64">
                <MenuItem onSelect={p.onAutoCrop}><Crop /> Auto-crop margins</MenuItem>
                <MenuItem onSelect={() => p.onSettings({ crop: null })} disabled={!p.settings.crop}><Eraser /> Remove crop</MenuItem>
                <MenuSeparator />
                <CropSliders crop={p.settings.crop ?? null} onChange={(crop) => p.onSettings({ crop })} />
              </MenuContent>
            </Menu>
            <ToolButton label={p.settings.reflow ? "Back to page view" : "Reflow text (single column)"} active={!!p.settings.reflow} onClick={() => p.onSettings({ reflow: !p.settings.reflow })}><WrapText /></ToolButton>
          </>
        ) : (
          <>
            <ToolButton label="Smaller text" onClick={() => p.onSettings({ font: { ...p.settings.font, size: Math.max(10, fontSize - 1) } })}><span className="text-[11px] font-semibold">A−</span></ToolButton>
            <span className="w-7 text-center text-xs tabular-nums text-muted-foreground">{fontSize}</span>
            <ToolButton label="Larger text" onClick={() => p.onSettings({ font: { ...p.settings.font, size: Math.min(40, fontSize + 1) } })}><span className="text-sm font-semibold">A+</span></ToolButton>
            <TypographyMenu settings={p.settings} onSettings={p.onSettings} />
          </>
        )}
        {p.isPdf && p.settings.reflow && <TypographyMenu settings={p.settings} onSettings={p.onSettings} />}
        <div className="mx-1 h-5 w-px bg-border" />
        <TtsControls status={p.ttsStatus} onTts={p.onTts} onVoiceAsk={p.onVoiceAsk} />
        <ToolButton label="Find in document" shortcut="⌘F" onClick={p.onFind}><Search /></ToolButton>
        <ToolButton label={p.bookmarked ? "Remove bookmark" : "Bookmark this page"} shortcut="⌘D" active={p.bookmarked} onClick={p.onBookmark}><Bookmark className={cn(p.bookmarked && "fill-current")} /></ToolButton>
        {!p.compact && <><Menu>
          <MenuTrigger asChild><ToolButton label="Split view" active={!!p.pane}><Columns2 /></ToolButton></MenuTrigger>
          <MenuContent align="end">
            <MenuLabel>Side-by-side</MenuLabel>
            <MenuCheck checked={p.pane === "notebook"} onSelect={() => p.setPane(p.pane === "notebook" ? null : "notebook")}><NotebookPen /> Notebook</MenuCheck>
            <MenuCheck checked={p.pane === "assistant"} onSelect={() => p.setPane(p.pane === "assistant" ? null : "assistant")}><Sparkles /> AI assistant</MenuCheck>
            <MenuCheck checked={p.pane === "lookup"} onSelect={() => p.setPane(p.pane === "lookup" ? null : "lookup")}><BookA /> Dictionary & Wikipedia</MenuCheck>
            <MenuCheck checked={p.pane === "annotations"} onSelect={() => p.setPane(p.pane === "annotations" ? null : "annotations")}><Highlighter /> Annotations</MenuCheck>
            <MenuCheck checked={p.pane === "book"} onSelect={() => p.setPane(p.pane === "book" ? null : "book")}><BookOpenText /> Second book side-by-side</MenuCheck>
            {p.pane && <><MenuSeparator /><MenuItem onSelect={() => p.setPane(null)}><PanelRight /> Close split view</MenuItem></>}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild><ToolButton label={p.isPdf ? "Export, audiobook, forms & presentation" : "Export & audiobook"}><Download /></ToolButton></MenuTrigger>
          <MenuContent align="end" className="w-64">
            <MenuItem onSelect={p.onExport}><FileText /> Notes &amp; annotations (MD, Word, BibTeX…)</MenuItem>
            <MenuItem onSelect={p.onAudiobook}><Headphones /> Audiobook (M4B)…</MenuItem>
            {p.isPdf && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => p.onPdfAction("annotated")}><Highlighter /> Save annotated PDF copy…</MenuItem>
                <MenuItem onSelect={() => p.onPdfAction("filled")}><PenLine /> Save filled form copy…</MenuItem>
                <MenuItem onSelect={() => p.onPdfAction("reimport")}><RotateCw /> Re-import annotations from PDF</MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => p.onPdfAction("present")}><Expand /> Presentation mode</MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <ToolButton label="Document info" onClick={p.onInfo}><Info /></ToolButton>
        <ToolButton label="Full screen" shortcut="⌃⌘F" onClick={async () => {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const w = getCurrentWindow();
          w.setFullscreen(!(await w.isFullscreen()));
        }}><Expand /></ToolButton></>}
      </div>

      {p.annoBar && (
        <div className="flex h-9 items-center gap-0.5 border-t px-2">
          {ANNOTATION_TOOLS.filter((t) => p.isPdf || !t.pdfOnly).map((t) => (
            <ToolButton
              key={t.kind}
              label={t.label}
              shortcut={t.key ? `⌥${t.key}` : undefined}
              active={activeKind === t.kind}
              onClick={() => p.setTool(activeKind === t.kind ? { type: "select" } : { type: "annotate", kind: t.kind, color: p.color, width: 2 })}
            >
              <t.icon style={{ color: activeKind === t.kind ? p.color : undefined }} />
            </ToolButton>
          ))}
          <div className="mx-2 h-5 w-px bg-border" />
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.id}
              title={c.label}
              onClick={() => { p.setColor(c.value); if (p.tool.type === "annotate") p.setTool({ ...p.tool, color: c.value }); }}
              className={cn("mx-0.5 h-4 w-4 rounded-full cursor-pointer ring-offset-2 ring-offset-card", p.color === c.value && "ring-2 ring-ring")}
              style={{ background: c.value }}
            />
          ))}
          {p.tool.type === "annotate" && ["ink", "line", "arrow", "rect", "ellipse"].includes(p.tool.kind) && (
            <label className="ml-3 flex items-center gap-1 text-xs text-muted-foreground">
              Width
              <input type="range" min={0.5} max={8} step={0.5} value={p.tool.width ?? 2} onChange={(e) => p.setTool({ ...(p.tool as Extract<ToolMode, { type: "annotate" }>), width: Number(e.target.value) })} className="w-20" />
            </label>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">{activeKind ? "Esc to stop annotating" : "Pick a tool, or just select text for the quick menu"}</span>
          <FileText className="hidden" /><ZoomIn className="hidden" />
        </div>
      )}
    </div>
  );
}

function TtsControls({ status, onTts, onVoiceAsk }: { status: Props["ttsStatus"]; onTts: Props["onTts"]; onVoiceAsk: () => void }) {
  const { rate } = useTts();
  const listening = useVoiceAsk((s) => s.phase === "listening");
  return (
    <>
      {status === "idle" ? (
        <ToolButton label="Read aloud (from here or the selection)" shortcut="⌥Space" onClick={() => onTts("play")}><Volume2 /></ToolButton>
      ) : (
        <>
          <ToolButton label={status === "playing" ? "Pause" : "Resume"} shortcut="⌥Space" active onClick={() => onTts(status === "playing" ? "pause" : "resume")}>{status === "playing" ? <Pause /> : <Play />}</ToolButton>
          <ToolButton label="Next sentence" onClick={() => onTts("skip")}><SkipForward /></ToolButton>
          <ToolButton label="Stop reading" onClick={() => onTts("stop")}><Square className="fill-current" /></ToolButton>
        </>
      )}
      <ToolButton label={listening ? "Stop listening and ask" : "Ask a question by voice"} shortcut="hold ⌥⇧Space" active={listening} onClick={onVoiceAsk}><Mic className={listening ? "animate-pulse text-destructive" : undefined} /></ToolButton>
      <Menu>
        <MenuTrigger asChild><ToolButton label="Voice & speed"><span className="text-[10px] font-semibold tabular-nums">{rate}×</span></ToolButton></MenuTrigger>
        <MenuContent align="end" className="max-h-[70vh] w-80 overflow-y-auto">
          <MenuLabel>Speed</MenuLabel>
          <div className="flex flex-wrap gap-1 px-2 pb-2">
            {[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => (
              <button key={r} onClick={() => useTts.setState({ rate: r })} className={cn("rounded border px-1.5 py-0.5 text-xs cursor-pointer", rate === r && "border-primary bg-accent")}>{r}×</button>
            ))}
          </div>
          <MenuSeparator />
          <div className="p-1"><VoicePicker compact /></div>
        </MenuContent>
      </Menu>
    </>
  );
}

function CropSliders({ crop, onChange }: { crop: ReaderSettings["crop"] | null; onChange: (c: NonNullable<ReaderSettings["crop"]>) => void }) {
  const c = crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return (
    <div className="space-y-1.5 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Manual crop</p>
      {(["top", "bottom", "left", "right"] as const).map((k) => (
        <label key={k} className="flex items-center gap-2 text-xs capitalize">
          <span className="w-12">{k}</span>
          <input type="range" min={0} max={0.3} step={0.005} value={c[k]} onChange={(e) => onChange({ ...c, [k]: Number(e.target.value) })} className="flex-1" />
          <span className="w-8 text-right tabular-nums text-muted-foreground">{Math.round(c[k] * 100)}%</span>
        </label>
      ))}
    </div>
  );
}

function TypographyMenu({ settings, onSettings }: { settings: ReaderSettings; onSettings: (s: Partial<ReaderSettings>) => void }) {
  const f = settings.font ?? {};
  const set = (patch: Partial<NonNullable<ReaderSettings["font"]>>) => onSettings({ font: { ...f, ...patch } });
  return (
    <Menu>
      <MenuTrigger asChild><ToolButton label="Typography & layout"><Type /></ToolButton></MenuTrigger>
      <MenuContent align="end" className="w-64">
        <MenuLabel>Font</MenuLabel>
        {[["", "Publisher default"], ["Literata, serif", "Literata (serif)"], ["Source Sans 3, sans-serif", "Source Sans (sans)"], ["Georgia, serif", "Georgia"], ["ui-monospace, monospace", "Monospace"]].map(([v, l]) => (
          <MenuCheck key={v} checked={(f.family ?? "") === v} onSelect={() => set({ family: v || undefined })}>{l}</MenuCheck>
        ))}
        <MenuSeparator />
        <div className="space-y-2 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <label className="flex items-center gap-2 text-xs"><span className="w-20">Line height</span><input type="range" min={1.1} max={2.2} step={0.05} value={f.lineHeight ?? 1.6} onChange={(e) => set({ lineHeight: Number(e.target.value) })} className="flex-1" /></label>
          <label className="flex items-center gap-2 text-xs"><span className="w-20">Margins</span><input type="range" min={0} max={20} step={1} value={f.margin ?? 6} onChange={(e) => set({ margin: Number(e.target.value) })} className="flex-1" /></label>
        </div>
        <MenuCheck checked={!!f.justify} onSelect={(e) => { e.preventDefault(); set({ justify: !f.justify }); }}>Justify text</MenuCheck>
        {!settings.reflow && <>
          <MenuSeparator />
          <MenuLabel>Flow</MenuLabel>
          <MenuCheck checked={(settings.flow ?? "paginated") === "paginated"} onSelect={() => onSettings({ flow: "paginated" })}>Paginated</MenuCheck>
          <MenuCheck checked={settings.flow === "scrolled"} onSelect={() => onSettings({ flow: "scrolled" })}>Scrolled</MenuCheck>
        </>}
      </MenuContent>
    </Menu>
  );
}
