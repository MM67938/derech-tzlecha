// דרך צלחה – standalone server (no external dependencies except "pg" when a database is used)
// Serves the app, proxies AI planning (Claude or Gemini), and stores saved trips / tips / photos.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
let CLAUDE_MODEL = process.env.CLAUDE_MODEL || "";   // empty = pick the newest Sonnet automatically
let GEMINI_MODEL = process.env.GEMINI_MODEL || "";   // empty = pick the newest Flash automatically
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// AI_PROVIDER: "claude", "gemini" or "auto" (Claude if its key exists, else Gemini; if one fails before answering, the other is tried)
const AI_PROVIDER = (process.env.AI_PROVIDER || "auto").toLowerCase();
const PLANS_PER_HOUR = Number(process.env.PLANS_PER_HOUR || 12);
const PLANS_PER_DAY_TOTAL = Number(process.env.PLANS_PER_DAY_TOTAL || 400);

/* ---------- small helpers ---------- */
const UID_RE = /^[a-z0-9]{16,40}$/;
function uidOf(req) { const u = String(req.headers["x-uid"] || ""); return UID_RE.test(u) ? u : null; }
function isAdmin(req) {
  const t = String(req.headers["x-admin"] || "");
  return !!ADMIN_TOKEN && t.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN));
}
function ipOf(req) { return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || ""; }
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}
const planLimit = rateLimiter(PLANS_PER_HOUR, 3600e3);
const dayLimit = rateLimiter(PLANS_PER_DAY_TOTAL, 86400e3);
const writeLimit = rateLimiter(120, 600e3);
const uploadLimit = rateLimiter(20, 3600e3);

function send(res, code, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit) {
  const b = await readBody(req, limit);
  try { return b.length ? JSON.parse(b.toString("utf8")) : {}; } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const PUB = path.join(__dirname, "public");
function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let p; try { p = decodeURIComponent(pathname); } catch { return false; }
  if (p.endsWith("/")) p += "index.html";
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB + path.sep)) return false;
  let st; try { st = fs.statSync(f); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith(".html") ? "no-cache" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") { res.end(); return true; }
  fs.createReadStream(f).pipe(res); return true;
}

/* ---------- AI providers ---------- */
function providers() {
  const claude = ANTHROPIC_KEY && { name: "claude", run: runClaude };
  const gemini = GEMINI_KEY && { name: "gemini", run: runGemini };
  const order = AI_PROVIDER === "gemini" ? [gemini, claude] : [claude, gemini];
  return order.filter(Boolean);
}
function toMessages(input) {
  if (typeof input === "string") return input.trim() ? [{ role: "user", content: input }] : [];
  if (Array.isArray(input)) return input.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  return [];
}
async function* sseData(body) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith("data:")) yield line.slice(5).trim(); }
  }
}
async function runClaude(messages, wantJson, onDelta, signal) {
  const system = "You plan family trips. Follow the user's instructions exactly." + (wantJson ? " Reply with one JSON value only, with no markdown fences and no text before or after it." : "");
  const r = await fetch(ANTHROPIC_BASE + "/v1/messages", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 20000, stream: true, system, messages })
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw Object.assign(new Error("claude " + r.status + " " + t.slice(0, 300)), { status: r.status }); }
  for await (const data of sseData(r.body)) {
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") onDelta(ev.delta.text);
    else if (ev.type === "error") throw new Error("claude stream error " + JSON.stringify(ev.error || {}));
  }
}
async function runGemini(messages, wantJson, onDelta, signal) {
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const generationConfig = { maxOutputTokens: 30000, temperature: 0.7 };
  if (wantJson) generationConfig.responseMimeType = "application/json";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODEL) + ":streamGenerateContent?alt=sse";
  const r = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify({ contents, generationConfig }) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw Object.assign(new Error("gemini " + r.status + " " + t.slice(0, 300)), { status: r.status }); }
  for await (const data of sseData(r.body)) {
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    const c = ev.candidates && ev.candidates[0]; if (!c) continue;
    for (const p of (c.content && c.content.parts) || []) if (p.text && !p.thought) onDelta(p.text);
  }
}

