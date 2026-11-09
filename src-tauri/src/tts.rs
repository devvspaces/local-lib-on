//! Natural offline text-to-speech with sherpa-onnx: Kokoro-82M (most natural) and Piper (fast, light).
//! Voice packs are downloaded on demand from the official sherpa-onnx `tts-models` release and cached.
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::Serialize;
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

#[derive(Debug, Clone, Serialize)]
pub struct Speaker { pub sid: i32, pub name: String }

#[derive(Debug, Clone, Serialize)]
pub struct VoicePack {
    pub id: &'static str,
    pub name: &'static str,
    pub family: &'static str, // kokoro | piper
    pub archive: &'static str,
    pub size_mb: u32,
    pub lang: &'static str,
    pub note: &'static str,
    pub speakers: Vec<Speaker>,
    pub installed: bool,
}

fn sp(list: &[&str]) -> Vec<Speaker> { list.iter().enumerate().map(|(i, n)| Speaker { sid: i as i32, name: n.to_string() }).collect() }

/// Curated catalog (all assets exist in the sherpa-onnx `tts-models` release).
pub fn catalog() -> Vec<VoicePack> {
    let k = sp(&["Bella (US, warm)", "Nicole (US, soft)", "Sarah (US)", "Sky (US)", "Adam (US, male)", "Michael (US, male)", "Emma (UK)", "Isabella (UK)", "George (UK, male)", "Lewis (UK, male)", "Default (US)"]);
    // Kokoro v0.19 speaker order: af, af_bella, af_nicole, af_sarah, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis
    let kokoro_names = ["Default (US)", "Bella (US, warm)", "Nicole (US, soft)", "Sarah (US)", "Sky (US)", "Adam (US, male)", "Michael (US, male)", "Emma (UK)", "Isabella (UK)", "George (UK, male)", "Lewis (UK, male)"];
    let _ = k;
    vec![
        VoicePack { id: "kokoro-en", name: "Kokoro (English)", family: "kokoro", archive: "kokoro-int8-en-v0_19.tar.bz2", size_mb: 103, lang: "en", note: "Most natural · 11 voices · slower on older Macs", speakers: sp(&kokoro_names), installed: false },
        VoicePack { id: "piper-hfc-female", name: "Piper · HFC female (US)", family: "piper", archive: "vits-piper-en_US-hfc_female-medium-int8.tar.bz2", size_mb: 21, lang: "en-US", note: "Fast and light", speakers: sp(&["HFC female"]), installed: false },
        VoicePack { id: "piper-hfc-male", name: "Piper · HFC male (US)", family: "piper", archive: "vits-piper-en_US-hfc_male-medium-int8.tar.bz2", size_mb: 21, lang: "en-US", note: "Fast and light", speakers: sp(&["HFC male"]), installed: false },
        VoicePack { id: "piper-lessac", name: "Piper · Lessac (US, high)", family: "piper", archive: "vits-piper-en_US-lessac-high-int8.tar.bz2", size_mb: 35, lang: "en-US", note: "Clear narrator voice", speakers: sp(&["Lessac"]), installed: false },
        VoicePack { id: "piper-ryan", name: "Piper · Ryan (US, high)", family: "piper", archive: "vits-piper-en_US-ryan-high-int8.tar.bz2", size_mb: 35, lang: "en-US", note: "Male narrator", speakers: sp(&["Ryan"]), installed: false },
        VoicePack { id: "piper-cori", name: "Piper · Cori (UK, high)", family: "piper", archive: "vits-piper-en_GB-cori-high-int8.tar.bz2", size_mb: 35, lang: "en-GB", note: "British narrator", speakers: sp(&["Cori"]), installed: false },
        VoicePack { id: "piper-alba", name: "Piper · Alba (Scottish)", family: "piper", archive: "vits-piper-en_GB-alba-medium-int8.tar.bz2", size_mb: 21, lang: "en-GB", note: "Fast and light", speakers: sp(&["Alba"]), installed: false },
        VoicePack { id: "kokoro-multi", name: "Kokoro (multilingual)", family: "kokoro", archive: "kokoro-int8-multi-lang-v1_1.tar.bz2", size_mb: 147, lang: "multi", note: "Natural voices in several languages (incl. Chinese, Japanese, Spanish, French…)", speakers: vec![], installed: false },
    ]
}

