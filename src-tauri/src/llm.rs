//! Bring-your-own-key LLM assistant.
//!   - Anthropic: native Messages API (raw HTTP; there is no official Rust SDK), streaming SSE.
//!   - OpenAI-compatible: OpenAI, Ollama, LM Studio, OpenRouter… via /chat/completions streaming.
//! API keys live in the OS keychain (macOS Keychain), never in SQLite.
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const KEYCHAIN_SERVICE: &str = "com.locallib.app.llm";
const ANTHROPIC_VERSION: &str = "2026-10-21";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    /// "anthropic" | "openai" | "gemini"
    pub provider: String,
    pub model: String,
    /// OpenAI-compatible base URL (e.g. http://localhost:11434/v1 for Ollama)
    #[serde(default)]
    pub base_url: Option<String>,
    /// Anthropic effort: low | medium | high | xhigh | max
    #[serde(default)]
    pub effort: Option<String>,
    /// Anthropic server-side refusal fallback (on by default)
    #[serde(default = "yes")]
    pub fallbacks: bool,
    /// Set by get_config: whether a key is stored (the key itself is never returned).
    #[serde(default)]
    pub has_key: bool,
}
fn yes() -> bool { true }

impl Default for LlmConfig {
    fn default() -> Self {
        Self { provider: "anthropic".into(), model: "claude-opus-5-5".into(), base_url: None, effort: Some("medium".into()), fallbacks: true, has_key: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // user | assistant
    pub content: String,
}

fn key_entry(provider: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| AppError::other(format!("keychain: {e}")))
}

pub fn get_key(provider: &str) -> Option<String> {
    key_entry(provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

pub fn set_key(provider: &str, key: Option<&str>) -> AppResult<()> {
    let e = key_entry(provider)?;
    match key.filter(|k| !k.trim().is_empty()) {
        Some(k) => e.set_password(k.trim()).map_err(|e| AppError::other(format!("keychain: {e}"))),
        None => { let _ = e.delete_credential(); Ok(()) }
    }
}

#[derive(Clone, Default)]
pub struct Llm {
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Serialize, Clone)]
struct Delta<'a> { id: &'a str, text: &'a str }
#[derive(Serialize, Clone)]
struct Done<'a> { id: &'a str, stop_reason: Option<String>, model: Option<String>, error: Option<String> }

/// Build the Anthropic Messages request body (separated for testing).
pub fn anthropic_body(cfg: &LlmConfig, system: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": 32000,
        "stream": true,
        "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
        "messages": messages.iter().map(|m| serde_json::json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
    });
    if let Some(e) = cfg.effort.as_ref().filter(|e| !e.is_empty()) {
        body["output_config"] = serde_json::json!({ "effort": e });
    }
    if cfg.fallbacks && supports_fallbacks(&cfg.model) {
        body["fallbacks"] = serde_json::json!("default");
    }
    body
}

fn supports_fallbacks(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-fable-5-1" | "claude-sonnet-5-5")
}

impl Llm {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let f = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id.to_string(), f.clone());
        f
    }
    pub fn unregister(&self, id: &str) {
        self.cancels.lock().unwrap().remove(id);
    }
    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.cancels.lock().unwrap().get(id) { f.store(true, Ordering::SeqCst); }
    }

    /// Stream a chat completion; emits `llm_delta` {id, text} chunks and a final `llm_done`.
    pub fn chat(&self, app: AppHandle, cfg: LlmConfig, id: String, system: String, messages: Vec<ChatMessage>) {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id.clone(), flag.clone());
        let cancels = self.cancels.clone();
        tauri::async_runtime::spawn(async move {
            let res = match cfg.provider.as_str() {
                "anthropic" => anthropic_stream(&app, &cfg, &id, &system, &messages, &flag).await,
                "gemini" => gemini_stream(&app, &cfg, &id, &system, &messages, &flag).await,
                _ => openai_stream(&app, &cfg, &id, &system, &messages, &flag).await,
            };
            match res {
                Ok((stop, model)) => { let _ = app.emit("llm_done", Done { id: &id, stop_reason: stop, model, error: None }); }
                Err(e) => { let _ = app.emit("llm_done", Done { id: &id, stop_reason: None, model: None, error: Some(e.to_string()) }); }
            }
            cancels.lock().unwrap().remove(&id);
        });
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(60 * 15)).build().unwrap()
}

