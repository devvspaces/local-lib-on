//! Audiobook export: chapters of a book → offline neural TTS (Kokoro / Piper) → one M4B per part with
//! chapter markers (chapter list + QuickTime chapter track), title, author and cover art.
//! PCM is streamed to a temp WAV (no whole-book buffer in memory), then encoded to AAC with macOS `afconvert`.
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::{reading, tts};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChapterSpec { pub title: String, pub from: i64, pub to: i64 }

#[derive(Debug, Clone, Deserialize)]
pub struct Job {
    pub book_id: i64,
    pub voice: String,
    #[serde(default)]
    pub sid: i32,
    #[serde(default = "one")]
    pub speed: f32,
    pub out_path: String,
    pub chapters: Vec<ChapterSpec>,
}
fn one() -> f32 { 1.0 }

#[derive(Debug, Clone, Serialize, Default)]
pub struct Progress {
    pub id: String,
    pub title: String,
    /// preparing | rendering | encoding | done | error | cancelled
    pub status: String,
    /// What "preparing" is doing right now (shown under the progress bar).
    pub stage: Option<String>,
    pub chapter: usize,
    pub chapters: usize,
    pub percent: f32,
    pub eta_seconds: Option<u64>,
    pub audio_seconds: u64,
    pub outputs: Vec<String>,
    pub error: Option<String>,
}

static CANCEL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
pub fn cancel() { CANCEL.store(true, Ordering::SeqCst); }

// ── Text preparation ───────────────────────────────────────

/// Ordered unit texts (pages "p{n}" or sections "s{n}") of a range.
pub fn range_units(c: &rusqlite::Connection, book_id: i64, from: i64, to: i64) -> AppResult<Vec<String>> {
    let mut out = vec![];
    for n in from..=to {
        for p in ["p", "s"] {
            if let Some(t) = reading::unit_text(c, book_id, &format!("{p}{n}"))? { out.push(t); break; }
        }
    }
    Ok(out)
}

fn edge_key(words: &[&str]) -> String {
    words.iter().map(|w| w.chars().filter(|c| c.is_alphabetic()).collect::<String>().to_lowercase()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Remove running headers/footers (the same few words at the start/end of most pages) and bare page numbers.
pub fn strip_running_heads(pages: &[String]) -> Vec<String> {
    const N: usize = 5;
    let words: Vec<Vec<&str>> = pages.iter().map(|p| p.split_whitespace().collect()).collect();
    let mut heads: HashMap<String, usize> = HashMap::new();
    let mut feet: HashMap<String, usize> = HashMap::new();
    for w in &words {
        if w.len() > 2 * N {
            *heads.entry(edge_key(&w[..N])).or_default() += 1;
            *feet.entry(edge_key(&w[w.len() - N..])).or_default() += 1;
        }
    }
    let common = |m: &HashMap<String, usize>, k: &str| pages.len() >= 3 && !k.is_empty() && m.get(k).copied().unwrap_or(0) * 10 >= pages.len() * 4;
    words.iter().map(|w| {
        let mut a = 0usize;
        let mut b = w.len();
        if b > 2 * N && common(&heads, &edge_key(&w[..N])) { a = N; }
        if b > 2 * N && common(&feet, &edge_key(&w[b - N..])) { b -= N; }
        // A page number left beside the header/footer.
        while a < b && w[a].chars().all(|c| c.is_ascii_digit() || c == '|') { a += 1; }
        while b > a && w[b - 1].chars().all(|c| c.is_ascii_digit() || c == '|') { b -= 1; }
        w[a..b].join(" ")
    }).collect()
}

static HYPHEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\p{Ll})[-\u{00AD}]\s+(\p{Ll})").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+").unwrap());