async function handleSample(req, res) {
  const list = providers();
  if (!list.length) return send(res, 503, { code: "sampling_disabled", message: "No AI key is configured on the server." });
  const body = await readJson(req, 300e3);
  const messages = toMessages(body.input);
  if (!messages.length || messages[messages.length - 1].role !== "user") return send(res, 400, { code: "invalid_request" });
  const ip = ipOf(req);
  if (!planLimit(uidOf(req) || ip) || !planLimit("ip:" + ip)) return send(res, 429, { code: "rate_limited", message: "Too many plans this hour" });
  if (!dayLimit("all")) return send(res, 429, { code: "rate_limited", message: "Daily limit reached" });

  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  let started = false;
  const onDelta = (t) => {
    if (!t) return;
    if (!started) { started = true; res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }); }
    res.write(t);
  };
  let lastErr = null;
  for (const p of list) {
    try {
      await p.run(messages, !!body.json, onDelta, ctl.signal);
      if (!started) return send(res, 502, { code: "empty_completion" });
      return res.end();
    } catch (e) {
      lastErr = e;
      if (ctl.signal.aborted) return res.end();
      console.error("[ai]", p.name, e.message);
      if (started) return res.end(); // already answering – cannot switch provider mid-answer
    }
  }
  const limited = lastErr && lastErr.status === 429;
  send(res, limited ? 429 : 502, { code: limited ? "rate_limited" : "upstream_error" });
}

/* ---------- data (saved trips, tips) ---------- */
// data/users/<uid>/...  private to that visitor
// tips/<uid>            everyone reads; only that visitor (or the admin) writes
function access(pathStr, req, write) {
  const seg = String(pathStr || "").split("/");
  if (!seg.length || seg.some((s) => !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s) || s === "." || s === "..")) return false;
  const uid = uidOf(req);
  if (seg[0] === "data" && seg[1] === "users") return !!uid && seg[2] === uid && seg.length >= 4;
  if (seg[0] === "tips") return !write || (seg.length === 2 && (isAdmin(req) || (!!uid && seg[1] === uid)));
  return false;
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}
async function handleDb(req, res, pathname, query) {
  const ip = ipOf(req);
  if (pathname === "/api/db/doc" && req.method === "GET") {
    const p = String(query.get("path") || "");
    if (p.split("/").length % 2) return send(res, 400, { code: "invalid_argument" });
    if (!access(p, req, false)) return send(res, 200, { exists: false });
    const d = await store.get(p); return send(res, 200, d ? { exists: true, data: d } : { exists: false });
  }
  if (pathname === "/api/db/doc" && req.method === "PUT") {
    const { path: p, data, merge } = await readJson(req, 400e3);
    if (typeof p !== "string" || p.split("/").length % 2 || !data || typeof data !== "object" || Array.isArray(data)) return send(res, 400, { code: "invalid_argument" });
    if (!access(p, req, true)) return send(res, 403, { code: "invalid_argument" });
    if (!writeLimit(uidOf(req) || ip)) return send(res, 429, { code: "resource_exhausted" });
    if (merge) { const cur = await store.get(p); if (!cur) return send(res, 404, { code: "invalid_argument" }); await store.set(p, deepMerge(cur, data)); }
    else await store.set(p, data);
    return send(res, 200, { ok: true });
  }
  if (pathname === "/api/db/doc" && req.method === "DELETE") {
    const p = String(query.get("path") || "");
    if (!access(p, req, true)) return send(res, 403, { code: "invalid_argument" });
    await store.del(p); return send(res, 200, { ok: true });
  }
  if (pathname === "/api/db/query" && req.method === "GET") {
    const coll = String(query.get("coll") || "");
    if (coll.split("/").length % 2 === 0) return send(res, 400, { code: "invalid_argument" });
    if (!access(coll + "/x", req, false)) return send(res, 200, { docs: [] });
    const docs = await store.list(coll);
    const ob = String(query.get("orderBy") || "");
    if (ob) { const dir = query.get("dir") === "desc" ? -1 : 1; docs.sort((a, b) => { const x = a.data[ob], y = b.data[ob]; if (x === y) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x > y ? 1 : -1) * dir; }); }
    return send(res, 200, { docs: docs.slice(0, Math.min(1000, Number(query.get("limit")) || 1000)) });
  }
  return send(res, 404, { code: "not_found" });
}

