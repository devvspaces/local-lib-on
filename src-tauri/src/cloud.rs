//! Direct cloud storage for sync/backup: Dropbox (app folder), OneDrive (app root), Google Drive (drive.file).
//! Sign-in is OAuth 2.0 Authorization Code + PKCE with a loopback redirect opened in the system browser.
//! Refresh tokens are stored in the Keychain. The user supplies their own public client IDs (docs/cloud-setup.md).
use crate::error::{AppError, AppResult};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cloud { Dropbox, Onedrive, Gdrive }

impl Cloud {
    fn auth_url(self) -> &'static str {
        match self {
            Cloud::Dropbox => "https://www.dropbox.com/oauth2/authorize",
            Cloud::Onedrive => "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
            Cloud::Gdrive => "https://accounts.google.com/o/oauth2/v2/auth",
        }
    }
    fn token_url(self) -> &'static str {
        match self {
            Cloud::Dropbox => "https://api.dropboxapi.com/oauth2/token",
            Cloud::Onedrive => "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            Cloud::Gdrive => "https://oauth2.googleapis.com/token",
        }
    }
    fn scope(self) -> &'static str {
        match self {
            Cloud::Dropbox => "files.content.write files.content.read",
            Cloud::Onedrive => "Files.ReadWrite.AppFolder offline_access",
            Cloud::Gdrive => "https://www.googleapis.com/auth/drive.file",
        }
    }
    pub fn slot(self) -> &'static str {
        match self { Cloud::Dropbox => "oauth-dropbox", Cloud::Onedrive => "oauth-onedrive", Cloud::Gdrive => "oauth-gdrive" }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens { pub access_token: String, pub refresh_token: Option<String>, pub expires_at: i64 }

fn b64url(b: &[u8]) -> String { base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b) }

pub fn pkce() -> (String, String) {
    let mut v = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut v);
    let verifier = b64url(&v);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn authorize_url(cloud: Cloud, client_id: &str, redirect: &str, challenge: &str, state: &str) -> String {
    let mut q = vec![
        ("client_id", client_id.to_string()), ("redirect_uri", redirect.to_string()), ("response_type", "code".into()),
        ("code_challenge", challenge.to_string()), ("code_challenge_method", "S256".into()), ("state", state.to_string()), ("scope", cloud.scope().into()),
    ];
    match cloud {
        Cloud::Dropbox => q.push(("token_access_type", "offline".into())),
        Cloud::Gdrive => { q.push(("access_type", "offline".into())); q.push(("prompt", "consent".into())); }
        Cloud::Onedrive => {}
    }
    reqwest::Url::parse_with_params(cloud.auth_url(), &q).map(|u| u.to_string()).unwrap_or_default()
}

/// Run the browser sign-in: loopback listener → code → tokens (stored in the Keychain).
pub async fn sign_in(cloud: Cloud, client_id: String, client_secret: Option<String>, open: impl Fn(&str)) -> AppResult<()> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| AppError::other(e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let (verifier, challenge) = pkce();
    let mut st = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut st);
    let state = b64url(&st);
    open(&authorize_url(cloud, &client_id, &redirect, &challenge, &state));
    let expected = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || -> AppResult<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        while std::time::Instant::now() < deadline {
            let Ok(Some(req)) = server.recv_timeout(std::time::Duration::from_secs(1)) else { continue };
            let url = reqwest::Url::parse(&format!("http://127.0.0.1{}", req.url())).ok();
            let q: HashMap<String, String> = url.map(|u| u.query_pairs().into_owned().collect()).unwrap_or_default();
            if q.get("state") != Some(&expected) {
                let _ = req.respond(tiny_http::Response::from_string("Invalid sign-in state.").with_status_code(400));
                continue;
            }
            let page = |msg: &str| tiny_http::Response::from_string(format!("<html><body style='font-family:-apple-system,sans-serif;padding:3em'><h2>{msg}</h2><p>You can close this tab and return to Local Lib.</p></body></html>"))
                .with_header(tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap());
            if let Some(code) = q.get("code") {
                let _ = req.respond(page("Signed in ✓"));
                return Ok(code.clone());
            }
            let _ = req.respond(page("Sign-in was cancelled."));
            return Err(AppError::other(q.get("error_description").or(q.get("error")).cloned().unwrap_or_else(|| "sign-in cancelled".into())));
        }
        Err(AppError::other("sign-in timed out"))
    }).await.map_err(|e| AppError::other(e.to_string()))??;

    let mut form = vec![("grant_type", "authorization_code".to_string()), ("code", code), ("redirect_uri", redirect), ("client_id", client_id), ("code_verifier", verifier)];
    if let Some(s) = client_secret.filter(|s| !s.is_empty()) { form.push(("client_secret", s)); }
    let t = token_request(cloud, &form).await?;
    save_tokens(cloud, &t)
}

