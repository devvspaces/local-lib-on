//! Local connector server for the browser extension (and optional Zotero-Connector compatibility).
//! Loopback only. Native API requires a per-install token; Zotero mode requires Zotero's
//! non-simple `X-Zotero-Connector-API-Version` header so ordinary web pages can't post items.
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

pub const PORT: u16 = 23120;
pub const ZOTERO_PORT: u16 = 23119;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SaveRequest {
    pub url: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub authors: Vec<String>,
    pub doi: Option<String>,
    pub isbn: Option<String>,
    pub arxiv: Option<String>,
    pub pdf_url: Option<String>,
    pub year: Option<i64>,
    pub publisher: Option<String>,
    pub abstract_text: Option<String>,
    pub collection_id: Option<i64>,
    /// "extension" | "zotero"
    #[serde(default)]
    pub source: String,
}

#[derive(Default, Clone)]
pub struct Connector {
    servers: Arc<Mutex<Vec<Arc<Server>>>>,
}

fn json<T: Serialize>(code: u16, v: &T, origin: Option<&str>) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut r = Response::from_data(serde_json::to_vec(v).unwrap_or_default()).with_status_code(code);
    r.add_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    if let Some(o) = origin.filter(|o| is_extension_origin(o)) {
        r.add_header(Header::from_bytes("Access-Control-Allow-Origin", o).unwrap());
        r.add_header(Header::from_bytes("Access-Control-Allow-Headers", "Content-Type, X-Local-Lib-Token, X-Zotero-Connector-API-Version, X-Zotero-Version").unwrap());
        r.add_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap());
    }
    r
}

pub fn is_extension_origin(o: &str) -> bool {
    o.starts_with("chrome-extension://") || o.starts_with("moz-extension://") || o.starts_with("safari-web-extension://")
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
}

/// Decide what to do with a request. Pure (for tests): returns (status, body, optional save).
pub fn route(method: &str, path: &str, token_ok: bool, zotero: bool, has_zotero_header: bool, origin: Option<&str>, body: &str, collections: &serde_json::Value)
    -> (u16, serde_json::Value, Option<SaveRequest>) {
    use serde_json::json;
    // Browser pages (non-extension origins) are never allowed.
    if origin.map_or(false, |o| !is_extension_origin(o) && o != "null") {
        return (403, json!({"error": "forbidden origin"}), None);
    }
    if method == "OPTIONS" {
        return (204, json!({}), None);
    }
    if zotero {
        return match (method, path) {
            ("GET" | "POST", "/connector/ping") => (200, json!({"prefs": {"automaticSnapshots": false}, "app": "Local Lib (Zotero-compatible)"}), None),
            ("POST", "/connector/getSelectedCollection") => (200, json!({"libraryID": 1, "libraryName": "Local Lib", "libraryEditable": true, "editable": true, "id": null, "name": "Local Lib", "targets": []}), None),
            ("POST", "/connector/saveItems") | ("POST", "/connector/saveSnapshot") if has_zotero_header => {
                let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
                let items = if path.ends_with("saveItems") { v["items"].as_array().cloned().unwrap_or_default() } else { vec![v.clone()] };
                let first = items.first().cloned().unwrap_or_default();
                let save = zotero_item_to_save(&first);
                (201, json!({}), Some(save))
            }
            ("POST", _) => (403, json!({"error": "missing connector header"}), None),
            _ => (404, json!({"error": "not found"}), None),
        };
    }
    match (method, path) {
        ("GET", "/api/ping") => (200, json!({"ok": true, "app": "Local Lib", "authorized": token_ok}), None),
        _ if !token_ok => (401, json!({"error": "invalid or missing token"}), None),
        ("GET", "/api/collections") => (200, collections.clone(), None),
        ("POST", "/api/save") => match serde_json::from_str::<SaveRequest>(body) {
            Ok(mut s) => {
                s.source = "extension".into();
                if s.title.is_none() && s.doi.is_none() && s.isbn.is_none() && s.arxiv.is_none() && s.url.is_none() {
                    return (400, json!({"error": "nothing to save"}), None);
                }
                (202, json!({"ok": true}), Some(s))
            }
            Err(e) => (400, json!({"error": e.to_string()}), None),
        },
        _ => (404, json!({"error": "not found"}), None),
    }
}