/* ---------- photos for tips ---------- */
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp"];
async function handleUpload(req, res) {
  const uid = uidOf(req); const ip = ipOf(req);
  if (!uid) return send(res, 403, { code: "not_uploader" });
  const type = String(req.headers["content-type"] || "").split(";")[0];
  if (!IMG_TYPES.includes(type)) return send(res, 400, { code: "unsupported_type" });
  if (!uploadLimit(uid) || !uploadLimit("ip:" + ip)) return send(res, 429, { code: "rate_limited" });
  const buf = await readBody(req, 3e6);
  if (!buf.length) return send(res, 400, { code: "unsupported_type" });
  const id = crypto.randomBytes(16).toString("hex");
  await store.putBlob(id, type, buf);
  send(res, 200, { id, url: "/blob/" + id, sizeBytes: buf.length, contentType: type });
}

/* ---------- server ---------- */
let ready = null;
function whenReady() { if (!ready) ready = store.init().then(pickModels).catch((e) => { ready = null; throw e; }); return ready; }
async function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (p.startsWith("/api/") || p.startsWith("/blob/")) await whenReady();
    if (p === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
    if (p === "/api/me" && req.method === "GET") return send(res, 200, { admin: isAdmin(req), ai: providers().map((x) => x.name) });
    if (p === "/api/sample" && req.method === "POST") return await handleSample(req, res);
    if (p.startsWith("/api/db/")) return await handleDb(req, res, p, u.searchParams);
    if (p === "/api/assets" && req.method === "POST") return await handleUpload(req, res);
    const m = p.match(/^\/blob\/([a-f0-9]{32})$/);
    if (m && req.method === "GET") {
      const b = await store.getBlob(m[1]);
      if (!b) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": b.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      return res.end(b.data);
    }
    if (serveStatic(req, res, p)) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("לא נמצא");
  } catch (e) {
    if (e.status !== 400 && e.status !== 413) console.error(e);
    send(res, e.status || 500, { code: e.status === 413 ? "too_large" : e.status === 400 ? "invalid_argument" : "unavailable" });
  }
}


/* ---------- pick models automatically when not set ---------- */
async function pickModels() {
  if (ANTHROPIC_KEY && !CLAUDE_MODEL) {
    try {
      const r = await fetch(ANTHROPIC_BASE + "/v1/models?limit=100", { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" } });
      const j = await r.json();
      const ids = (j.data || []).map((m) => m.id); // newest first
      CLAUDE_MODEL = ids.find((id) => /sonnet/i.test(id)) || ids[0] || "";
    } catch (e) { console.error("[models] claude", e.message); }
    if (!CLAUDE_MODEL) CLAUDE_MODEL = "claude-sonnet-4-5";
  }
  if (GEMINI_KEY && !GEMINI_MODEL) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": GEMINI_KEY } });
      const j = await r.json();
      const ok = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n));
      ok.sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)));
      GEMINI_MODEL = ok[0] || "";
    } catch (e) { console.error("[models] gemini", e.message); }
    if (!GEMINI_MODEL) GEMINI_MODEL = "gemini-2.5-flash";
  }
}

module.exports = handler; // used by Vercel (api/index.js)

if (require.main === module) whenReady().then(() => {
  http.createServer(handler).listen(PORT, () => console.log(`דרך צלחה on :${PORT} · AI: ${providers().map((x) => x.name + (x.name === "claude" ? " (" + CLAUDE_MODEL + ")" : " (" + GEMINI_MODEL + ")")).join(" → ") || "none"} · store: ${store.kind}`));
}).catch((e) => { console.error("startup failed", e); process.exit(1); });
