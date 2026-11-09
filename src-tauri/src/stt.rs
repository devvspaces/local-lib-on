//! Offline speech recognition for voice questions (sherpa-onnx). Models are downloaded on demand like voices.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use sherpa_onnx::{OfflineModelConfig, OfflineMoonshineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineWhisperModelConfig};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

#[derive(Debug, Clone, Serialize)]
pub struct SttModel { pub id: &'static str, pub name: &'static str, pub family: &'static str, pub archive: &'static str, pub size_mb: u32, pub note: &'static str, pub installed: bool }

pub fn catalog() -> Vec<SttModel> {
    vec![
        SttModel { id: "moonshine-tiny-en", name: "Moonshine tiny (English)", family: "moonshine2", archive: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2", size_mb: 29, note: "Small and fast · recommended", installed: false },
        SttModel { id: "whisper-tiny-en", name: "Whisper tiny.en", family: "whisper", archive: "sherpa-onnx-whisper-tiny.en.tar.bz2", size_mb: 118, note: "Alternative, a bit more robust to accents", installed: false },
    ]
}

fn dir_of(root: &Path, m: &SttModel) -> PathBuf { root.join(m.archive.trim_end_matches(".tar.bz2")) }

pub fn list(root: &Path) -> Vec<SttModel> {
    catalog().into_iter().map(|mut m| { m.installed = dir_of(root, &m).join(".ok").exists(); m }).collect()
}

fn find(dir: &Path, pred: impl Fn(&str) -> bool) -> Option<String> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(&pred)).collect();
    v.sort_by_key(|p| !p.to_string_lossy().contains("int8"));
    v.into_iter().next().map(|p| p.to_string_lossy().to_string())
}

fn files_ok(dir: &Path, family: &str) -> bool {
    match family {
        "moonshine2" => find(dir, |n| n.starts_with("encoder")).is_some() && find(dir, |n| n.contains("decoder") && n.contains("merged")).is_some(),
        _ => find(dir, |n| n.contains("encoder")).is_some() && find(dir, |n| n.contains("decoder")).is_some(),
    }
}

pub async fn install(app: &AppHandle, root: &Path, id: &str) -> AppResult<()> {
    let m = catalog().into_iter().find(|m| m.id == id).ok_or_else(|| AppError::NotFound(id.into()))?;
    let got = crate::tts::fetch_archive(app, root, &format!("{RELEASE}/{}", m.archive), m.archive, "stt_install_progress", id).await?;
    let dir = dir_of(root, &m);
    if !files_ok(&dir, m.family) { return Err(AppError::other("speech model archive is missing its model files")); }
    std::fs::write(dir.join(".ok"), b"1")?;
    let _ = app.emit("stt_install_progress", serde_json::json!({"id": id, "bytes": got, "total": got, "done": true}));
    Ok(())
}

pub fn uninstall(root: &Path, id: &str, stt: &Stt) -> AppResult<()> {
    let m = catalog().into_iter().find(|m| m.id == id).ok_or_else(|| AppError::NotFound(id.into()))?;
    stt.loaded.lock().unwrap().remove(id);
    let _ = std::fs::remove_dir_all(dir_of(root, &m));
    Ok(())
}

struct Rec(OfflineRecognizer);
// The recognizer is used from one thread at a time (guarded by the mutex below).
unsafe impl Send for Rec {}
unsafe impl Sync for Rec {}

#[derive(Default, Clone)]
pub struct Stt { loaded: Arc<Mutex<HashMap<String, Arc<Mutex<Rec>>>>> }