fn dir_of(root: &Path, p: &VoicePack) -> PathBuf { root.join(p.archive.trim_end_matches(".tar.bz2")) }

pub fn list(root: &Path) -> Vec<VoicePack> {
    catalog().into_iter().map(|mut p| { p.installed = dir_of(root, &p).join(".ok").exists(); p }).collect()
}

#[derive(Default, Clone)]
pub struct Tts {
    loaded: Arc<Mutex<HashMap<String, Arc<OfflineTts>>>>,
}


#[derive(Clone, Serialize)]
struct FetchProgress<'a> { id: &'a str, bytes: u64, total: Option<u64>, done: bool, error: Option<String> }

/// Download a `.tar.bz2` model archive and unpack it under `root` (shared by voices and speech recognition).
/// Progress is emitted as `event` with `{id, bytes, total, done}`.
pub async fn fetch_archive(app: &AppHandle, root: &Path, url: &str, archive: &str, event: &str, id: &str) -> AppResult<u64> {
    std::fs::create_dir_all(root)?;
    let tmp = root.join(format!("{archive}.part"));
    let resp = crate::providers::http().get(url).timeout(std::time::Duration::from_secs(3600)).send().await?.error_for_status()?;
    let total = resp.content_length();
    let mut f = std::fs::File::create(&tmp)?;
    let mut got = 0u64;
    let mut last = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        f.write_all(&chunk)?;
        got += chunk.len() as u64;
        if last.elapsed().as_millis() > 200 {
            last = std::time::Instant::now();
            let _ = app.emit(event, FetchProgress { id, bytes: got, total, done: false, error: None });
        }
    }
    drop(f);
    let root2 = root.to_path_buf();
    let tmp2 = tmp.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let file = std::fs::File::open(&tmp2)?;
        let mut ar = tar::Archive::new(bzip2::read::BzDecoder::new(file));
        // `unpack_in` refuses entries that would escape `root`.
        for e in ar.entries()? {
            let mut e = e?;
            e.unpack_in(&root2)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))??;
    let _ = std::fs::remove_file(&tmp);
    Ok(got)
}

pub async fn install(app: &AppHandle, root: &Path, id: &str) -> AppResult<()> {
    let p = catalog().into_iter().find(|p| p.id == id).ok_or_else(|| AppError::NotFound(id.into()))?;
    let got = fetch_archive(app, root, &format!("{RELEASE}/{}", p.archive), p.archive, "tts_install_progress", id).await?;
    let dir = dir_of(root, &p);
    if find_onnx(&dir).is_none() {
        return Err(AppError::other("voice pack is missing its model file"));
    }
    std::fs::write(dir.join(".ok"), b"1")?;
    let _ = app.emit("tts_install_progress", FetchProgress { id, bytes: got, total: Some(got), done: true, error: None });
    Ok(())
}

pub fn uninstall(root: &Path, id: &str, tts: &Tts) -> AppResult<()> {
    let p = catalog().into_iter().find(|p| p.id == id).ok_or_else(|| AppError::NotFound(id.into()))?;
    tts.loaded.lock().unwrap().remove(id);
    let _ = std::fs::remove_dir_all(dir_of(root, &p));
    Ok(())
}

fn find_onnx(dir: &Path) -> Option<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().map_or(false, |x| x == "onnx")).collect();
    v.sort_by_key(|p| !p.to_string_lossy().contains("int8")); // prefer int8 if both are present
    v.into_iter().next()
}

