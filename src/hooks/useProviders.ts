import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { providers, type ProviderMeta } from "@/lib/providers";
import { useApp } from "@/store/app";

/** Provider list that refreshes when sources change in Settings or the view becomes visible. */
export function useProviders() {
  const [list, setList] = useState<ProviderMeta[]>([]);
  const view = useApp((s) => s.view);
  useEffect(() => { providers.list().then(setList); }, [view]);
  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    listen("providers_changed", () => providers.list().then(setList)).then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
  }, []);
  return list;
}
