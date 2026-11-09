import { create } from "zustand";
import { Check, Loader2, X } from "lucide-react";
import { dismissTask, useTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

interface ToastItem { id: number; title: string; body?: string; tone?: "default" | "error" | "success"; action?: { label: string; onClick: () => void } }
const useToasts = create<{ items: ToastItem[]; push: (t: Omit<ToastItem, "id">) => void; dismiss: (id: number) => void }>((set, get) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set({ items: [...get().items, { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.action ? 12000 : t.tone === "error" ? 7000 : 3500);
  },
  dismiss: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
}));

export const toast = (title: string, body?: string, tone: ToastItem["tone"] = "default") => useToasts.getState().push({ title, body, tone });
export const toastAction = (title: string, body: string, action: { label: string; onClick: () => void }) => useToasts.getState().push({ title, body, action });
export const toastError = (title: string, err: unknown) => toast(title, String(err), "error");

export function Toaster() {
  const { items, dismiss } = useToasts();
  const tasks = useTasks((s) => s.tasks);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {tasks.map((t) => (
        <div key={t.id} role="status" aria-live="polite" className={cn("pointer-events-auto rounded-lg border bg-popover px-4 py-3 shadow-lg animate-in slide-in-from-bottom-2", t.status === "error" && "border-destructive/40", t.status === "done" && "border-primary/40")}>
          <div className="flex items-start gap-2">
            {t.status === "running" ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" /> : t.status === "done" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : null}
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-semibold", t.status === "error" && "text-destructive")}>{t.title}</p>
              {(t.result ?? t.detail) && <p className="mt-0.5 text-xs text-muted-foreground break-words" data-selectable>{t.status === "running" ? t.detail : t.result}</p>}
              {t.status === "running" && t.progress !== undefined && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(Math.min(1, Math.max(0, t.progress)) * 100)}%` }} /></div>
              )}
            </div>
            {t.status !== "running" && <button onClick={() => dismissTask(t.id)} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>}
          </div>
        </div>
      ))}
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto rounded-lg border bg-popover px-4 py-3 shadow-lg animate-in slide-in-from-bottom-2",
            t.tone === "error" && "border-destructive/40",
            t.tone === "success" && "border-primary/40"
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <p className={cn("text-sm font-semibold", t.tone === "error" && "text-destructive")}>{t.title}</p>
            <button onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="h-3.5 w-3.5" /></button>
          </div>
          {t.body && <p className="mt-0.5 text-xs text-muted-foreground break-words" data-selectable>{t.body}</p>}
          {t.action && <button onClick={() => { t.action!.onClick(); dismiss(t.id); }} className="mt-2 rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground cursor-pointer">{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