impl Tts {
    fn engine(&self, root: &Path, id: &str) -> AppResult<Arc<OfflineTts>> {
        if let Some(e) = self.loaded.lock().unwrap().get(id) { return Ok(e.clone()); }
        let p = catalog().into_iter().find(|p| p.id == id).ok_or_else(|| AppError::NotFound(id.into()))?;
        let dir = dir_of(root, &p);
        if !dir.join(".ok").exists() { return Err(AppError::other(format!("Voice “{}” isn't installed yet.", p.name))); }
        let s = |n: &str| Some(dir.join(n).to_string_lossy().to_string());
        let model = find_onnx(&dir).map(|m| m.to_string_lossy().to_string());
        let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 6) as i32).unwrap_or(2);
        let mut mc = OfflineTtsModelConfig { num_threads: threads, debug: false, provider: Some("cpu".into()), ..Default::default() };
        if p.family == "kokoro" {
            let lexicons: Vec<String> = ["lexicon-us-en.txt", "lexicon-zh.txt"].iter().filter(|f| dir.join(f).exists()).map(|f| dir.join(f).to_string_lossy().to_string()).collect();
            mc.kokoro = OfflineTtsKokoroModelConfig {
                model, voices: s("voices.bin"), tokens: s("tokens.txt"), data_dir: s("espeak-ng-data"),
                dict_dir: if dir.join("dict").exists() { s("dict") } else { None },
                lexicon: if lexicons.is_empty() { None } else { Some(lexicons.join(",")) },
                ..Default::default()
            };
        } else {
            mc.vits = OfflineTtsVitsModelConfig { model, tokens: s("tokens.txt"), data_dir: s("espeak-ng-data"), ..Default::default() };
        }
        let cfg = OfflineTtsConfig { model: mc, max_num_sentences: 1, ..Default::default() };
        let e = Arc::new(OfflineTts::create(&cfg).ok_or_else(|| AppError::other("could not load the voice model"))?);
        self.loaded.lock().unwrap().insert(id.to_string(), e.clone());
        Ok(e)
    }

    /// Synthesize `text` → mono f32 samples and the sample rate (for audiobook export).
    pub fn synth_samples(&self, root: &Path, id: &str, sid: i32, text: &str, speed: f32) -> AppResult<(Vec<f32>, i32)> {
        let e = self.engine(root, id)?;
        let cfg = GenerationConfig { sid, speed: speed.clamp(0.5, 2.5), ..Default::default() };
        let audio = e.generate_with_config(text, &cfg, None::<fn(&[f32], f32) -> bool>).ok_or_else(|| AppError::other("synthesis failed"))?;
        Ok((audio.samples().to_vec(), audio.sample_rate()))
    }

    /// Synthesize `text` → 16-bit PCM WAV bytes.
    pub fn synth(&self, root: &Path, id: &str, sid: i32, text: &str, speed: f32) -> AppResult<Vec<u8>> {
        let e = self.engine(root, id)?;
        let cfg = GenerationConfig { sid, speed: speed.clamp(0.5, 2.5), ..Default::default() };
        let audio = e.generate_with_config(text, &cfg, None::<fn(&[f32], f32) -> bool>).ok_or_else(|| AppError::other("synthesis failed"))?;
        Ok(wav(audio.samples(), audio.sample_rate()))
    }
}

/// f32 samples → mono 16-bit PCM WAV.
pub fn wav(samples: &[f32], rate: i32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&(rate as u32).to_le_bytes());
    out.extend_from_slice(&(rate as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_and_wav() {
        let c = catalog();
        assert!(c.iter().all(|p| p.archive.ends_with(".tar.bz2") && !p.archive.contains('/')));
        assert_eq!(c.iter().map(|p| p.id).collect::<std::collections::HashSet<_>>().len(), c.len(), "unique ids");
        let w = wav(&[0.0, 0.5, -0.5], 24000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(w.len(), 44 + 6);
    }

    /// Downloads the smallest Piper voice (~21 MB) and synthesizes a sentence.
    #[test]
    #[ignore]
    fn live_piper() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let root = std::env::temp_dir().join("local-lib-tts-test");
        rt.block_on(async {
            let p = catalog().into_iter().find(|p| p.id == "piper-hfc-female").unwrap();
            let dir = dir_of(&root, &p);
            if !dir.join(".ok").exists() {
                std::fs::create_dir_all(&root).unwrap();
                let bytes = crate::providers::http().get(format!("{RELEASE}/{}", p.archive)).send().await.unwrap().bytes().await.unwrap();
                tar::Archive::new(bzip2::read::BzDecoder::new(&bytes[..])).unpack(&root).unwrap();
                std::fs::write(dir.join(".ok"), b"1").unwrap();
            }
        });
        let t = Tts::default();
        let start = std::time::Instant::now();
        let w = t.synth(&root, "piper-hfc-female", 0, "Reading should feel effortless, even for long chapters.", 1.0).unwrap();
        let secs = (w.len() - 44) as f64 / 2.0 / 22050.0;
        println!("TTS: {} bytes, ~{:.1}s of audio in {:?}", w.len(), secs, start.elapsed());
        assert!(w.len() > 44 + 20000);
    }
}
