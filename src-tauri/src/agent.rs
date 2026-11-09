//! Tool-using research assistant: the model can search the library, read pages, look at annotations,
//! open a page in the reader, and *propose* notes/flashcards (the user confirms in the UI).
//! One loop, three provider adapters (Anthropic Messages, Gemini, OpenAI-compatible).
//!
//! History is kept provider-native and append-only (assistant turns are echoed back exactly as received,
//! including thinking blocks), so preserved-thinking checks on current Claude models stay valid.
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{self, LlmConfig};
use crate::{library::store, reading};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

pub const MAX_STEPS: usize = 10;

// ── Tool definitions ───────────────────────────────────────

struct ToolDef {
    name: &'static str,
    description: &'static str,
    params: Value, // JSON Schema (object), all properties required
}

fn obj(props: Value) -> Value {
    let required: Vec<String> = props.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

fn tools() -> Vec<ToolDef> {
    vec![
        ToolDef { name: "search_library", description: "Full-text search across every indexed book in the user's library. Returns matching passages with book_id, title and location (p<N> = PDF page N, s<N> = ebook section N).",
            params: obj(json!({ "query": {"type": "string", "description": "Keywords or a phrase"}, "limit": {"type": "integer", "description": "Max passages, 1-12"} })) },
        ToolDef { name: "search_book", description: "Full-text search inside one book.",
            params: obj(json!({ "book_id": {"type": "integer"}, "query": {"type": "string"}, "limit": {"type": "integer", "description": "1-12"} })) },
        ToolDef { name: "read_pages", description: "Read the text of a range of pages (PDF) or sections (ebooks) of a book. At most 6 units per call.",
            params: obj(json!({ "book_id": {"type": "integer"}, "from": {"type": "integer", "description": "First page/section number"}, "to": {"type": "integer", "description": "Last page/section number (inclusive)"} })) },
        ToolDef { name: "find_books", description: "Find books in the library by title, author, ISBN or DOI. Use an empty string to list recently opened books.",
            params: obj(json!({ "query": {"type": "string"} })) },
        ToolDef { name: "get_book_info", description: "Bibliographic details for a book: title, authors, year, publisher, pages, status, progress.",
            params: obj(json!({ "book_id": {"type": "integer"} })) },
        ToolDef { name: "list_annotations", description: "The user's highlights and notes for a book (with page labels, colors, comments, tags).",
            params: obj(json!({ "book_id": {"type": "integer"} })) },
        ToolDef { name: "open_page", description: "Open a book at a page in the user's reader so they can see the passage you are referring to.",
            params: obj(json!({ "book_id": {"type": "integer"}, "page": {"type": "integer"} })) },
        ToolDef { name: "propose_note", description: "Propose saving a Markdown note (shown to the user, who decides whether to save it). Use book_id 0 for a general note.",
            params: obj(json!({ "book_id": {"type": "integer"}, "title": {"type": "string"}, "markdown": {"type": "string"} })) },
        ToolDef { name: "propose_flashcards", description: "Propose flashcards for spaced repetition (shown to the user, who decides which to keep).",
            params: obj(json!({ "book_id": {"type": "integer"}, "cards": {"type": "array", "items": obj(json!({ "front": {"type": "string"}, "back": {"type": "string"} }))} })) },
    ]
}

// Typed inputs: deserialization doubles as schema validation (unknown fields rejected).
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct QueryLimit { query: String, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct BookQuery { book_id: i64, query: String, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ReadPages { book_id: i64, from: i64, to: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Query { query: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct BookId { book_id: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct OpenPage { book_id: i64, page: i64 }
#[derive(Deserialize, Serialize)] #[serde(deny_unknown_fields)] struct ProposeNote { book_id: i64, title: String, markdown: String }
#[derive(Deserialize, Serialize, Clone)] #[serde(deny_unknown_fields)] struct Card { front: String, back: String }
#[derive(Deserialize, Serialize)] #[serde(deny_unknown_fields)] struct ProposeCards { book_id: i64, cards: Vec<Card> }

#[derive(Clone, Serialize)]
struct ToolEvent<'a> { id: &'a str, call_id: &'a str, name: &'a str, input: &'a Value }
#[derive(Clone, Serialize)]
struct ToolResultEvent<'a> { id: &'a str, call_id: &'a str, name: &'a str, ok: bool, summary: String }

fn cap(s: &str, n: usize) -> String { if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) } }

/// Run one tool. Returns (content for the model, short summary for the UI, ok).
pub async fn run_tool(app: Option<&AppHandle>, db: &Db, embed: &crate::embeddings::EmbedConfig, request_id: &str, name: &str, input: &Value) -> (String, String, bool) {
    // Searches go through hybrid (BM25 + semantic) retrieval when embeddings are configured.
    if name == "search_library" || name == "search_book" {
        let parsed: Result<(String, Option<i64>, i64), String> = if name == "search_library" {
            serde_json::from_value::<QueryLimit>(input.clone()).map(|q| (q.query, None, q.limit)).map_err(|e| e.to_string())
        } else {
            serde_json::from_value::<BookQuery>(input.clone()).map(|q| (q.query, Some(q.book_id), q.limit)).map_err(|e| e.to_string())
        };
        return match parsed {
            Err(e) => (json!({"error": format!("invalid input: {e}")}).to_string(), "invalid input".into(), false),
            Ok((q, book, limit)) => match crate::embeddings::hybrid(db, embed, &q, book, limit.clamp(1, 12) as usize).await {
                Ok(hits) => {
                    let v = json!(hits.iter().map(|h| json!({"book_id": h.book_id, "title": h.title, "loc": h.loc, "text": cap(&h.text, 900)})).collect::<Vec<_>>());
                    (v.to_string(), format!("Searched {} for “{}” · {} passages", if book.is_some() { "the book" } else { "the library" }, q, hits.len()), true)
                }
                Err(e) => (json!({"error": e.to_string()}).to_string(), "search failed".into(), false),
            },
        };
    }
    run_tool_sync(app, db, request_id, name, input)
}

fn run_tool_sync(app: Option<&AppHandle>, db: &Db, request_id: &str, name: &str, input: &Value) -> (String, String, bool) {
    macro_rules! parse { ($t:ty) => { match serde_json::from_value::<$t>(input.clone()) { Ok(v) => v, Err(e) => return Err(AppError::Other(format!("invalid input: {e}"))) } } }
    let res: AppResult<(Value, String)> = (|| match name {
        "search_library" => {
            let q = parse!(QueryLimit);
            let hits = db.with(|c| reading::retrieve(c, &q.query, None, q.limit.clamp(1, 12)))?;
            Ok((json!(hits.iter().map(|h| json!({"book_id": h.book_id, "title": h.title, "loc": h.loc, "text": cap(&h.text, 900)})).collect::<Vec<_>>()), format!("Searched the library for “{}” · {} passages", q.query, hits.len())))
        }
        "search_book" => {
            let q = parse!(BookQuery);
            let hits = db.with(|c| reading::retrieve(c, &q.query, Some(q.book_id), q.limit.clamp(1, 12)))?;
            Ok((json!(hits.iter().map(|h| json!({"loc": h.loc, "text": cap(&h.text, 900)})).collect::<Vec<_>>()), format!("Searched the book for “{}” · {} passages", q.query, hits.len())))
        }
        "read_pages" => {
            let r = parse!(ReadPages);
            let (from, to) = (r.from.max(0), r.to.max(r.from).min(r.from.max(0) + 5));
            let mut out = vec![];
            for n in from..=to {
                for prefix in ["p", "s"] {
                    if let Some(t) = db.with(|c| reading::unit_text(c, r.book_id, &format!("{prefix}{n}")))? {
                        out.push(json!({"loc": format!("{prefix}{n}"), "text": cap(&t, 6000)}));
                        break;
                    }
                }
            }
            let summary = if from == to { format!("Read p. {from}") } else { format!("Read pp. {from}–{to}") };
            if out.is_empty() { return Ok((json!({"error": "no indexed text for that range (the book may not be indexed yet, or it is scanned without OCR)"}), format!("{summary} · no text"))); }
            Ok((json!(out), summary))
        }
        "find_books" => {
            let q = parse!(Query);
            let filter = crate::library::models::LibraryFilter { text: Some(q.query.clone()).filter(|s| !s.trim().is_empty()), sort: Some("opened".into()), ..Default::default() };
            let books = db.with(|c| store::list_books(c, &filter))?;
            Ok((json!(books.iter().take(15).map(|b| json!({"book_id": b.id, "title": b.title, "authors": b.authors, "year": b.year})).collect::<Vec<_>>()), format!("Found {} book(s) for “{}”", books.len().min(15), q.query)))
        }
        "get_book_info" => {
            let q = parse!(BookId);
            let b = db.with(|c| store::get_book(c, q.book_id))?;
            Ok((json!({"book_id": b.id, "title": b.title, "subtitle": b.subtitle, "authors": b.authors, "year": b.year, "publisher": b.publisher, "edition": b.edition, "pages": b.num_pages, "status": b.status, "progress_percent": (b.percent * 100.0).round(), "tags": b.tags.iter().map(|t| &t.name).collect::<Vec<_>>(), "description": b.description.as_deref().map(|d| cap(d, 800))}), format!("Looked up “{}”", cap(&b.title, 40))))
        }
        "list_annotations" => {
            let q = parse!(BookId);
            let anns = db.with(|c| reading::list_annotations(c, Some(q.book_id)))?;
            Ok((json!(anns.iter().take(80).map(|a| json!({"page": a.page_label, "kind": a.kind, "color": a.color, "text": a.text.as_deref().map(|t| cap(t, 400)), "comment": a.comment, "tags": a.tags})).collect::<Vec<_>>()), format!("Read {} of your annotations", anns.len().min(80))))
        }
        "open_page" => {
            let q = parse!(OpenPage);
            if let Some(app) = app { let _ = app.emit("assistant_open", json!({"book_id": q.book_id, "page": q.page})); }
            Ok((json!({"ok": true}), format!("Opened p. {}", q.page)))
        }
        "propose_note" => {
            let n = parse!(ProposeNote);
            if let Some(app) = app { let _ = app.emit("assistant_proposal", json!({"id": request_id, "kind": "note", "payload": &n})); }
            Ok((json!({"ok": true, "status": "shown to the user for confirmation"}), format!("Proposed a note: {}", cap(&n.title, 40))))
        }
        "propose_flashcards" => {
            let c = parse!(ProposeCards);
            if let Some(app) = app { let _ = app.emit("assistant_proposal", json!({"id": request_id, "kind": "cards", "payload": &c})); }
            Ok((json!({"ok": true, "status": "shown to the user for confirmation"}), format!("Proposed {} flashcards", c.cards.len())))
        }
        _ => Err(AppError::other(format!("unknown tool {name}"))),
    })();
    match res {
        Ok((v, s)) => (v.to_string(), s, true),
        Err(e) => {
            let msg = e.to_string();
            let summary = if msg.starts_with("invalid input") { "invalid input".to_string() } else { format!("{name} failed") };
            (json!({"error": msg}).to_string(), summary, false)
        }
    }
}

// ── Provider adapters ──────────────────────────────────────

#[derive(Debug, Default)]
pub struct Turn {
    /// Provider-native assistant message to append to history.
    pub assistant: Value,
    /// (call_id, name, parsed input or Err(raw))
    pub calls: Vec<(String, String, Result<Value, String>)>,
    pub stop: Option<String>,
    pub model: Option<String>,
}

pub fn anthropic_tools() -> Value {
    json!(tools().iter().map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.params, "strict": true, "eager_input_streaming": true})).collect::<Vec<_>>())
}

