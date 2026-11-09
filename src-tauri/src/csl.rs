//! CSL citation styles and locales, fetched on demand from the official
//! citation-style-language repositories and cached in app data.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, serde::Deserialize, Clone)]
pub struct StyleInfo {
    pub id: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 160 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Independent styles from the repo root (dependent/ aliases are skipped: they only point at a parent).
pub async fn list_styles(cache: &Path) -> AppResult<Vec<StyleInfo>> {
    let idx = cache.join("index.json");
    if let Ok(meta) = std::fs::metadata(&idx) {
        let fresh = meta.modified().ok().and_then(|m| m.elapsed().ok()).map_or(false, |e| e.as_secs() < 7 * 86400);
        if fresh {
            if let Ok(v) = serde_json::from_slice(&std::fs::read(&idx)?) {
                return Ok(v);
            }
        }
    }
    let j: serde_json::Value = crate::providers::http()
        .get("https://api.github.com/repos/citation-style-language/styles/git/trees/master")
        .header("Accept", "application/vnd.github+json")
        .send().await?.error_for_status()?.json().await?;
    let mut out: Vec<StyleInfo> = j["tree"].as_array().into_iter().flatten()
        .filter_map(|t| t["path"].as_str())
        .filter_map(|p| p.strip_suffix(".csl"))
        .map(|id| StyleInfo { id: id.to_string() })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    std::fs::create_dir_all(cache)?;
    std::fs::write(&idx, serde_json::to_vec(&out)?)?;
    Ok(out)
}

/// kind = "style" | "locale" (locale ids like "en-US").
pub async fn get(cache: &Path, kind: &str, id: &str) -> AppResult<String> {
    if !valid_id(id) {
        return Err(AppError::other("invalid style id"));
    }
    let (file, url): (PathBuf, String) = match kind {
        "style" => (cache.join("styles").join(format!("{id}.csl")), format!("https://raw.githubusercontent.com/citation-style-language/styles/master/{id}.csl")),
        "locale" => (cache.join("locales").join(format!("{id}.xml")), format!("https://raw.githubusercontent.com/citation-style-language/locales/master/locales-{id}.xml")),
        _ => return Err(AppError::other("unknown kind")),
    };
    if let Ok(s) = std::fs::read_to_string(&file) {
        return Ok(s);
    }
    let text = crate::providers::http().get(url).send().await?.error_for_status()?.text().await?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&file, &text)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids_are_sanitized() {
        assert!(super::valid_id("apa"));
        assert!(super::valid_id("chicago-author-date"));
        assert!(!super::valid_id("../etc/passwd"));
        assert!(!super::valid_id("a/b"));
    }

    #[test]
    #[ignore]
    fn live_csl() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let d = tempfile::tempdir().unwrap();
            let s = super::list_styles(d.path()).await.unwrap();
            println!("CSL: {} independent styles", s.len());
            assert!(s.iter().any(|x| x.id == "apa"));
            let apa = super::get(d.path(), "style", "apa").await.unwrap();
            assert!(apa.contains("<style"));
        });
    }
}