async fn sse_lines(resp: reqwest::Response, cancel: &AtomicBool, mut on_data: impl FnMut(&str) -> bool) -> AppResult<()> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) { return Ok(()); }
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if let Some(data) = line.strip_prefix("data:") {
                if !on_data(data.trim()) { return Ok(()); }
            }
        }
    }
    Ok(())
}

async fn anthropic_stream(app: &AppHandle, cfg: &LlmConfig, id: &str, system: &str, messages: &[ChatMessage], cancel: &AtomicBool) -> AppResult<(Option<String>, Option<String>)> {
    let key = get_key("anthropic").ok_or_else(|| AppError::other("No Anthropic API key saved. Add one in Settings → AI."))?;
    let mut req = client()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json");
    if cfg.fallbacks && supports_fallbacks(&cfg.model) {
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let resp = req.json(&anthropic_body(cfg, system, messages)).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|j| j["error"]["message"].as_str().map(String::from)).unwrap_or(body);
        return Err(AppError::other(format!("Anthropic API {status}: {msg}")));
    }
    let mut stop = None;
    let mut model = None;
    let mut err = None;
    sse_lines(resp, cancel, |data| {
        let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { return true };
        match j["type"].as_str() {
            Some("message_start") => model = j["message"]["model"].as_str().map(String::from),
            Some("content_block_delta") if j["delta"]["type"] == "text_delta" => {
                if let Some(t) = j["delta"]["text"].as_str() { let _ = app.emit("llm_delta", Delta { id, text: t }); }
            }
            Some("message_delta") => {
                if let Some(s) = j["delta"]["stop_reason"].as_str() { stop = Some(s.to_string()); }
            }
            Some("error") => { err = j["error"]["message"].as_str().map(String::from); return false; }
            _ => {}
        }
        true
    }).await?;
    if let Some(e) = err { return Err(AppError::other(e)); }
    Ok((stop, model))
}

async fn openai_stream(app: &AppHandle, cfg: &LlmConfig, id: &str, system: &str, messages: &[ChatMessage], cancel: &AtomicBool) -> AppResult<(Option<String>, Option<String>)> {
    let base = cfg.base_url.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| "https://api.openai.com/v1".into());
    let mut msgs = vec![serde_json::json!({ "role": "system", "content": system })];
    msgs.extend(messages.iter().map(|m| serde_json::json!({ "role": m.role, "content": m.content })));
    let mut req = client().post(format!("{}/chat/completions", base.trim_end_matches('/'))).json(&serde_json::json!({ "model": cfg.model, "stream": true, "messages": msgs }));
    if let Some(k) = get_key("openai") { req = req.bearer_auth(k); }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(AppError::other(format!("{base} {status}: {}", resp.text().await.unwrap_or_default())));
    }
    let mut stop = None;
    sse_lines(resp, cancel, |data| {
        if data == "[DONE]" { return false; }
        let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { return true };
        if let Some(t) = j["choices"][0]["delta"]["content"].as_str() { let _ = app.emit("llm_delta", Delta { id, text: t }); }
        if let Some(s) = j["choices"][0]["finish_reason"].as_str() { stop = Some(s.to_string()); }
        true
    }).await?;
    Ok((stop, Some(cfg.model.clone())))
}

// ── Google Gemini (AI Studio key) ──────────────────────────

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

pub fn gemini_body(system: &str, messages: &[ChatMessage]) -> serde_json::Value {
    serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": messages.iter().map(|m| serde_json::json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }],
        })).collect::<Vec<_>>(),
    })
}

/// One SSE `data:` payload → (text, finishReason, blockReason, error)
pub fn gemini_chunk(j: &serde_json::Value) -> (String, Option<String>, Option<String>, Option<String>) {
    let c = &j["candidates"][0];
    let text = c["content"]["parts"].as_array().map(|ps| ps.iter().filter_map(|p| p["text"].as_str()).collect::<String>()).unwrap_or_default();
    (
        text,
        c["finishReason"].as_str().map(String::from),
        j["promptFeedback"]["blockReason"].as_str().map(String::from),
        j["error"]["message"].as_str().map(String::from),
    )
}