pub fn openai_tools() -> Value {
    json!(tools().iter().map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.params}})).collect::<Vec<_>>())
}

/// Gemini's schema subset has no `additionalProperties`.
fn strip_additional(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(k, _)| k.as_str() != "additionalProperties").map(|(k, v)| (k.clone(), strip_additional(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(strip_additional).collect()),
        x => x.clone(),
    }
}

pub fn gemini_tools() -> Value {
    json!([{ "functionDeclarations": tools().iter().map(|t| json!({"name": t.name, "description": t.description, "parameters": strip_additional(&t.params)})).collect::<Vec<_>>() }])
}

/// Accumulates an Anthropic SSE stream into content blocks (thinking/signature kept verbatim for echoing).
#[derive(Default)]
pub struct AnthropicAcc {
    blocks: Vec<(usize, Value, String)>, // (index, block, partial_json)
    pub stop: Option<String>,
    pub model: Option<String>,
    pub error: Option<String>,
}

impl AnthropicAcc {
    /// Feed one event; returns text to show to the user (if any).
    pub fn feed(&mut self, j: &Value) -> Option<String> {
        match j["type"].as_str()? {
            "message_start" => { self.model = j["message"]["model"].as_str().map(String::from); None }
            "content_block_start" => {
                let idx = j["index"].as_u64().unwrap_or(0) as usize;
                self.blocks.push((idx, j["content_block"].clone(), String::new()));
                None
            }
            "content_block_delta" => {
                let idx = j["index"].as_u64().unwrap_or(0) as usize;
                let b = self.blocks.iter_mut().rev().find(|b| b.0 == idx)?;
                let d = &j["delta"];
                match d["type"].as_str()? {
                    "text_delta" => {
                        let t = d["text"].as_str().unwrap_or("");
                        let cur = b.1["text"].as_str().unwrap_or("").to_string();
                        b.1["text"] = json!(cur + t);
                        Some(t.to_string())
                    }
                    "thinking_delta" => { let cur = b.1["thinking"].as_str().unwrap_or("").to_string(); b.1["thinking"] = json!(cur + d["thinking"].as_str().unwrap_or("")); None }
                    "signature_delta" => { b.1["signature"] = d["signature"].clone(); None }
                    "input_json_delta" => { b.2.push_str(d["partial_json"].as_str().unwrap_or("")); None }
                    _ => None,
                }
            }
            "message_delta" => { if let Some(s) = j["delta"]["stop_reason"].as_str() { self.stop = Some(s.into()); } None }
            "error" => { self.error = j["error"]["message"].as_str().map(String::from); None }
            _ => None,
        }
    }