async fn token_request(cloud: Cloud, form: &[(&str, String)]) -> AppResult<Tokens> {
    let r = crate::providers::http().post(cloud.token_url()).form(form).send().await?;
    if !r.status().is_success() {
        return Err(AppError::other(format!("token exchange failed: {}", r.text().await.unwrap_or_default())));
    }
    let j: Value = r.json().await?;
    Ok(Tokens {
        access_token: j["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: j["refresh_token"].as_str().map(String::from),
        expires_at: chrono::Utc::now().timestamp() + j["expires_in"].as_i64().unwrap_or(3600) - 60,
    })
}

fn save_tokens(cloud: Cloud, t: &Tokens) -> AppResult<()> {
    crate::llm::set_key(cloud.slot(), Some(&serde_json::to_string(t)?))
}

pub fn signed_in(cloud: Cloud) -> bool { crate::llm::get_key(cloud.slot()).is_some() }
pub fn sign_out(cloud: Cloud) -> AppResult<()> { crate::llm::set_key(cloud.slot(), None) }

static REFRESH_LOCK: Mutex<()> = Mutex::new(());

/// Current access token, refreshing when expired.
pub async fn access_token(cloud: Cloud, client_id: &str, client_secret: Option<&str>) -> AppResult<String> {
    let raw = crate::llm::get_key(cloud.slot()).ok_or_else(|| AppError::other("Not signed in to this cloud yet."))?;
    let mut t: Tokens = serde_json::from_str(&raw)?;
    if chrono::Utc::now().timestamp() < t.expires_at { return Ok(t.access_token); }
    let refresh = t.refresh_token.clone().ok_or_else(|| AppError::other("Session expired; sign in again."))?;
    let mut form = vec![("grant_type", "refresh_token".to_string()), ("refresh_token", refresh.clone()), ("client_id", client_id.to_string())];
    if let Some(s) = client_secret.filter(|s| !s.is_empty()) { form.push(("client_secret", s.to_string())); }
    let n = token_request(cloud, &form).await?;
    let _g = REFRESH_LOCK.lock();
    t = Tokens { refresh_token: n.refresh_token.or(Some(refresh)), ..n };
    save_tokens(cloud, &t)?;
    Ok(t.access_token)
}

// ── Storage operations ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CloudTarget { pub cloud: Cloud, pub client_id: String, #[serde(default)] pub client_secret: Option<String> }

fn http() -> reqwest::Client { reqwest::Client::builder().timeout(std::time::Duration::from_secs(900)).build().unwrap() }

/// Google Drive: resolve "a/b/c" under a top-level "Local Lib" folder to file ids (cached).
static GDRIVE_IDS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

async fn gdrive_find(token: &str, name: &str, parent: &str, folder: bool) -> AppResult<Option<String>> {
    let q = format!("name = '{}' and '{}' in parents and trashed = false{}", name.replace('\'', "\\'"), parent, if folder { " and mimeType = 'application/vnd.google-apps.folder'" } else { "" });
    let r: Value = http().get("https://www.googleapis.com/drive/v3/files").bearer_auth(token).query(&[("q", q.as_str()), ("fields", "files(id,name)"), ("spaces", "drive")]).send().await?.error_for_status()?.json().await?;
    Ok(r["files"][0]["id"].as_str().map(String::from))
}

async fn gdrive_folder(token: &str, path: &str, create: bool) -> AppResult<Option<String>> {
    if let Some(id) = GDRIVE_IDS.lock().unwrap().as_ref().and_then(|m| m.get(path).cloned()) { return Ok(Some(id)); }
    let mut parent = "root".to_string();
    let mut acc = String::new();
    for seg in std::iter::once("Local Lib").chain(path.split('/').filter(|s| !s.is_empty())) {
        acc = if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
        let id = match gdrive_find(token, seg, &parent, true).await? {
            Some(id) => id,
            None if create => {
                let r: Value = http().post("https://www.googleapis.com/drive/v3/files").bearer_auth(token).json(&json!({"name": seg, "mimeType": "application/vnd.google-apps.folder", "parents": [parent]})).send().await?.error_for_status()?.json().await?;
                r["id"].as_str().unwrap_or("").to_string()
            }
            None => return Ok(None),
        };
        parent = id;
    }
    GDRIVE_IDS.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_string(), parent.clone());
    Ok(Some(parent))
}

