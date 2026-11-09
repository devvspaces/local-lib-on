import { useApp } from "@/store/app";
import { BookReader } from "./BookReader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";

/** Keeps every open tab mounted (position, zoom, search survive tab switches); shows the active one. */
export function ReaderHost() {
  const { tabs, activeTab, view } = useApp();
  if (!tabs.length) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a book from the library.</div>;
  }
  return (
    <>
      {tabs.map((t) => (
        <div key={t.key} className={cn("absolute inset-0", t.key !== activeTab && "invisible pointer-events-none")}>
          <ErrorBoundary label="this book"><BookReader tab={t} active={view === "reader" && t.key === activeTab} /></ErrorBoundary>
        </div>
      ))}
    </>
  );
}
