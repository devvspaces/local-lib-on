import { invoke } from "@tauri-apps/api/core";

export type CloudName = "dropbox" | "onedrive" | "gdrive";
export type Target =
  | { kind: "folder"; path: string }
  | { kind: "webdav"; url: string; username: string; password: string }
  | { kind: "cloud"; cloud: CloudName; client_id: string; client_secret?: string | null };
export interface SyncConfig { enabled: boolean; target: Target | null; sync_files: boolean; device_name: string; backup_daily: boolean; backup_keep: number; encrypted: boolean }
export interface SyncReport { pulled_devices: number; applied: number; deleted: number; conflicts: number; files_up: number; files_down: number; at: string; error: string | null }

export const syncApi = {
  get: () => invoke<SyncConfig>("get_sync_config"),
  save: (config: SyncConfig) => invoke<void>("save_sync_config", { config }),
  status: () => invoke<SyncReport | null>("sync_status"),
  now: () => invoke<SyncReport>("sync_now"),
  backup: () => invoke<string>("backup_now"),
  backups: () => invoke<string[]>("list_backups"),
  restore: (name: string) => invoke<void>("restore_backup", { name }),
  setPassphrase: (passphrase: string) => invoke<boolean>("set_sync_passphrase", { passphrase }),
  signIn: (cloud: CloudName, clientId: string, clientSecret?: string | null) => invoke<void>("cloud_sign_in", { cloud, clientId, clientSecret: clientSecret ?? null }),
  cloudStatus: (cloud: CloudName) => invoke<boolean>("cloud_status", { cloud }),
  signOut: (cloud: CloudName) => invoke<void>("cloud_sign_out", { cloud }),
};