fn zotero_item_to_save(it: &serde_json::Value) -> SaveRequest {
    let s = |k: &str| it[k].as_str().map(String::from).filter(|x| !x.is_empty());
    let pdf = it["attachments"].as_array().and_then(|a| a.iter().find(|x| x["mimeType"] == "application/pdf")).and_then(|x| x["url"].as_str().map(String::from));
    SaveRequest {
        url: s("url"),
        title: s("title"),
        authors: it["creators"].as_array().map(|cs| cs.iter().filter_map(|c| {
            let n = format!("{} {}", c["firstName"].as_str().unwrap_or(""), c["lastName"].as_str().or(c["name"].as_str()).unwrap_or("")).trim().to_string();
            (!n.is_empty()).then_some(n)
        }).collect()).unwrap_or_default(),
        doi: s("DOI"),
        isbn: s("ISBN").map(|i| i.split_whitespace().next().unwrap_or("").to_string()),
        pdf_url: pdf,
        year: s("date").and_then(|d| regex::Regex::new(r"(1[5-9]|20)\d{2}").unwrap().find(&d).and_then(|m| m.as_str().parse().ok())),
        publisher: s("publisher").or(s("publicationTitle")),
        abstract_text: s("abstractNote"),
        source: "zotero".into(),
        ..Default::default()
    }
}

impl Connector {
    pub fn stop(&self) {
        for s in self.servers.lock().unwrap().drain(..) {
            s.unblock();
        }
    }

    /// (Re)start listeners. `collections` is fetched per request via the callback.
    pub fn start(&self, app: AppHandle, token: String, zotero_mode: bool, collections: Arc<dyn Fn() -> serde_json::Value + Send + Sync>) {
        self.stop();
        let mut ports = vec![(PORT, false)];
        if zotero_mode {
            ports.push((ZOTERO_PORT, true));
        }
        for (port, zotero) in ports {
            let server = match Server::http(("127.0.0.1", port)) {
                Ok(s) => Arc::new(s),
                Err(e) => {
                    eprintln!("[Connector] cannot listen on {port}: {e}");
                    let _ = app.emit("connector_error", format!("Port {port} is in use{}", if zotero { " (is Zotero running?)" } else { "" }));
                    continue;
                }
            };
            self.servers.lock().unwrap().push(server.clone());
            let (app, token, collections) = (app.clone(), token.clone(), collections.clone());
            thread::spawn(move || {
                for mut req in server.incoming_requests() {
                    let origin = header(&req, "Origin");
                    let token_ok = header(&req, "X-Local-Lib-Token").map_or(false, |t| !token.is_empty() && t == token);
                    let has_z = header(&req, "X-Zotero-Connector-API-Version").is_some();
                    let mut body = String::new();
                    let _ = req.as_reader().take(2 * 1024 * 1024).read_to_string(&mut body);
                    let method = req.method().to_string();
                    let path = req.url().split('?').next().unwrap_or("").to_string();
                    let cols = if path == "/api/collections" && token_ok { collections() } else { serde_json::Value::Null };
                    let (code, out, save) = route(&method, &path, token_ok, zotero, has_z, origin.as_deref(), &body, &cols);
                    if let Some(s) = save {
                        let _ = app.emit("connector_save", s);
                    }
                    let _ = req.respond(json(code, &out, origin.as_deref()));
                    let _ = Method::Get;
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn auth_and_routing() {
        let cols = json!([{"id": 1, "name": "Papers"}]);
        let ext = Some("chrome-extension://abc");
        assert_eq!(route("GET", "/api/ping", false, false, false, ext, "", &cols).0, 200);
        assert_eq!(route("POST", "/api/save", false, false, false, ext, r#"{"doi":"10.1/x"}"#, &cols).0, 401, "token required");
        let (code, _, save) = route("POST", "/api/save", true, false, false, ext, r#"{"doi":"10.1/x","title":"T"}"#, &cols);
        assert_eq!(code, 202);
        assert_eq!(save.unwrap().doi.as_deref(), Some("10.1/x"));
        assert_eq!(route("POST", "/api/save", true, false, false, Some("https://evil.example"), "{}", &cols).0, 403, "web pages blocked");
        assert_eq!(route("GET", "/api/collections", true, false, false, ext, "", &cols).1, cols);
    }

    #[test]
    fn zotero_mode() {
        let body = r#"{"items":[{"itemType":"journalArticle","title":"Attention","creators":[{"firstName":"Ashish","lastName":"Vaswani"}],"DOI":"10.48550/x","date":"2017-06-12","attachments":[{"url":"https://arxiv.org/pdf/1706.03762","mimeType":"application/pdf"}]}]}"#;
        assert_eq!(route("POST", "/connector/saveItems", false, true, false, None, body, &json!(null)).0, 403, "needs connector header");
        let (code, _, save) = route("POST", "/connector/saveItems", false, true, true, None, body, &json!(null));
        assert_eq!(code, 201);
        let s = save.unwrap();
        assert_eq!(s.authors, vec!["Ashish Vaswani"]);
        assert_eq!(s.year, Some(2017));
        assert_eq!(s.pdf_url.as_deref(), Some("https://arxiv.org/pdf/1706.03762"));
    }
}