fn split(rel: &str) -> (&str, &str) { rel.rsplit_once('/').unwrap_or(("", rel)) }

impl CloudTarget {
    async fn token(&self) -> AppResult<String> { access_token(self.cloud, &self.client_id, self.client_secret.as_deref()).await }

    pub async fn put(&self, rel: &str, bytes: Vec<u8>) -> AppResult<()> {
        let t = self.token().await?;
        match self.cloud {
            Cloud::Dropbox => {
                let arg = json!({"path": format!("/{rel}"), "mode": "overwrite", "mute": true}).to_string();
                http().post("https://content.dropboxapi.com/2/files/upload").bearer_auth(&t).header("Dropbox-API-Arg", arg).header("Content-Type", "application/octet-stream").body(bytes).send().await?.error_for_status()?;
            }
            Cloud::Onedrive => {
                let path = rel.split('/').map(|s| urlencoding::encode(s).to_string()).collect::<Vec<_>>().join("/");
                if bytes.len() <= 4 * 1024 * 1024 {
                    http().put(format!("https://graph.microsoft.com/v1.0/me/drive/special/approot:/{path}:/content")).bearer_auth(&t).body(bytes).send().await?.error_for_status()?;
                } else {
                    // Large files: upload session in 10 MiB chunks (multiples of 320 KiB).
                    let s: Value = http().post(format!("https://graph.microsoft.com/v1.0/me/drive/special/approot:/{path}:/createUploadSession")).bearer_auth(&t).json(&json!({"item": {"@microsoft.graph.conflictBehavior": "replace"}})).send().await?.error_for_status()?.json().await?;
                    let url = s["uploadUrl"].as_str().ok_or_else(|| AppError::other("no upload session"))?.to_string();
                    let chunk = 320 * 1024 * 32;
                    for (i, part) in bytes.chunks(chunk).enumerate() {
                        let start = i * chunk;
                        http().put(&url).header("Content-Range", format!("bytes {}-{}/{}", start, start + part.len() - 1, bytes.len())).body(part.to_vec()).send().await?.error_for_status()?;
                    }
                }
            }
            Cloud::Gdrive => {
                let (dir, name) = split(rel);
                let parent = gdrive_folder(&t, dir, true).await?.unwrap_or_default();
                let existing = gdrive_find(&t, name, &parent, false).await?;
                let (url, meta) = match &existing {
                    Some(id) => (format!("https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=resumable"), json!({})),
                    None => ("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable".into(), json!({"name": name, "parents": [parent]})),
                };
                let req = if existing.is_some() { http().patch(&url) } else { http().post(&url) };
                let r = req.bearer_auth(&t).json(&meta).send().await?.error_for_status()?;
                let session = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| AppError::other("no upload session"))?.to_string();
                http().put(session).body(bytes).send().await?.error_for_status()?;
            }
        }
        Ok(())
    }

    pub async fn get(&self, rel: &str) -> AppResult<Option<Vec<u8>>> {
        let t = self.token().await?;
        let r = match self.cloud {
            Cloud::Dropbox => http().post("https://content.dropboxapi.com/2/files/download").bearer_auth(&t).header("Dropbox-API-Arg", json!({"path": format!("/{rel}")}).to_string()).send().await?,
            Cloud::Onedrive => {
                let path = rel.split('/').map(|s| urlencoding::encode(s).to_string()).collect::<Vec<_>>().join("/");
                http().get(format!("https://graph.microsoft.com/v1.0/me/drive/special/approot:/{path}:/content")).bearer_auth(&t).send().await?
            }
            Cloud::Gdrive => {
                let (dir, name) = split(rel);
                let Some(parent) = gdrive_folder(&t, dir, false).await? else { return Ok(None) };
                let Some(id) = gdrive_find(&t, name, &parent, false).await? else { return Ok(None) };
                http().get(format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media")).bearer_auth(&t).send().await?
            }
        };
        // Dropbox signals a missing file with 409 path/not_found.
        if r.status().as_u16() == 404 || (self.cloud == Cloud::Dropbox && r.status().as_u16() == 409) { return Ok(None); }
        Ok(Some(r.error_for_status()?.bytes().await?.to_vec()))
    }

    pub async fn list(&self, dir: &str) -> AppResult<Vec<String>> {
        let t = self.token().await?;
        match self.cloud {
            Cloud::Dropbox => {
                let mut out = vec![];
                let r = http().post("https://api.dropboxapi.com/2/files/list_folder").bearer_auth(&t).json(&json!({"path": format!("/{dir}")})).send().await?;
                if r.status().as_u16() == 409 { return Ok(vec![]); }
                let mut j: Value = r.error_for_status()?.json().await?;
                loop {
                    out.extend(j["entries"].as_array().into_iter().flatten().filter_map(|e| e["name"].as_str().map(String::from)));
                    if j["has_more"] != json!(true) { break; }
                    j = http().post("https://api.dropboxapi.com/2/files/list_folder/continue").bearer_auth(&t).json(&json!({"cursor": j["cursor"]})).send().await?.error_for_status()?.json().await?;
                }
                Ok(out)
            }
            Cloud::Onedrive => {
                let path = dir.split('/').map(|s| urlencoding::encode(s).to_string()).collect::<Vec<_>>().join("/");
                let mut url = format!("https://graph.microsoft.com/v1.0/me/drive/special/approot:/{path}:/children?$select=name&$top=999");
                let mut out = vec![];
                loop {
                    let r = http().get(&url).bearer_auth(&t).send().await?;
                    if r.status().as_u16() == 404 { return Ok(out); }
                    let j: Value = r.error_for_status()?.json().await?;
                    out.extend(j["value"].as_array().into_iter().flatten().filter_map(|e| e["name"].as_str().map(String::from)));
                    match j["@odata.nextLink"].as_str() { Some(n) => url = n.to_string(), None => break }
                }
                Ok(out)
            }
            Cloud::Gdrive => {
                let Some(parent) = gdrive_folder(&t, dir, false).await? else { return Ok(vec![]) };
                let mut out = vec![];
                let mut page: Option<String> = None;
                loop {
                    let mut q = vec![("q", format!("'{parent}' in parents and trashed = false")), ("fields", "nextPageToken,files(name)".into()), ("pageSize", "1000".into())];
                    if let Some(p) = &page { q.push(("pageToken", p.clone())); }
                    let j: Value = http().get("https://www.googleapis.com/drive/v3/files").bearer_auth(&t).query(&q).send().await?.error_for_status()?.json().await?;
                    out.extend(j["files"].as_array().into_iter().flatten().filter_map(|e| e["name"].as_str().map(String::from)));
                    match j["nextPageToken"].as_str() { Some(n) => page = Some(n.into()), None => break }
                }
                Ok(out)
            }
        }
    }

    pub async fn delete(&self, rel: &str) -> AppResult<()> {
        let t = self.token().await?;
        match self.cloud {
            Cloud::Dropbox => { let _ = http().post("https://api.dropboxapi.com/2/files/delete_v2").bearer_auth(&t).json(&json!({"path": format!("/{rel}")})).send().await; }
            Cloud::Onedrive => {
                let path = rel.split('/').map(|s| urlencoding::encode(s).to_string()).collect::<Vec<_>>().join("/");
                let _ = http().delete(format!("https://graph.microsoft.com/v1.0/me/drive/special/approot:/{path}")).bearer_auth(&t).send().await;
            }
            Cloud::Gdrive => {
                let (dir, name) = split(rel);
                if let Some(parent) = gdrive_folder(&t, dir, false).await? {
                    if let Some(id) = gdrive_find(&t, name, &parent, false).await? {
                        let _ = http().delete(format!("https://www.googleapis.com/drive/v3/files/{id}")).bearer_auth(&t).send().await;
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_and_authorize_url() {
        let (v, c) = pkce();
        assert!(v.len() >= 43 && !v.contains('='));
        assert_eq!(c, b64url(&Sha256::digest(v.as_bytes())));
        let u = authorize_url(Cloud::Dropbox, "app123", "http://127.0.0.1:5555/callback", &c, "st");
        assert!(u.starts_with("https://www.dropbox.com/oauth2/authorize?"));
        assert!(u.contains("code_challenge_method=S256") && u.contains("token_access_type=offline") && u.contains("client_id=app123"));
        assert!(authorize_url(Cloud::Onedrive, "x", "r", &c, "s").contains("Files.ReadWrite.AppFolder"));
        assert!(authorize_url(Cloud::Gdrive, "x", "r", &c, "s").contains("access_type=offline"));
        assert_eq!(split("sync/devices/a/state.json"), ("sync/devices/a", "state.json"));
    }
}
