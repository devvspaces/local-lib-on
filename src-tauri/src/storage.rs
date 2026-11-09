//! Sync/backup storage targets: a local folder (iCloud Drive / Dropbox / Google Drive / OneDrive desktop
//! folders sync it for you) or a WebDAV server (Nextcloud, ownCloud, Synology, Fastmail files…).
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    Folder { path: String },
    Webdav { url: String, username: String, #[serde(default)] password: String },
    /// Dropbox / OneDrive / Google Drive via OAuth.
    Cloud(crate::cloud::CloudTarget),
}

impl Target {
    pub async fn put(&self, rel: &str, bytes: Vec<u8>) -> AppResult<()> {
        match self {
            Target::Cloud(c) => c.put(rel, bytes).await,
            Target::Folder { path } => {
                let p = PathBuf::from(path).join(rel);
                if let Some(d) = p.parent() { std::fs::create_dir_all(d)?; }
                let tmp = p.with_extension("tmp-write");
                std::fs::write(&tmp, bytes)?;
                std::fs::rename(&tmp, &p)?; // atomic on the same volume
                Ok(())
            }
            Target::Webdav { url, username, password } => {
                // MKCOL each parent (ignore 405 = exists).
                let mut acc = String::new();
                let parts: Vec<&str> = rel.split('/').collect();
                for dir in &parts[..parts.len().saturating_sub(1)] {
                    acc = if acc.is_empty() { dir.to_string() } else { format!("{acc}/{dir}") };
                    let _ = dav(url, username, password, "MKCOL", &acc).send().await;
                }
                let r = dav(url, username, password, "PUT", rel).body(bytes).send().await?;
                if !r.status().is_success() { return Err(AppError::other(format!("WebDAV PUT {rel}: {}", r.status()))); }
                Ok(())
            }
        }
    }

    pub async fn get(&self, rel: &str) -> AppResult<Option<Vec<u8>>> {
        match self {
            Target::Cloud(c) => c.get(rel).await,
            Target::Folder { path } => {
                let p = PathBuf::from(path).join(rel);
                Ok(if p.exists() { Some(std::fs::read(p)?) } else { None })
            }
            Target::Webdav { url, username, password } => {
                let r = dav(url, username, password, "GET", rel).send().await?;
                if r.status().as_u16() == 404 { return Ok(None); }
                if !r.status().is_success() { return Err(AppError::other(format!("WebDAV GET {rel}: {}", r.status()))); }
                Ok(Some(r.bytes().await?.to_vec()))
            }
        }
    }

    /// Names (not paths) of entries directly inside `dir`.
    pub async fn list(&self, dir: &str) -> AppResult<Vec<String>> {
        match self {
            Target::Cloud(c) => c.list(dir).await,
            Target::Folder { path } => {
                let p = PathBuf::from(path).join(dir);
                if !p.exists() { return Ok(vec![]); }
                Ok(std::fs::read_dir(p)?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !n.starts_with('.')).collect())
            }
            Target::Webdav { url, username, password } => {
                let r = dav(url, username, password, "PROPFIND", &format!("{dir}/")).header("Depth", "1").send().await?;
                if r.status().as_u16() == 404 { return Ok(vec![]); }
                let xml = r.text().await?;
                let re = regex::Regex::new(r"(?i)<(?:d:)?href>([^<]+)</(?:d:)?href>").unwrap();
                let mut out = vec![];
                for c in re.captures_iter(&xml) {
                    let href = urlencoding::decode(&c[1]).map(|s| s.to_string()).unwrap_or_else(|_| c[1].to_string());
                    let name = href.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
                    if !name.is_empty() && !href.trim_end_matches('/').ends_with(dir.trim_end_matches('/')) { out.push(name); }
                }
                Ok(out)
            }
        }
    }

    pub async fn delete(&self, rel: &str) -> AppResult<()> {
        match self {
            Target::Cloud(c) => c.delete(rel).await,
            Target::Folder { path } => { let _ = std::fs::remove_file(PathBuf::from(path).join(rel)); Ok(()) }
            Target::Webdav { url, username, password } => { let _ = dav(url, username, password, "DELETE", rel).send().await; Ok(()) }
        }
    }
}

fn dav(base: &str, user: &str, pass: &str, method: &str, rel: &str) -> reqwest::RequestBuilder {
    let url = format!("{}/{}", base.trim_end_matches('/'), rel.split('/').map(|s| urlencoding::encode(s).to_string()).collect::<Vec<_>>().join("/"));
    crate::providers::http()
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
        .basic_auth(user, Some(pass))
}

/// A target plus optional end-to-end encryption. Paths stay readable (they are device ids, content
/// hashes and backup timestamps); contents are sealed. `sync/crypto.json` itself is plaintext.
#[derive(Clone)]
pub struct Store {
    pub target: Target,
    pub key: Option<crate::crypto::Key>,
}

impl Store {
    pub fn plain(target: Target) -> Self { Self { target, key: None } }

    pub async fn put(&self, rel: &str, bytes: Vec<u8>) -> AppResult<()> {
        let data = match &self.key { Some(k) if rel != "sync/crypto.json" => crate::crypto::seal(k, &bytes), _ => bytes };
        self.target.put(rel, data).await
    }

    pub async fn get(&self, rel: &str) -> AppResult<Option<Vec<u8>>> {
        let Some(data) = self.target.get(rel).await? else { return Ok(None) };
        match &self.key {
            Some(k) if rel != "sync/crypto.json" => Ok(Some(crate::crypto::open(k, &data)?)),
            None if crate::crypto::is_sealed(&data) => Err(AppError::other("This sync location is encrypted. Enter its passphrase in Settings → Sync & backup.")),
            _ => Ok(Some(data)),
        }
    }

    pub async fn list(&self, dir: &str) -> AppResult<Vec<String>> { self.target.list(dir).await }
    pub async fn delete(&self, rel: &str) -> AppResult<()> { self.target.delete(rel).await }
}