    pub fn finish(mut self) -> Turn {
        self.blocks.sort_by_key(|b| b.0);
        // After a server-side fallback, only text before the last `fallback` marker is continuation context.
        let last_fb = self.blocks.iter().rposition(|b| b.1["type"] == "fallback");
        let mut content = vec![];
        let mut calls = vec![];
        for (i, (_, mut block, partial)) in self.blocks.into_iter().enumerate() {
            let ty = block["type"].as_str().unwrap_or("").to_string();
            if ty == "fallback" { continue; }
            if let Some(fb) = last_fb { if i < fb && ty != "text" { continue; } }
            if ty == "tool_use" {
                let id = block["id"].as_str().unwrap_or("").to_string();
                let name = block["name"].as_str().unwrap_or("").to_string();
                let parsed: Result<Value, String> = if partial.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str(&partial).map_err(|_| partial.clone()) };
                block["input"] = parsed.clone().unwrap_or(json!({}));
                calls.push((id, name, parsed));
            }
            content.push(block);
        }
        Turn { assistant: json!({"role": "assistant", "content": content}), calls, stop: self.stop, model: self.model }
    }
}

fn http() -> reqwest::Client { reqwest::Client::builder().timeout(std::time::Duration::from_secs(60 * 15)).build().unwrap() }

