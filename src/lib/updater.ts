// In-app updates from GitHub Releases (tauri-plugin-updater). Releases are signed with the project's updater key,
// so an update is only installed if its signature matches the public key built into the app.
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { toastAction } from "@/components/ui/toast";
import { runTask } from "@/lib/tasks";

const LAST_CHECK = "updater:lastCheck";
const AUTO = "updater:auto";
const DAY = 24 * 3600 * 1000;

export const useUpdater = create<{ version: string; available: Update | null; checking: boolean; checkedAt: number | null; ready: boolean; error: string | null }>(() => ({
  version: "", available: null, checking: false, checkedAt: null, ready: false, error: null,
}));

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const autoUpdateEnabled = () => store.get(AUTO) !== "off";
export const setAutoUpdate = (on: boolean) => store.set(AUTO, on ? "on" : "off");

/** Ask GitHub for a newer release. `quiet` = no toast when up to date (startup check). */
export async function checkForUpdates(quiet = false): Promise<Update | null> {
  if (useUpdater.getState().checking) return null;
  useUpdater.setState({ checking: true, error: null });
  try {
    const u = await check();
    store.set(LAST_CHECK, String(Date.now()));
    useUpdater.setState({ available: u, checkedAt: Date.now() });
    if (u) toastAction(`Local Lib ${u.version} is available`, firstLine(u.body) || "A new version is ready to install.", { label: "Update now", onClick: () => void installUpdate() });
    else if (!quiet) toastAction("You're up to date", `Local Lib ${useUpdater.getState().version}`, { label: "OK", onClick: () => {} });
    return u;
  } catch (e) {
    useUpdater.setState({ error: String(e) });
    if (!quiet) toastAction("Couldn't check for updates", String(e), { label: "OK", onClick: () => {} });
    return null;
  } finally { useUpdater.setState({ checking: false }); }
}

const firstLine = (s?: string) => (s ?? "").split("\n").map((l) => l.replace(/^[#*\-\s]+/, "").trim()).find(Boolean)?.slice(0, 140) ?? "";

/** Download + install the available update with a progress toast, then offer to restart. */
export async function installUpdate() {
  const u = useUpdater.getState().available ?? (await check().catch(() => null));
  if (!u) return;
  const ok = await runTask("app-update", `Updating to ${u.version}`, async (update) => {
    let total = 0, got = 0;
    await u.downloadAndInstall((ev) => {
      if (ev.event === "Started") { total = ev.data.contentLength ?? 0; update({ detail: "Downloading…", progress: total ? 0 : undefined }); }
      else if (ev.event === "Progress") { got += ev.data.chunkLength; if (total) update({ detail: `${(got / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB`, progress: got / total }); }
      else if (ev.event === "Finished") update({ detail: "Installing…", progress: undefined });
    });
    return true;
  }, { doneText: () => "Restart Local Lib to finish", errorTitle: "Update failed" });
  if (ok) {
    useUpdater.setState({ ready: true, available: null });
    toastAction("Update installed", `Restart to start using ${u.version}.`, { label: "Restart now", onClick: () => void relaunch() });
  }
}

/** Mount once: quiet check shortly after launch, at most once a day. Not in dev builds. */
export function startUpdateChecks() {
  getVersion().then((v) => useUpdater.setState({ version: v })).catch(() => {});
  if (import.meta.env.DEV || !autoUpdateEnabled()) return () => {};
  const last = Number(store.get(LAST_CHECK) ?? 0);
  const t = setTimeout(() => void checkForUpdates(true), Date.now() - last > DAY ? 8000 : DAY - (Date.now() - last));
  return () => clearTimeout(t);
}