impl Stt {
    fn recognizer(&self, root: &Path, id: &str) -> AppResult<Arc<Mutex<Rec>>> {
        if let Some(r) = self.loaded.lock().unwrap().get(id) { return Ok(r.clone()); }
        let m = catalog().into_iter().find(|m| m.id == id).ok_or_else(|| AppError::NotFound(id.into()))?;
        let dir = dir_of(root, &m);
        if !dir.join(".ok").exists() { return Err(AppError::other(format!("Download “{}” in Settings → Reading & voices first.", m.name))); }
        let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 4) as i32).unwrap_or(2);
        let mut mc = OfflineModelConfig { tokens: find(&dir, |n| n.ends_with("tokens.txt")), num_threads: threads, provider: Some("cpu".into()), ..Default::default() };
        if m.family == "moonshine2" {
            mc.moonshine = OfflineMoonshineModelConfig { encoder: find(&dir, |n| n.starts_with("encoder")), merged_decoder: find(&dir, |n| n.contains("decoder") && n.contains("merged")), ..Default::default() };
        } else {
            mc.whisper = OfflineWhisperModelConfig { encoder: find(&dir, |n| n.contains("encoder")), decoder: find(&dir, |n| n.contains("decoder")), language: Some("en".into()), task: Some("transcribe".into()), tail_paddings: -1, ..Default::default() };
        }
        let cfg = OfflineRecognizerConfig { model_config: mc, decoding_method: Some("greedy_search".into()), ..Default::default() };
        let r = Arc::new(Mutex::new(Rec(OfflineRecognizer::create(&cfg).ok_or_else(|| AppError::other("could not load the speech model"))?)));
        self.loaded.lock().unwrap().insert(id.to_string(), r.clone());
        Ok(r)
    }

    /// Transcribe mono f32 samples at `rate` Hz.
    pub fn transcribe(&self, root: &Path, id: &str, samples: &[f32], rate: i32) -> AppResult<String> {
        let r = self.recognizer(root, id)?;
        let r = r.lock().unwrap();
        let stream = r.0.create_stream();
        stream.accept_waveform(rate, samples);
        r.0.decode(&stream);
        Ok(stream.get_result().map(|x| x.text.trim().to_string()).unwrap_or_default())
    }
}

// ── Microphone capture (native, so it works without webview media permissions) ──

struct Capture { stop: Arc<std::sync::atomic::AtomicBool>, samples: Arc<Mutex<Vec<f32>>>, rate: u32, thread: std::thread::JoinHandle<Result<(), String>> }
static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

/// Linear resample of mono audio to 16 kHz.
pub fn to_16k(x: &[f32], rate: u32) -> Vec<f32> {
    if rate == 16000 || x.is_empty() { return x.to_vec(); }
    let n = (x.len() as u64 * 16000 / rate as u64) as usize;
    (0..n).map(|i| {
        let pos = i as f64 * rate as f64 / 16000.0;
        let a = pos.floor() as usize;
        let t = (pos - a as f64) as f32;
        let (p, q) = (x[a.min(x.len() - 1)], x[(a + 1).min(x.len() - 1)]);
        p + (q - p) * t
    }).collect()
}

/// Silence detector: true once speech was heard and the last `tail` seconds are quiet.
pub fn ended_by_silence(x: &[f32], rate: u32, tail: f32) -> bool {
    let win = (rate / 10).max(1) as usize; // 100 ms windows
    let rms: Vec<f32> = x.chunks(win).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let loud = 0.02f32;
    let Some(first) = rms.iter().position(|r| *r > loud) else { return false };
    let quiet_windows = (tail * 10.0) as usize;
    rms.len() > first + quiet_windows && rms[rms.len() - quiet_windows..].iter().all(|r| *r < loud * 0.6)
}