/// Page texts → clean, speakable prose.
pub fn clean_text(pages: &[String]) -> String {
    let joined = strip_running_heads(pages).join(" ");
    let t = HYPHEN.replace_all(&joined, "$1$2");
    let t = URL.replace_all(&t, "link");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

const ABBREV: &[&str] = &["mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "e.g", "i.e", "fig", "eq", "no", "vol", "ch", "sec", "p", "pp", "al", "approx", "inc", "ltd", "jr", "sr"];

/// Split prose into sentences for synthesis: respects common abbreviations and decimals, merges fragments
/// shorter than `min` and breaks run-ons longer than `max` at ; , or spaces.
pub fn sentences(text: &str, min: usize, max: usize) -> Vec<String> {
    let mut raw: Vec<String> = vec![];
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len() {
        let ch = chars[i];
        cur.push(ch);
        if matches!(ch, '.' | '!' | '?' | '…') {
            let next = chars.get(i + 1).copied();
            let after = chars.get(i + 2).copied();
            let boundary = next.map_or(true, |n| n.is_whitespace()) && after.map_or(true, |a| a.is_uppercase() || a.is_ascii_digit() || matches!(a, '"' | '“' | '‘' | '(' | '['));
            if !boundary { continue; }
            if ch == '.' {
                let word: String = cur.trim_end_matches('.').rsplit(|c: char| c.is_whitespace() || c == '(').next().unwrap_or("").to_lowercase();
                if ABBREV.contains(&word.as_str()) || (word.len() == 1 && word.chars().all(|c| c.is_alphabetic())) { continue; }
            }
            raw.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() { raw.push(cur.trim().to_string()); }
    // Break run-ons, then merge tiny fragments.
    let mut split: Vec<String> = vec![];
    for s in raw {
        let mut rest = s.as_str();
        while rest.chars().count() > max {
            let cut_at = rest.char_indices().take_while(|(i, _)| *i < max).filter(|(_, c)| matches!(c, ';' | ',' | ':')).last().map(|(i, _)| i + 1)
                .or_else(|| rest.char_indices().take_while(|(i, _)| *i < max).filter(|(_, c)| c.is_whitespace()).last().map(|(i, _)| i))
                .unwrap_or_else(|| rest.char_indices().nth(max).map(|(i, _)| i).unwrap_or(rest.len()));
            split.push(rest[..cut_at].trim().to_string());
            rest = rest[cut_at..].trim_start();
        }
        if !rest.is_empty() { split.push(rest.to_string()); }
    }
    let mut out: Vec<String> = vec![];
    for s in split {
        match out.last_mut() {
            Some(last) if last.chars().count() < min => { last.push(' '); last.push_str(&s); }
            _ => out.push(s),
        }
    }
    out
}

// ── WAV streaming ──────────────────────────────────────────

/// Mono 16-bit PCM WAV written incrementally; the header sizes are patched on `finish`.
pub struct WavWriter { w: BufWriter<std::fs::File>, rate: u32, pub samples: u64 }

impl WavWriter {
    pub fn create(path: &Path, rate: u32) -> std::io::Result<Self> {
        let mut w = BufWriter::new(std::fs::File::create(path)?);
        w.write_all(&tts::wav(&[], rate as i32))?; // 44-byte header with zero sizes
        Ok(Self { w, rate, samples: 0 })
    }
    pub fn write(&mut self, s: &[f32]) -> std::io::Result<()> {
        for x in s { self.w.write_all(&((x.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?; }
        self.samples += s.len() as u64;
        Ok(())
    }
    pub fn silence(&mut self, secs: f32) -> std::io::Result<()> { self.write(&vec![0.0; (self.rate as f32 * secs) as usize]) }
    pub fn seconds(&self) -> f64 { self.samples as f64 / self.rate as f64 }
    pub fn finish(mut self) -> std::io::Result<()> {
        let data = (self.samples * 2) as u32;
        self.w.flush()?;
        let f = self.w.get_mut();
        f.seek(SeekFrom::Start(4))?;
        f.write_all(&(36 + data).to_le_bytes())?;
        f.seek(SeekFrom::Start(40))?;
        f.write_all(&data.to_le_bytes())?;
        f.flush()
    }
}

// ── Encoding + tagging ─────────────────────────────────────

pub struct Meta { pub title: String, pub author: String, pub cover: Option<Vec<u8>> }

/// WAV → AAC in an M4B container. macOS ships `afconvert`; elsewhere we use `ffmpeg` if it's installed.
pub fn encode_m4b(wav: &Path, out: &Path) -> AppResult<()> {
    if cfg!(target_os = "macos") && Path::new("/usr/bin/afconvert").exists() {
        let st = std::process::Command::new("/usr/bin/afconvert")
            .args(["-f", "m4bf", "-d", "aac", "-b", "48000"]).arg(wav).arg(out)
            .output().map_err(|e| AppError::other(format!("afconvert unavailable: {e}")))?;
        if !st.status.success() { return Err(AppError::other(format!("afconvert failed: {}", String::from_utf8_lossy(&st.stderr)))); }
        return Ok(());
    }
    let ffmpeg = find_ffmpeg().ok_or_else(|| AppError::other(
        "Audiobook export needs ffmpeg on this system. Install it (Windows: `winget install ffmpeg`; Linux: your package manager), then try again."))?;
    let st = std::process::Command::new(ffmpeg)
        .args(["-y", "-loglevel", "error", "-i"]).arg(wav)
        .args(["-c:a", "aac", "-b:a", "48k", "-f", "mp4"]).arg(out)
        .output().map_err(|e| AppError::other(format!("ffmpeg failed to start: {e}")))?;
    if !st.status.success() { return Err(AppError::other(format!("ffmpeg failed: {}", String::from_utf8_lossy(&st.stderr)))); }
    Ok(())
}

/// ffmpeg on PATH or in the usual install locations.
pub fn find_ffmpeg() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "C:\\ffmpeg\\bin"].iter().map(PathBuf::from));
    if let Some(local) = std::env::var_os("LOCALAPPDATA") { dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links")); }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

/// Whether this system can encode audiobooks (for the UI).
pub fn can_encode() -> bool { (cfg!(target_os = "macos") && Path::new("/usr/bin/afconvert").exists()) || find_ffmpeg().is_some() }

pub fn tag_m4b(path: &Path, meta: &Meta, chapters: &[(Duration, String)]) -> AppResult<()> {
    let mut tag = mp4ameta::Tag::read_from_path(path).map_err(|e| AppError::other(format!("reading m4b tags: {e}")))?;
    tag.set_title(&meta.title);
    tag.set_album(&meta.title);
    if !meta.author.is_empty() { tag.set_artist(&meta.author); tag.set_album_artist(&meta.author); }
    tag.set_genre("Audiobook");
    if let Some(c) = &meta.cover {
        let img = if c.starts_with(&[0x89, b'P', b'N', b'G']) { mp4ameta::Img::png(c.clone()) } else { mp4ameta::Img::jpeg(c.clone()) };
        tag.set_artwork(img);
    }
    let ch: Vec<mp4ameta::Chapter> = chapters.iter().map(|(t, s)| mp4ameta::Chapter::new(*t, s.chars().take(250).collect::<String>())).collect();
    *tag.chapter_list_mut() = ch.clone();
    *tag.chapter_track_mut() = ch;
    tag.write_to_path(path).map_err(|e| AppError::other(format!("writing m4b tags: {e}")))
}

fn part_path(out: &Path, part: usize, parts_hint: bool) -> PathBuf {
    if !parts_hint { return out.to_path_buf(); }
    let stem = out.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Audiobook".into());
    out.with_file_name(format!("{stem} (Part {part}).m4b"))
}

/// Max audio per file (keeps the temp WAV well under the 4 GB RIFF limit).
const PART_SECONDS: f64 = 20.0 * 3600.0;

// ── The job ────────────────────────────────────────────────

pub fn start(app: AppHandle, db: Db, engine: tts::Tts, tts_root: PathBuf, tmp_dir: PathBuf, job: Job) -> AppResult<String> {
    if !can_encode() { return Err(AppError::other("Audiobook export needs ffmpeg on this system. Install it (Windows: `winget install ffmpeg`; Linux: your package manager), then try again.")); }
    if RUNNING.swap(true, Ordering::SeqCst) { return Err(AppError::other("An audiobook is already being made. Wait for it to finish or cancel it.")); }
    CANCEL.store(false, Ordering::SeqCst);
    let id = format!("audiobook-{}", uuid::Uuid::new_v4());
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut p = Progress { id: id2.clone(), status: "preparing".into(), stage: Some("Reading the chapters…".into()), chapters: job.chapters.len(), ..Default::default() };
        let _ = app.emit("audiobook_progress", &p);
        let r = run(&app, &db, &engine, &tts_root, &tmp_dir, &job, &mut p);
        match r {
            Ok(()) => { p.status = "done".into(); p.percent = 1.0; p.eta_seconds = None; }
            Err(e) if CANCEL.load(Ordering::SeqCst) => { p.status = "cancelled".into(); p.error = Some(e.to_string()); }
            Err(e) => { p.status = "error".into(); p.error = Some(e.to_string()); }
        }
        let _ = app.emit("audiobook_progress", &p);
        if p.status == "done" || p.status == "error" {
            use tauri_plugin_notification::NotificationExt;
            let body = if p.status == "done" { format!("{} is ready ({} file{}).", p.title, p.outputs.len(), if p.outputs.len() == 1 { "" } else { "s" }) } else { format!("{}: {}", p.title, p.error.clone().unwrap_or_default()) };
            let _ = app.notification().builder().title(if p.status == "done" { "Audiobook ready" } else { "Audiobook failed" }).body(body).show();
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(id)
}

fn run(app: &AppHandle, db: &Db, engine: &tts::Tts, tts_root: &Path, tmp_dir: &Path, job: &Job, p: &mut Progress) -> AppResult<()> {
    let (title, authors, cover_path): (String, String, Option<String>) = db.with(|c| Ok(c.query_row("SELECT title, authors, cover_path FROM books WHERE id = ?", [job.book_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?))?;
    let author = serde_json::from_str::<Vec<String>>(&authors).unwrap_or_default().join(", ");
    let meta = Meta { title: title.clone(), author, cover: cover_path.and_then(|c| std::fs::read(c).ok()) };
    p.title = title;
    let _ = app.emit("audiobook_progress", &*p);

    // Prepare all text first so progress and ETA are by characters.
    let mut prepared: Vec<(String, Vec<String>)> = vec![];
    for ch in &job.chapters {
        let units = db.with(|c| range_units(c, job.book_id, ch.from, ch.to))?;
        prepared.push((ch.title.clone(), sentences(&clean_text(&units), 40, 360)));
    }
    let total_chars: usize = prepared.iter().map(|(t, s)| t.len() + s.iter().map(|x| x.len()).sum::<usize>()).sum::<usize>().max(1);
    if prepared.iter().all(|(_, s)| s.is_empty()) { return Err(AppError::other("No text in these chapters yet (the book may still be indexing, or need OCR).")); }

    p.stage = Some("Loading the voice…".into());
    let _ = app.emit("audiobook_progress", &*p);
    std::fs::create_dir_all(tmp_dir)?;
    let started = Instant::now();
    let mut done_chars = 0usize;
    let mut part = 1usize;
    let mut rate: Option<u32> = None;
    let mut writer: Option<(WavWriter, PathBuf, Vec<(Duration, String)>)> = None;
    let mut finished: Vec<(PathBuf, Vec<(Duration, String)>)> = vec![];
    let mut last_emit = Instant::now() - Duration::from_secs(5);
    let will_split = { // rough: ~15 chars per second of speech at 1×
        (total_chars as f64 / 15.0 / job.speed.max(0.5) as f64) > PART_SECONDS
    };

    let result = (|| -> AppResult<()> {
        for (ci, (ch_title, sents)) in prepared.iter().enumerate() {
            p.chapter = ci + 1;
            if sents.is_empty() { continue; }
            // New part when the current one is long enough (always at a chapter boundary).
            if writer.as_ref().is_some_and(|(w, _, _)| w.seconds() >= PART_SECONDS) {
                let (w, path, marks) = writer.take().unwrap();
                w.finish()?;
                finished.push((path, marks));
                part += 1;
            }
            let lines = std::iter::once(ch_title.clone()).chain(sents.iter().cloned());
            for (si, text) in lines.enumerate() {
                if CANCEL.load(Ordering::SeqCst) { return Err(AppError::other("cancelled")); }
                let (samples, r) = engine.synth_samples(tts_root, &job.voice, job.sid, &text, job.speed)?;
                let r = *rate.get_or_insert(r as u32);
                if p.status == "preparing" { p.status = "rendering".into(); p.stage = None; last_emit = Instant::now() - Duration::from_secs(5); }
                if writer.is_none() {
                    let path = tmp_dir.join(format!("{}-part{part}.wav", p.id));
                    writer = Some((WavWriter::create(&path, r)?, path, vec![]));
                }
                let (w, _, marks) = writer.as_mut().unwrap();
                if si == 0 { marks.push((Duration::from_secs_f64(w.seconds()), ch_title.clone())); }
                w.write(&samples)?;
                w.silence(if si == 0 { 0.9 } else { 0.18 })?;
                done_chars += text.len();
                if last_emit.elapsed() > Duration::from_millis(700) {
                    last_emit = Instant::now();
                    let frac = done_chars as f32 / total_chars as f32;
                    p.percent = frac * 0.95;
                    let el = started.elapsed().as_secs_f32();
                    p.eta_seconds = (frac > 0.01).then(|| (el / frac * (1.0 - frac)) as u64 + 5);
                    p.audio_seconds = finished.len() as u64 * PART_SECONDS as u64 + w.seconds() as u64;
                    let _ = app.emit("audiobook_progress", &*p);
                }
            }
        }
        if let Some((w, path, marks)) = writer.take() { w.finish()?; finished.push((path, marks)); }
        // Encode + tag each part.
        p.status = "encoding".into();
        p.percent = 0.96;
        let _ = app.emit("audiobook_progress", &*p);
        let out = PathBuf::from(&job.out_path);
        let multi = finished.len() > 1 || will_split && finished.len() > 1;
        for (i, (wav, marks)) in finished.iter().enumerate() {
            if CANCEL.load(Ordering::SeqCst) { return Err(AppError::other("cancelled")); }
            let dest = part_path(&out, i + 1, multi);
            encode_m4b(wav, &dest)?;
            let m = Meta { title: if multi { format!("{} (Part {})", meta.title, i + 1) } else { meta.title.clone() }, author: meta.author.clone(), cover: meta.cover.clone() };
            tag_m4b(&dest, &m, marks)?;
            p.outputs.push(dest.to_string_lossy().to_string());
        }
        Ok(())
    })();
    // Temp WAVs are always removed (success, error or cancel).
    for (wav, _) in &finished { let _ = std::fs::remove_file(wav); }
    if let Some((_, path, _)) = writer { let _ = std::fs::remove_file(path); }
    result
}

/// Rough size of the job: characters and spoken seconds at the given speed (~15 chars/s at 1×).
pub fn estimate(db: &Db, book_id: i64, chapters: &[ChapterSpec], speed: f32) -> AppResult<(usize, u64)> {
    let mut chars = 0usize;
    for ch in chapters { chars += db.with(|c| range_units(c, book_id, ch.from, ch.to))?.iter().map(|s| s.len()).sum::<usize>(); }
    Ok((chars, (chars as f64 / 15.0 / speed.max(0.5) as f64) as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_headers_footers_and_page_numbers() {
        let pages: Vec<String> = (10..16).map(|n| format!("Chapter 3: Storage Engines Explained {n} Body text number {n} talks about latches and pages in some depth here. Database Internals Petrov page {n}")).collect();
        let out = strip_running_heads(&pages);
        for (i, o) in out.iter().enumerate() {
            assert!(o.starts_with("Body text"), "header gone: {o}");
            assert!(o.ends_with("depth here."), "footer gone: {o}");
            assert!(o.contains(&format!("number {}", i + 10)));
        }
    }

    #[test]
    fn cleans_hyphenation_and_urls() {
        let t = clean_text(&["The algo- rithm is fast. See https://example.com/x for more.".into()]);
        assert_eq!(t, "The algorithm is fast. See link for more.");
    }

    #[test]
    fn splits_sentences_sensibly() {
        let s = sentences("Dr. Smith wrote it, e.g. in 2003. It was 3.5 times faster! Was it? Yes. Ok.", 10, 200);
        assert_eq!(s, vec!["Dr. Smith wrote it, e.g. in 2003.", "It was 3.5 times faster!", "Was it? Yes.", "Ok."]);
        let long = "word ".repeat(200);
        assert!(sentences(&long, 10, 120).iter().all(|x| x.chars().count() <= 120));
    }

    #[test]
    fn wav_writer_patches_header() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.wav");
        let mut w = WavWriter::create(&p, 24000).unwrap();
        w.write(&[0.5; 1000]).unwrap();
        w.silence(0.5).unwrap();
        assert_eq!(w.samples, 13000);
        w.finish().unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!(b.len(), 44 + 26000);
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 26000);
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 36 + 26000);
    }

    /// Live: Piper voice + afconvert + chapter tags. `cargo test --lib audiobook_live -- --ignored`
    #[test]
    #[ignore]
    fn audiobook_live_two_chapters() {
        let root = dirs_next_tts();
        let voice = tts::list(&root).into_iter().find(|v| v.installed && v.family == "piper").expect("install a Piper voice in the app first");
        let engine = tts::Tts::default();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        let mut w = WavWriter::create(&wav, 22050).unwrap();
        let mut marks = vec![];
        for (i, text) in ["Chapter one. The beginning.", "Chapter two. The end."].iter().enumerate() {
            let (s, r) = engine.synth_samples(&root, voice.id, 0, text, 1.0).unwrap();
            if i == 0 { w = { drop(w); WavWriter::create(&wav, r as u32).unwrap() }; }
            marks.push((Duration::from_secs_f64(w.seconds()), format!("Chapter {}", i + 1)));
            w.write(&s).unwrap();
            w.silence(0.5).unwrap();
        }
        let second = marks[1].0;
        w.finish().unwrap();
        let out = dir.path().join("t.m4b");
        encode_m4b(&wav, &out).unwrap();
        tag_m4b(&out, &Meta { title: "Test Book".into(), author: "Tester".into(), cover: None }, &marks).unwrap();
        let tag = mp4ameta::Tag::read_from_path(&out).unwrap();
        assert_eq!(tag.title(), Some("Test Book"));
        let ch = tag.chapter_list();
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[1].title, "Chapter 2");
        assert!((ch[1].start.as_secs_f64() - second.as_secs_f64()).abs() < 0.1, "{:?} vs {:?}", ch[1].start, second);
        assert_eq!(tag.chapter_track().len(), 2);
    }

    fn dirs_next_tts() -> PathBuf {
        let home = std::env::var("HOME").unwrap();
        PathBuf::from(home).join("Library/Application Support/com.locallib.app/tts")
    }
}
