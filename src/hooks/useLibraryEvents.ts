import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";

/** Global listener: backend emits `library_changed` after scans, imports, edits. */
export function useLibraryEvents() {
  const bump = useApp((s) => s.bumpLibrary);
  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    listen("library_changed", () => bump()).then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
  }, [bump]);
}
