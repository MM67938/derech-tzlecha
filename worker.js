// דרך צלחה – Cloudflare Workers version (no dependencies).
// Static files come from ./public (assets); this worker answers /api/*, /blob/* and /healthz.
// Data is kept in Neon Postgres through Neon's HTTPS SQL endpoint, so no database driver is needed.

const UID_RE = /^[a-z0-9]{16,40}$/;
const SEG_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp"];

/* ---------- per-isolate rate limits (best effort) ---------- */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
let limits = null;
function getLimits(env) {
  if (!limits) limits = {
    plan: rateLimiter(Number(env.PLANS_PER_HOUR || 12), 3600e3),
    day: rateLimiter(Number(env.PLANS_PER_DAY_TOTAL || 400), 86400e3),
    write: rateLimiter(120, 600e3),
    upload: rateLimiter(20, 3600e3)
  };
  return limits;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const uidOf = (req) => { const u = req.headers.get("x-uid") || ""; return UID_RE.test(u) ? u : null; };
const ipOf = (req) => req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
const isAdmin = (req, env) => !!env.ADMIN_TOKEN && req.headers.get("x-admin") === env.ADMIN_TOKEN;

/* ---------- Neon over HTTPS ---------- */
function dbUrl(env) {
  // accept the string as copied from Neon, even with "psql", quotes or spaces around it
  let u = String(env.DATABASE_URL || "").trim().replace(/^psql\s+/i, "").replace(/^['"]|['"]$/g, "").trim();
  return /^postgres(ql)?:\/\//i.test(u) ? u : "";
}
async function sql(env, query, params = []) {
  const conn = dbUrl(env);
  const url = new URL(conn.replace(/^postgres(ql)?:/i, "https:"));
  const r = await fetch("https://" + url.hostname + "/sql", {
    method: "POST",
    headers: { "content-type": "application/json", "Neon-Connection-String": conn, "Neon-Raw-Text-Output": "true", "Neon-Array-Mode": "false" },
    body: JSON.stringify({ query, params })
  });
  if (!r.ok) throw new Error("db " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.rows || [];
}
let dbReady = null;
function initDb(env) {
  if (!dbUrl(env)) return Promise.resolve();
  if (!dbReady) dbReady = (async () => {
    await sql(env, "create table if not exists docs(path text primary key, coll text not null, id text not null, data jsonb not null, updated_at timestamptz default now())");
    await sql(env, "create index if not exists docs_coll on docs(coll)");
    await sql(env, "create table if not exists blobs_b64(id text primary key, type text not null, b64 text not null, created_at timestamptz default now())");
  })().catch((e) => { dbReady = null; throw e; });
  return dbReady;
}
const mem = { docs: new Map(), blobs: new Map() }; // fallback when no DATABASE_URL (not durable)
const parseData = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const store = {
  async get(env, p) { if (!dbUrl(env)) return mem.docs.get(p) || null; const r = await sql(env, "select data from docs where path=$1", [p]); return r[0] ? parseData(r[0].data) : null; },
  async set(env, p, data) {
    const seg = p.split("/"); const id = seg.pop(); const coll = seg.join("/");
    if (!dbUrl(env)) { mem.docs.set(p, data); return; }
    await sql(env, "insert into docs(path,coll,id,data,updated_at) values($1,$2,$3,$4::jsonb,now()) on conflict(path) do update set data=excluded.data, updated_at=now()", [p, coll, id, JSON.stringify(data)]);
  },
  async del(env, p) { if (!dbUrl(env)) { mem.docs.delete(p); return; } await sql(env, "delete from docs where path=$1", [p]); },
  async list(env, coll) {
    if (!dbUrl(env)) return [...mem.docs].filter(([k]) => k.slice(0, k.lastIndexOf("/")) === coll).map(([k, v]) => ({ id: k.slice(k.lastIndexOf("/") + 1), data: v }));
    const r = await sql(env, "select id, data from docs where coll=$1", [coll]);
    return r.map((x) => ({ id: x.id, data: parseData(x.data) }));
  },
  async putBlob(env, id, type, b64) { if (!dbUrl(env)) { mem.blobs.set(id, { type, b64 }); return; } await sql(env, "insert into blobs_b64(id,type,b64) values($1,$2,$3)", [id, type, b64]); },
  async getBlob(env, id) { if (!dbUrl(env)) return mem.blobs.get(id) || null; const r = await sql(env, "select type, b64 from blobs_b64 where id=$1", [id]); return r[0] || null; }
};

/* ---------- AI ---------- */
let models = null;
async function pickModels(env) {
  if (models) return models;
  const m = { claude: env.CLAUDE_MODEL || "", gemini: env.GEMINI_MODEL || "" };
  if (env.ANTHROPIC_API_KEY && !m.claude) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
      const ids = ((await r.json()).data || []).map((x) => x.id);
      m.claude = ids.find((id) => /sonnet/i.test(id)) || ids[0] || "";
    } catch (e) { console.log("models claude", e.message); }
    m.claude = m.claude || "claude-sonnet-4-5";
  }
  if (env.GEMINI_API_KEY) {
    // all stable Flash models this key can use, newest first, then the lighter Flash-Lite ones as backups
    let flash = [], lite = [];
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
      const names = ((await r.json()).models || []).filter((x) => (x.supportedGenerationMethods || []).includes("generateContent")).map((x) => x.name.replace(/^models\//, ""));
      const ver = (n) => parseFloat(n.slice(7));
      flash = names.filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a, b) => ver(b) - ver(a));
      lite = names.filter((n) => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort((a, b) => ver(b) - ver(a));
    } catch (e) { console.log("models gemini", e.message); }
    const chosen = String(m.gemini || "").split(",").map((x) => x.trim()).filter(Boolean);
    const list = [...chosen, ...flash.slice(0, 3), ...lite.slice(0, 2)].filter((x, i, a) => a.indexOf(x) === i);
    m.geminiList = list.length ? list : ["gemini-2.5-flash"];
    m.gemini = m.geminiList[0];
  }
  return (models = m);
}
function providers(env) {
  const claude = env.ANTHROPIC_API_KEY && "claude", gemini = env.GEMINI_API_KEY && "gemini";
  return ((env.AI_PROVIDER || "auto").toLowerCase() === "gemini" ? [gemini, claude] : [claude, gemini]).filter(Boolean);
}
async function* sseData(body) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith("data:")) yield line.slice(5).trim(); }
  }
}
async function openStream(name, env, m, messages, wantJson, geminiModel) {
  if (name === "claude") {
    const system = "You plan family trips. Follow the user's instructions exactly." + (wantJson ? " Reply with one JSON value only, with no markdown fences and no text before or after it." : "");
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: m.claude, max_tokens: 20000, stream: true, system, messages }) });
    if (!r.ok) throw Object.assign(new Error("claude " + r.status + " " + (await r.text()).slice(0, 200)), { status: r.status });
    return (async function* () {
      for await (const d of sseData(r.body)) { let ev; try { ev = JSON.parse(d); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") yield ev.delta.text;
        else if (ev.type === "error") throw new Error("claude stream error"); }
    })();
  }
  const contents = messages.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
  const generationConfig = { maxOutputTokens: 30000, temperature: 0.7 }; if (wantJson) generationConfig.responseMimeType = "application/json";
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(geminiModel || m.gemini) + ":streamGenerateContent?alt=sse", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify({ contents, generationConfig }) });
  if (!r.ok) throw Object.assign(new Error("gemini " + r.status + " " + (await r.text()).slice(0, 200)), { status: r.status });
  return (async function* () {
    for await (const d of sseData(r.body)) { let ev; try { ev = JSON.parse(d); } catch { continue; }
      const c = ev.candidates && ev.candidates[0]; if (!c) continue;
      for (const p of (c.content && c.content.parts) || []) if (p.text && !p.thought) yield p.text; }
  })();
}
async function handleSample(req, env, ctx) {
  const list = providers(env);
  if (!list.length) return json({ code: "sampling_disabled" }, 503);
  let body; try { body = await req.json(); } catch { return json({ code: "invalid_request" }, 400); }
  const input = body && body.input;
  const messages = typeof input === "string" ? (input.trim() ? [{ role: "user", content: input }] : []) : Array.isArray(input) ? input.filter((x) => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string" && x.content.trim()) : [];
  if (!messages.length || messages[messages.length - 1].role !== "user" || JSON.stringify(messages).length > 300e3) return json({ code: "invalid_request" }, 400);
  const L = getLimits(env), ip = ipOf(req);
  if (!L.plan(uidOf(req) || ip) || !L.plan("ip:" + ip)) return json({ code: "rate_limited" }, 429);
  if (!L.day("all")) return json({ code: "rate_limited" }, 429);
  const m = await pickModels(env);
  // open the first provider that answers; fall back to the next one if it fails before streaming
  let iter = null, first = null, lastErr = null;
  const attempts = [];
  for (const name of list) {
    if (name === "gemini") for (const gm of m.geminiList) attempts.push(["gemini", gm]);
    else attempts.push([name, null]);
  }
  outer: for (const [name, gm] of attempts) {
    for (let tryNo = 0; tryNo < 3; tryNo++) {
      try { const it = await openStream(name, env, m, messages, !!body.json, gm); const f = await it.next(); if (f.done) { lastErr = new Error("empty"); break; } iter = it; first = f.value; break outer; }
      catch (e) {
        lastErr = e; console.log("[ai]", name, gm || "", e.message);
        const busy = [429, 500, 503, 504].includes(e.status);
        if (!busy) break;                       // e.g. bad key – no point retrying this model
        if (tryNo < 2) await new Promise((r) => setTimeout(r, 1500 * (tryNo + 1)));
      }
    }
  }
  if (!iter) return json({ code: lastErr && lastErr.status === 429 ? "rate_limited" : "upstream_error", detail: String(lastErr && lastErr.message || "").replace(/AIza[\w-]+/g, "***").slice(0, 400) }, lastErr && lastErr.status === 429 ? 429 : 502);
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(); const enc = new TextEncoder();
  ctx.waitUntil((async () => {
    try { await w.write(enc.encode(first)); for await (const t of iter) await w.write(enc.encode(t)); }
    catch (e) { console.log("[ai stream]", e.message); }
    finally { try { await w.close(); } catch {} }
  })());
  return new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/* ---------- data ---------- */
function access(p, req, env, write) {
  const seg = String(p || "").split("/");
  if (!seg.length || seg.some((s) => !SEG_RE.test(s) || s === "." || s === "..")) return false;
  const uid = uidOf(req);
  if (seg[0] === "data" && seg[1] === "users") return !!uid && seg[2] === uid && seg.length >= 4;
  if (seg[0] === "tips") return !write || (seg.length === 2 && (isAdmin(req, env) || (!!uid && seg[1] === uid)));
  return false;
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}
async function handleDb(req, env, url) {
  const q = url.searchParams, path = url.pathname, L = getLimits(env);
  if (path === "/api/db/doc" && req.method === "GET") {
    const p = q.get("path") || "";
    if (p.split("/").length % 2) return json({ code: "invalid_argument" }, 400);
    if (!access(p, req, env, false)) return json({ exists: false });
    const d = await store.get(env, p); return json(d ? { exists: true, data: d } : { exists: false });
  }
  if (path === "/api/db/doc" && req.method === "PUT") {
    const text = await req.text(); if (text.length > 400e3) return json({ code: "too_large" }, 413);
    let b; try { b = JSON.parse(text); } catch { return json({ code: "invalid_argument" }, 400); }
    const { path: p, data, merge } = b || {};
    if (typeof p !== "string" || p.split("/").length % 2 || !data || typeof data !== "object" || Array.isArray(data)) return json({ code: "invalid_argument" }, 400);
    if (!access(p, req, env, true)) return json({ code: "invalid_argument" }, 403);
    if (!L.write(uidOf(req) || ipOf(req))) return json({ code: "resource_exhausted" }, 429);
    if (merge) { const cur = await store.get(env, p); if (!cur) return json({ code: "invalid_argument" }, 404); await store.set(env, p, deepMerge(cur, data)); }
    else await store.set(env, p, data);
    return json({ ok: true });
  }
  if (path === "/api/db/doc" && req.method === "DELETE") {
    const p = q.get("path") || "";
    if (!access(p, req, env, true)) return json({ code: "invalid_argument" }, 403);
    await store.del(env, p); return json({ ok: true });
  }
  if (path === "/api/db/query" && req.method === "GET") {
    const coll = q.get("coll") || "";
    if (coll.split("/").length % 2 === 0) return json({ code: "invalid_argument" }, 400);
    if (!access(coll + "/x", req, env, false)) return json({ docs: [] });
    const docs = await store.list(env, coll); const ob = q.get("orderBy") || "";
    if (ob) { const dir = q.get("dir") === "desc" ? -1 : 1; docs.sort((a, b) => { const x = a.data[ob], y = b.data[ob]; if (x === y) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x > y ? 1 : -1) * dir; }); }
    return json({ docs: docs.slice(0, Math.min(1000, Number(q.get("limit")) || 1000)) });
  }
  return json({ code: "not_found" }, 404);
}
function toB64(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url); const p = url.pathname;
    try {
      if (p === "/healthz") return new Response("ok");
      if (p === "/api/me") return json({ admin: isAdmin(req, env), ai: providers(env) });
      if (p === "/api/sample" && req.method === "POST") return await handleSample(req, env, ctx);
      if (p.startsWith("/api/db/")) { await initDb(env); return await handleDb(req, env, url); }
      if (p === "/api/assets" && req.method === "POST") {
        const uid = uidOf(req); if (!uid) return json({ code: "not_uploader" }, 403);
        const type = (req.headers.get("content-type") || "").split(";")[0];
        if (!IMG_TYPES.includes(type)) return json({ code: "unsupported_type" }, 400);
        const L = getLimits(env); if (!L.upload(uid) || !L.upload("ip:" + ipOf(req))) return json({ code: "rate_limited" }, 429);
        const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 3e6) return json({ code: "too_large" }, 413);
        await initDb(env);
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
        await store.putBlob(env, id, type, toB64(buf));
        return json({ id, url: "/blob/" + id, sizeBytes: buf.byteLength, contentType: type });
      }
      const m = p.match(/^\/blob\/([a-f0-9]{32})$/);
      if (m) {
        await initDb(env); const b = await store.getBlob(env, m[1]);
        if (!b) return new Response("not found", { status: 404 });
        return new Response(fromB64(b.b64), { headers: { "content-type": b.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
      }
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response("לא נמצא", { status: 404 });
    } catch (e) {
      console.log("[error]", e && e.message);
      return json({ code: "unavailable" }, 500);
    }
  }
};