async fn gemini_stream(app: &AppHandle, cfg: &LlmConfig, id: &str, system: &str, messages: &[ChatMessage], cancel: &AtomicBool) -> AppResult<(Option<String>, Option<String>)> {
    let key = get_key("gemini").ok_or_else(|| AppError::other("No Gemini API key saved. Add your Google AI Studio key in Settings → AI."))?;
    let model = cfg.model.trim_start_matches("models/");
    let resp = client()
        .post(format!("{GEMINI_BASE}/models/{model}:streamGenerateContent?alt=sse"))
        .header("x-goog-api-key", key)
        .json(&gemini_body(system, messages))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|j| j["error"]["message"].as_str().map(String::from)).unwrap_or(body);
        return Err(AppError::other(format!("Gemini API {status}: {msg}")));
    }
    let (mut stop, mut err) = (None, None);
    sse_lines(resp, cancel, |data| {
        let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { return true };
        let (text, finish, blocked, e) = gemini_chunk(&j);
        if !text.is_empty() { let _ = app.emit("llm_delta", Delta { id, text: &text }); }
        if let Some(f) = finish { stop = Some(if f == "SAFETY" || f == "PROHIBITED_CONTENT" { "refusal".into() } else { f.to_lowercase() }); }
        if blocked.is_some() { stop = Some("refusal".into()); return false; }
        if let Some(e) = e { err = Some(e); return false; }
        true
    }).await?;
    if let Some(e) = err { return Err(AppError::other(e)); }
    Ok((stop, Some(model.to_string())))
}

#[derive(Debug, Serialize)]
pub struct ModelInfo { pub id: String, pub label: String }

/// Models available to the configured key/endpoint (Gemini model list, or OpenAI-compatible /models).
pub async fn list_models(cfg: &LlmConfig) -> AppResult<Vec<ModelInfo>> {
    match cfg.provider.as_str() {
        "gemini" => {
            let key = get_key("gemini").ok_or_else(|| AppError::other("Save your Gemini API key first."))?;
            let j: serde_json::Value = client().get(format!("{GEMINI_BASE}/models?pageSize=200")).header("x-goog-api-key", key).send().await?.error_for_status()?.json().await?;
            let mut out: Vec<ModelInfo> = j["models"].as_array().into_iter().flatten()
                .filter(|m| m["supportedGenerationMethods"].as_array().map_or(false, |a| a.iter().any(|x| x == "generateContent")))
                .filter_map(|m| {
                    let id = m["name"].as_str()?.trim_start_matches("models/").to_string();
                    let label = m["displayName"].as_str().unwrap_or(&id).to_string();
                    Some(ModelInfo { id, label })
                })
                .collect();
            // Newest / most capable first: pro, then flash, then the rest; reverse-lexicographic within.
            out.sort_by(|a, b| {
                let rank = |s: &str| if s.contains("pro") { 0 } else if s.contains("flash") { 1 } else { 2 };
                rank(&a.id).cmp(&rank(&b.id)).then(b.id.cmp(&a.id))
            });
            Ok(out)
        }
        "openai" => {
            let base = cfg.base_url.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| "https://api.openai.com/v1".into());
            let mut req = client().get(format!("{}/models", base.trim_end_matches('/')));
            if let Some(k) = get_key("openai") { req = req.bearer_auth(k); }
            let j: serde_json::Value = req.send().await?.error_for_status()?.json().await?;
            Ok(j["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).map(|id| ModelInfo { id: id.into(), label: id.into() }).collect())
        }
        _ => Ok(vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_shapes() {
        let b = gemini_body("sys", &[ChatMessage { role: "user".into(), content: "q".into() }, ChatMessage { role: "assistant".into(), content: "a".into() }]);
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(b["contents"][1]["role"], "model");
        let j: serde_json::Value = serde_json::from_str(r#"{"candidates":[{"content":{"parts":[{"text":"Hel"},{"text":"lo"}],"role":"model"},"finishReason":"STOP"}]}"#).unwrap();
        let (t, f, blk, e) = gemini_chunk(&j);
        assert_eq!((t.as_str(), f.as_deref(), blk, e), ("Hello", Some("STOP"), None, None));
        let j: serde_json::Value = serde_json::from_str(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#).unwrap();
        assert_eq!(gemini_chunk(&j).2.as_deref(), Some("SAFETY"));
    }

    #[test]
    fn anthropic_request_shape() {
        let cfg = LlmConfig::default();
        let b = anthropic_body(&cfg, "sys", &[ChatMessage { role: "user".into(), content: "hi".into() }]);
        assert_eq!(b["model"], "claude-opus-5-5");
        assert_eq!(b["output_config"]["effort"], "medium");
        assert_eq!(b["fallbacks"], "default");
        assert!(b.get("temperature").is_none() && b.get("thinking").is_none());
        let off = anthropic_body(&LlmConfig { fallbacks: false, ..cfg }, "s", &[]);
        assert!(off.get("fallbacks").is_none());
    }
}