async fn sse(resp: reqwest::Response, cancel: &AtomicBool, mut f: impl FnMut(&str)) -> AppResult<()> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) { return Ok(()); }
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if let Some(d) = line.strip_prefix("data:") { f(d.trim()); }
        }
    }
    Ok(())
}

async fn error_text(resp: reqwest::Response, who: &str) -> AppError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body).ok().and_then(|j| j["error"]["message"].as_str().map(String::from)).unwrap_or(body);
    AppError::other(format!("{who} {status}: {msg}"))
}

async fn step_anthropic(app: &AppHandle, cfg: &LlmConfig, id: &str, system: &str, history: &[Value], cancel: &AtomicBool) -> AppResult<Turn> {
    let key = llm::get_key("anthropic").ok_or_else(|| AppError::other("No Anthropic API key saved. Add one in Settings → AI."))?;
    let mut body = json!({
        "model": cfg.model, "max_tokens": 32000, "stream": true,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "tools": anthropic_tools(), "tool_choice": {"type": "auto"},
        "messages": history,
    });
    if let Some(e) = cfg.effort.as_ref().filter(|e| !e.is_empty()) { body["output_config"] = json!({"effort": e}); }
    let fallbacks = cfg.fallbacks && matches!(cfg.model.as_str(), "claude-opus-5-5" | "claude-opus-5" | "claude-fable-5-1" | "claude-sonnet-5-5");
    if fallbacks { body["fallbacks"] = json!("default"); }
    let mut req = http().post("https://api.anthropic.com/v1/messages").header("x-api-key", key).header("anthropic-version", "2026-10-21");
    if fallbacks { req = req.header("anthropic-beta", "server-side-fallback-2026-07-01"); }
    let resp = req.json(&body).send().await?;
    if !resp.status().is_success() { return Err(error_text(resp, "Anthropic API").await); }
    let mut acc = AnthropicAcc::default();
    sse(resp, cancel, |d| {
        if let Ok(j) = serde_json::from_str::<Value>(d) {
            if let Some(t) = acc.feed(&j) { let _ = app.emit("llm_delta", json!({"id": id, "text": t})); }
        }
    }).await?;
    if let Some(e) = acc.error.take() { return Err(AppError::other(e)); }
    Ok(acc.finish())
}