/// Start recording from the default microphone. Emits `stt_autostop` after speech followed by ~1.2 s of
/// silence (or after 30 s), so the UI can stop and transcribe.
pub fn record_start(app: AppHandle) -> AppResult<()> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut g = CAPTURE.lock().unwrap();
    if g.is_some() { return Ok(()); }
    let device = cpal::default_host().default_input_device().ok_or_else(|| AppError::other("No microphone found."))?;
    let cfg = device.default_input_config().map_err(|e| AppError::other(format!("Microphone unavailable: {e}")))?;
    let (rate, channels, fmt) = (cfg.sample_rate(), cfg.channels() as usize, cfg.sample_format());
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let (stop2, cb_buf, mon_buf) = (stop.clone(), samples.clone(), samples.clone());
    let thread = std::thread::spawn(move || -> Result<(), String> {
        let config = cfg.config();
        let err = |e| eprintln!("[stt] mic error: {e}");
        let stream = match fmt {
            cpal::SampleFormat::F32 => device.build_input_stream(&config, move |d: &[f32], _: &_| {
                cb_buf.lock().unwrap().extend(d.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32));
            }, err, None),
            cpal::SampleFormat::I16 => device.build_input_stream(&config, move |d: &[i16], _: &_| {
                cb_buf.lock().unwrap().extend(d.chunks(channels).map(|f| f.iter().map(|v| *v as f32 / 32768.0).sum::<f32>() / channels as f32));
            }, err, None),
            other => return Err(format!("unsupported microphone format {other:?}")),
        }.map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        let started = std::time::Instant::now();
        let mut announced = false;
        while !stop2.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if announced { continue; }
            let timeout = started.elapsed().as_secs() >= 30;
            let silent = { let b = mon_buf.lock().unwrap(); ended_by_silence(&b, rate, 1.2) };
            if timeout || silent { announced = true; let _ = app.emit("stt_autostop", ()); }
        }
        drop(stream);
        Ok(())
    });
    *g = Some(Capture { stop, samples, rate, thread });
    Ok(())
}

/// Stop recording and return 16 kHz mono samples (empty if nothing was recorded).
pub fn record_stop() -> AppResult<Vec<f32>> {
    let Some(c) = CAPTURE.lock().unwrap().take() else { return Ok(vec![]) };
    c.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    c.thread.join().map_err(|_| AppError::other("recorder crashed"))?.map_err(AppError::other)?;
    let x = std::mem::take(&mut *c.samples.lock().unwrap());
    Ok(to_16k(&x, c.rate))
}

/// Little-endian 16-bit PCM bytes → f32 samples.
pub fn pcm16_to_f32(b: &[u8]) -> Vec<f32> { b.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_and_silence() {
        let x: Vec<f32> = (0..48000).map(|i| (i as f32 * 0.01).sin()).collect();
        assert_eq!(to_16k(&x, 48000).len(), 16000);
        let rate = 16000u32;
        let mut a: Vec<f32> = vec![0.0; 8000]; // 0.5 s quiet
        a.extend((0..16000).map(|i| 0.3 * (i as f32 * 0.05).sin())); // 1 s speech
        assert!(!ended_by_silence(&a, rate, 1.2), "still talking");
        a.extend(vec![0.001; 22000]); // 1.4 s quiet
        assert!(ended_by_silence(&a, rate, 1.2));
        assert!(!ended_by_silence(&vec![0.0; 48000], rate, 1.2), "no speech yet → keep listening");
    }

    #[test]
    fn pcm_conversion() {
        let b: Vec<u8> = [0i16, 16384, -32768].iter().flat_map(|x| x.to_le_bytes()).collect();
        assert_eq!(pcm16_to_f32(&b), vec![0.0, 0.5, -1.0]);
    }

    /// Live round trip: Piper speaks a sentence → Moonshine transcribes it.
    /// Needs a Piper voice installed in the app and the model unpacked at $LOCAL_LIB_STT_ROOT (or the app dir).
    #[test]
    #[ignore]
    fn stt_live_roundtrip() {
        let app_dir = PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/com.locallib.app");
        let stt_root = std::env::var("LOCAL_LIB_STT_ROOT").map(PathBuf::from).unwrap_or_else(|_| app_dir.join("stt"));
        let tts_root = app_dir.join("tts");
        let voice = crate::tts::list(&tts_root).into_iter().find(|v| v.installed && v.family == "piper").expect("install a Piper voice first");
        let (samples, rate) = crate::tts::Tts::default().synth_samples(&tts_root, voice.id, 0, "What does latch crabbing mean?", 1.0).unwrap();
        // Moonshine/Whisper expect 16 kHz.
        let resampled: Vec<f32> = (0..(samples.len() as u64 * 16000 / rate as u64)).map(|i| samples[((i * rate as u64) / 16000) as usize]).collect();
        let text = Stt::default().transcribe(&stt_root, "moonshine-tiny-en", &resampled, 16000).unwrap().to_lowercase();
        eprintln!("heard: {text}");
        assert!(text.contains("latch") || text.contains("crab"), "heard: {text}");
    }
}
