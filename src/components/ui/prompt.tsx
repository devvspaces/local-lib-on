// In-app replacements for window.prompt / window.confirm, which don't work in the Tauri webview
// (prompt returns null; confirm doesn't block). Promise-based so call sites stay one-liners:
//   const name = await askText({ title: "New collection" });   // string | null
//   if (!(await askConfirm({ title: "Delete note?" }))) return;
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent } from "./dialog";
import { Button } from "./button";
import { cn } from "@/lib/utils";

export interface TextOpts { title: string; description?: string; label?: string; initial?: string; placeholder?: string; okLabel?: string; multiline?: boolean }
export interface ConfirmOpts { title: string; description?: string; okLabel?: string; cancelLabel?: string; destructive?: boolean; rows?: { label: string; before: string; after: string }[] }
export interface FormField { key: string; label: string; type?: "text" | "select" | "checkbox"; options?: { value: string; label: string }[]; initial?: string | boolean; placeholder?: string }
export interface FormOpts { title: string; description?: string; fields: FormField[]; okLabel?: string }

type Req =
  | { kind: "text"; opts: TextOpts; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "form"; opts: FormOpts; resolve: (v: Record<string, string | boolean> | null) => void };

let queue: Req[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const push = (r: Req) => { queue = [...queue, r]; emit(); };
const pop = () => { queue = queue.slice(1); emit(); };

export const askText = (opts: TextOpts) => new Promise<string | null>((resolve) => push({ kind: "text", opts, resolve }));
export const askConfirm = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => push({ kind: "confirm", opts, resolve }));
export const askForm = (opts: FormOpts) => new Promise<Record<string, string | boolean> | null>((resolve) => push({ kind: "form", opts, resolve }));

/** Test hook: current pending request count. */
export const _pending = () => queue.length;

/** Mount once (Layout). Shows queued requests one at a time. */
export function PromptHost() {
  const req = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => queue[0]);
  if (!req) return null;
  return <PromptDialog key={queue.length + req.opts.title} req={req} />;
}

function PromptDialog({ req }: { req: Req }) {
  const [text, setText] = useState(req.kind === "text" ? req.opts.initial ?? "" : "");
  const [form, setForm] = useState<Record<string, string | boolean>>(() =>
    req.kind === "form" ? Object.fromEntries(req.opts.fields.map((f) => [f.key, f.initial ?? (f.type === "checkbox" ? false : f.options?.[0]?.value ?? "")])) : {});
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30); }, []);

  const finish = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    if (req.kind === "text") req.resolve(ok ? text : null);
    else if (req.kind === "confirm") req.resolve(ok);
    else req.resolve(ok ? form : null);
    pop();
  };
  const submit = (e?: React.FormEvent) => { e?.preventDefault(); if (req.kind === "text" && !text.trim()) return; finish(true); };
  const field = "h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus:border-primary";

  return (
    <Dialog open onOpenChange={(o) => !o && finish(false)}>
      <DialogContent title={req.opts.title} description={req.opts.description} className="max-w-md">
        <form onSubmit={submit} className="space-y-3">
          {req.kind === "text" && (
            <label className="block space-y-1 text-sm">
              {req.opts.label && <span className="text-muted-foreground">{req.opts.label}</span>}
              {req.opts.multiline
                ? <textarea ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={req.opts.placeholder} rows={4} className={cn(field, "h-auto py-2")} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
                : <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={req.opts.placeholder} className={field} />}
            </label>
          )}
          {req.kind === "confirm" && !!req.opts.rows?.length && (
            <table className="w-full text-left text-[13px]">
              <thead><tr className="text-xs text-muted-foreground"><th className="w-24 pb-1 font-normal" /><th className="pb-1 font-normal">Now</th><th className="pb-1 font-normal">New</th></tr></thead>
              <tbody>
                {req.opts.rows.map((r) => (
                  <tr key={r.label} className="border-t align-top">
                    <td className="py-1.5 pr-2 text-muted-foreground">{r.label}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground line-through decoration-muted-foreground/40">{r.before || "—"}</td>
                    <td className="py-1.5 font-medium">{r.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {req.kind === "form" && req.opts.fields.map((f, i) => (
            f.type === "checkbox" ? (
              <label key={f.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })} /> {f.label}</label>
            ) : (
              <label key={f.key} className="block space-y-1 text-sm">
                <span className="text-muted-foreground">{f.label}</span>
                {f.type === "select"
                  ? <select value={String(form[f.key])} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className={field}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                  : <input ref={i === 0 ? inputRef : undefined} value={String(form[f.key] ?? "")} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className={field} />}
              </label>
            )
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => finish(false)}>{req.kind === "confirm" ? req.opts.cancelLabel ?? "Cancel" : "Cancel"}</Button>
            <Button type="submit" size="sm" variant={req.kind === "confirm" && req.opts.destructive ? "destructive" : "default"} disabled={req.kind === "text" && !text.trim()}>
              {req.opts.okLabel ?? (req.kind === "confirm" ? "OK" : "Save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