async fn step_openai(app: &AppHandle, cfg: &LlmConfig, id: &str, system: &str, history: &[Value], cancel: &AtomicBool) -> AppResult<Turn> {
    let base = cfg.base_url.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| "https://api.openai.com/v1".into());
    let mut msgs = vec![json!({"role": "system", "content": system})];
    msgs.extend(history.iter().cloned());
    let mut req = http().post(format!("{}/chat/completions", base.trim_end_matches('/'))).json(&json!({"model": cfg.model, "stream": true, "messages": msgs, "tools": openai_tools()}));
    if let Some(k) = llm::get_key("openai") { req = req.bearer_auth(k); }
    let resp = req.send().await?;
    if !resp.status().is_success() { return Err(error_text(resp, &base).await); }
    let mut text = String::new();
    let mut calls: Vec<(String, String, String)> = vec![]; // id, name, arguments
    let mut stop = None;
    sse(resp, cancel, |d| {
        if d == "[DONE]" { return; }
        let Ok(j) = serde_json::from_str::<Value>(d) else { return };
        let delta = &j["choices"][0]["delta"];
        if let Some(t) = delta["content"].as_str() { text.push_str(t); let _ = app.emit("llm_delta", json!({"id": id, "text": t})); }
        for tc in delta["tool_calls"].as_array().into_iter().flatten() {
            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
            while calls.len() <= idx { calls.push((String::new(), String::new(), String::new())); }
            if let Some(v) = tc["id"].as_str() { calls[idx].0 = v.into(); }
            if let Some(v) = tc["function"]["name"].as_str() { calls[idx].1.push_str(v); }
            if let Some(v) = tc["function"]["arguments"].as_str() { calls[idx].2.push_str(v); }
        }
        if let Some(f) = j["choices"][0]["finish_reason"].as_str() { stop = Some(f.to_string()); }
    }).await?;
    let assistant = if calls.is_empty() { json!({"role": "assistant", "content": text}) } else {
        json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }, "tool_calls": calls.iter().map(|(i, n, a)| json!({"id": i, "type": "function", "function": {"name": n, "arguments": a}})).collect::<Vec<_>>()})
    };
    let calls = calls.into_iter().map(|(i, n, a)| { let p = if a.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str(&a).map_err(|_| a.clone()) }; (i, n, p) }).collect();
    Ok(Turn { assistant, calls, stop: stop.map(|s| if s == "tool_calls" { "tool_use".into() } else { s }), model: Some(cfg.model.clone()) })
}

