const API = "http://127.0.0.1:23120";
const $ = (id) => document.getElementById(id);
const store = chrome.storage?.local;
let item = null;

async function token() { return (await store.get("token")).token || ""; }
async function call(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", "X-Local-Lib-Token": await token(), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["detect.js"] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => detectCitation(document, location) });
    item = result;
  } catch {
    item = { url: tab.url, title: tab.title, authors: [] };
  }
  const ids = [item.doi && `DOI ${item.doi}`, item.arxiv && `arXiv ${item.arxiv}`, item.isbn && `ISBN ${item.isbn}`, item.pdf_url && "PDF"].filter(Boolean);
  $("item").innerHTML = "";
  const t = document.createElement("div"); t.className = "t"; t.textContent = item.title || item.url; $("item").append(t);
  const a = document.createElement("div"); a.className = "m"; a.textContent = [item.authors.slice(0, 3).join(", "), item.year].filter(Boolean).join(" · "); $("item").append(a);
  const c = document.createElement("div"); c.className = "row"; ids.forEach((x) => { const s = document.createElement("span"); s.className = "chip"; s.textContent = x; c.append(s); }); $("item").append(c);

  try {
    const ping = await call("/api/ping");
    if (!ping.authorized) { $("setup").hidden = false; return; }
    const cols = await call("/api/collections");
    for (const col of cols || []) { const o = document.createElement("option"); o.value = col.id; o.textContent = col.name; $("collection").append(o); }
    $("actions").hidden = false;
  } catch {
    $("status").innerHTML = '<span class="err">Local Lib isn\'t running (or the connector is off in Settings).</span>';
  }
}

$("saveToken").onclick = async () => { await store.set({ token: $("token").value.trim() }); location.reload(); };
$("save").onclick = async () => {
  $("save").disabled = true;
  try {
    await call("/api/save", { method: "POST", body: JSON.stringify({ ...item, collection_id: $("collection").value ? Number($("collection").value) : null }) });
    $("status").textContent = item.pdf_url ? "Saved — downloading the PDF in Local Lib." : "Saved to Local Lib.";
  } catch (e) {
    $("status").innerHTML = `<span class="err">${e.status === 401 ? "Token rejected — paste it again." : e.message}</span>`;
    if (e.status === 401) $("setup").hidden = false;
  } finally { $("save").disabled = false; }
};
init();