async fn step_gemini(app: &AppHandle, cfg: &LlmConfig, id: &str, system: &str, history: &[Value], cancel: &AtomicBool) -> AppResult<Turn> {
    let key = llm::get_key("gemini").ok_or_else(|| AppError::other("No Gemini API key saved. Add your Google AI Studio key in Settings → AI."))?;
    let model = cfg.model.trim_start_matches("models/");
    let resp = http()
        .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"))
        .header("x-goog-api-key", key)
        .json(&json!({"systemInstruction": {"parts": [{"text": system}]}, "contents": history, "tools": gemini_tools()}))
        .send().await?;
    if !resp.status().is_success() { return Err(error_text(resp, "Gemini API").await); }
    let mut parts: Vec<Value> = vec![];
    let mut stop = None;
    sse(resp, cancel, |d| {
        let Ok(j) = serde_json::from_str::<Value>(d) else { return };
        let c = &j["candidates"][0];
        for p in c["content"]["parts"].as_array().into_iter().flatten() {
            if let Some(t) = p["text"].as_str() { if p["thought"] != json!(true) { let _ = app.emit("llm_delta", json!({"id": id, "text": t})); } }
            parts.push(p.clone()); // kept verbatim (incl. thoughtSignature) for echoing
        }
        if let Some(f) = c["finishReason"].as_str() { stop = Some(if f == "SAFETY" || f == "PROHIBITED_CONTENT" { "refusal".to_string() } else { f.to_lowercase() }); }
        if j["promptFeedback"]["blockReason"].is_string() { stop = Some("refusal".into()); }
    }).await?;
    let calls: Vec<(String, String, Result<Value, String>)> = parts.iter().filter(|p| p["functionCall"].is_object()).enumerate()
        .map(|(i, p)| (format!("g{i}"), p["functionCall"]["name"].as_str().unwrap_or("").to_string(), Ok(p["functionCall"]["args"].clone()))).collect();
    let stop = if !calls.is_empty() && stop.as_deref() != Some("refusal") { Some("tool_use".to_string()) } else { stop };
    Ok(Turn { assistant: json!({"role": "model", "parts": parts}), calls, stop, model: Some(model.to_string()) })
}

/// Tool results → provider-native message(s) to append.
pub fn results_message(provider: &str, results: &[(String, String, String, bool)]) -> Vec<Value> {
    match provider {
        "anthropic" => vec![json!({"role": "user", "content": results.iter().map(|(id, _, c, ok)| json!({"type": "tool_result", "tool_use_id": id, "content": c, "is_error": !ok})).collect::<Vec<_>>()})],
        "gemini" => vec![json!({"role": "user", "parts": results.iter().map(|(_, name, c, _)| json!({"functionResponse": {"name": name, "response": {"result": serde_json::from_str::<Value>(c).unwrap_or(json!(c))}}})).collect::<Vec<_>>()})],
        _ => results.iter().map(|(id, _, c, _)| json!({"role": "tool", "tool_call_id": id, "content": c})).collect(),
    }
}

/// Provider-native user message.
pub fn user_message(provider: &str, text: &str) -> Value {
    match provider {
        "gemini" => json!({"role": "user", "parts": [{"text": text}]}),
        _ => json!({"role": "user", "content": text}),
    }
}

#[derive(Serialize, Clone)]
pub struct AgentDone { pub id: String, pub stop_reason: Option<String>, pub model: Option<String>, pub error: Option<String>, pub history: Vec<Value>, pub provider: String }

/// Agent loop. `history` is the provider-native conversation so far (append-only); `user` is the new question.
pub async fn run(app: AppHandle, db: Db, cfg: LlmConfig, embed: crate::embeddings::EmbedConfig, id: String, system: String, mut history: Vec<Value>, user: String, cancel: &AtomicBool) -> AgentDone {
    let provider = cfg.provider.clone();
    history.push(user_message(&provider, &user));
    let mut last = (None, None);
    let mut retried = false;
    for _ in 0..MAX_STEPS {
        if cancel.load(Ordering::SeqCst) { break; }
        let turn = match provider.as_str() {
            "anthropic" => step_anthropic(&app, &cfg, &id, &system, &history, cancel).await,
            "gemini" => step_gemini(&app, &cfg, &id, &system, &history, cancel).await,
            _ => step_openai(&app, &cfg, &id, &system, &history, cancel).await,
        };
        let turn = match turn {
            Ok(t) => t,
            // A thinking block from an earlier turn no longer validates (system prompt or model changed since it
            // was created). Recover once by dropping thinking from completed turns instead of failing every message.
            Err(e) if provider == "anthropic" && !retried && is_thinking_binding_error(&e.to_string()) => {
                retried = true;
                history = strip_prior_thinking(history);
                match step_anthropic(&app, &cfg, &id, &system, &history, cancel).await {
                    Ok(t) => t,
                    Err(e) => return AgentDone { id, stop_reason: None, model: None, error: Some(e.to_string()), history, provider },
                }
            }
            Err(e) => return AgentDone { id, stop_reason: None, model: None, error: Some(e.to_string()), history, provider },
        };
        last = (turn.stop.clone(), turn.model.clone());
        history.push(turn.assistant.clone());
        let stop = turn.stop.as_deref();
        // Never run tools from a refused or truncated turn.
        if stop == Some("refusal") || stop == Some("max_tokens") || turn.calls.is_empty() || stop != Some("tool_use") { break; }
        let mut results = vec![];
        for (call_id, name, parsed) in &turn.calls {
            let input = parsed.clone().unwrap_or(json!({}));
            let _ = app.emit("llm_tool", ToolEvent { id: &id, call_id, name, input: &input });
            let (content, summary, ok) = match parsed {
                Ok(v) => run_tool(Some(&app), &db, &embed, &id, name, v).await,
                Err(raw) => (json!({"INVALID_JSON": raw}).to_string(), "invalid tool input".into(), false),
            };
            let _ = app.emit("llm_tool_result", ToolResultEvent { id: &id, call_id, name, ok, summary });
            results.push((call_id.clone(), name.clone(), content, ok));
        }
        // All results for this turn go back together in one message.
        history.extend(results_message(&provider, &results));
    }
    AgentDone { id, stop_reason: last.0, model: last.1, error: None, history, provider }
}

fn is_thinking_binding_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("signature") && e.contains("thinking")
}

/// Remove thinking blocks from assistant messages of *completed* turns (everything before the latest user text
/// message). The in-progress turn keeps its thinking so an ongoing tool loop stays intact.
pub fn strip_prior_thinking(history: Vec<Value>) -> Vec<Value> {
    let is_user_text = |m: &Value| m["role"] == "user" && (m["content"].is_string() || m["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "text")));
    let cut = history.iter().rposition(is_user_text).unwrap_or(0);
    history.into_iter().enumerate().map(|(i, mut m)| {
        if i < cut && m["role"] == "assistant" {
            if let Some(c) = m["content"].as_array() {
                let kept: Vec<Value> = c.iter().filter(|b| b["type"] != "thinking" && b["type"] != "redacted_thinking").cloned().collect();
                m["content"] = if kept.is_empty() { json!([{"type": "text", "text": "(no text)"}]) } else { Value::Array(kept) };
            }
        }
        m
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_thinking_only_from_completed_turns() {
        let h = vec![
            json!({"role": "user", "content": [{"type": "text", "text": "q1"}]}),
            json!({"role": "assistant", "content": [{"type": "thinking", "thinking": "t", "signature": "s"}, {"type": "text", "text": "a1"}]}),
            json!({"role": "user", "content": [{"type": "text", "text": "q2"}]}),
            json!({"role": "assistant", "content": [{"type": "thinking", "thinking": "t2", "signature": "s2"}, {"type": "tool_use", "id": "x", "name": "search_book", "input": {}}]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": "ok"}]}),
        ];
        let out = strip_prior_thinking(h);
        assert_eq!(out[1]["content"].as_array().unwrap().len(), 1, "earlier turn loses thinking");
        assert_eq!(out[1]["content"][0]["text"], "a1");
        assert_eq!(out[3]["content"][0]["type"], "thinking", "in-progress tool loop keeps thinking");
        assert!(is_thinking_binding_error("Anthropic API 400: messages.1.content.4: Invalid `signature` in `thinking` block."));
    }

    #[test]
    fn tool_schemas_are_strict_and_gemini_safe() {
        let t = anthropic_tools();
        for tool in t.as_array().unwrap() {
            assert_eq!(tool["strict"], true);
            assert_eq!(tool["eager_input_streaming"], true);
            assert_eq!(tool["input_schema"]["additionalProperties"], false);
            let req = tool["input_schema"]["required"].as_array().unwrap().len();
            assert_eq!(req, tool["input_schema"]["properties"].as_object().unwrap().len(), "all properties required");
        }
        assert!(!gemini_tools().to_string().contains("additionalProperties"));
    }

    #[test]
    fn anthropic_stream_accumulation() {
        let mut acc = AnthropicAcc::default();
        let evs = [
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me search."}}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "search_library", "input": {}}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"query\": \"quorum\", "}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "\"limit\": 5}"}}),
            json!({"type": "content_block_start", "index": 3, "content_block": {"type": "tool_use", "id": "toolu_2", "name": "open_page", "input": {}}}),
            json!({"type": "content_block_delta", "index": 3, "delta": {"type": "input_json_delta", "partial_json": "{\"book_id\": 3, \"pa"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ];
        let shown: Vec<String> = evs.iter().filter_map(|e| acc.feed(e)).collect();
        assert_eq!(shown, vec!["Let me search."]);
        let t = acc.finish();
        assert_eq!(t.stop.as_deref(), Some("tool_use"));
        assert_eq!(t.assistant["content"][0]["signature"], "sig", "thinking block echoed verbatim");
        assert_eq!(t.calls[0].2.as_ref().unwrap()["query"], "quorum");
        assert!(t.calls[1].2.is_err(), "truncated JSON is surfaced as invalid, not silently repaired");
    }

    #[test]
    fn tools_validate_and_run() {
        let db = Db::open_in_memory().unwrap();
        let id = db.with(|c| {
            let id = store::insert_book(c, "Raft Notes", &["D. Ongaro".into()], Some(2014))?;
            reading::index_book(c, id, &[reading::IndexUnit { loc: "p7".into(), text: "Raft uses randomized election timeouts to elect a leader.".into() }], true)?;
            Ok(id)
        }).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let e = crate::embeddings::EmbedConfig::default();
        let call = |name: &str, v: Value| rt.block_on(run_tool(None, &db, &e, "r", name, &v));
        let (c, s, ok) = call("search_library", json!({"query": "election timeouts", "limit": 3}));
        assert!(ok && c.contains("p7") && s.contains("1 passages"), "{c} {s}");
        let (c, _, ok) = call("read_pages", json!({"book_id": id, "from": 7, "to": 7}));
        assert!(ok && c.contains("randomized"));
        let (_, _, ok) = call("search_library", json!({"query": "x"}));
        assert!(!ok, "missing field rejected");
        let (_, _, ok) = call("search_library", json!({"query": "x", "limit": 1, "extra": 1}));
        assert!(!ok, "unknown field rejected");
        let r = results_message("anthropic", &[("toolu_1".into(), "search_library".into(), "{}".into(), true), ("toolu_2".into(), "open_page".into(), "{}".into(), false)]);
        assert_eq!(r.len(), 1, "parallel results in one user message");
        assert_eq!(r[0]["content"][1]["is_error"], true);
    }
}
