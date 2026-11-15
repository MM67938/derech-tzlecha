// Gives the app the same window.claude.use(...) interface it had inside Claude,
// backed by this site's own server.
(function () {
  "use strict";
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var uid = store("dz_uid");
  if (!uid || !/^[a-z0-9]{16,40}$/.test(uid)) {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    uid = Array.from(a, function (b) { return (b % 36).toString(36); }).join("") + Date.now().toString(36);
    store("dz_uid", uid);
  }
  var qp = new URLSearchParams(location.search);
  if (qp.get("admin")) { store("dz_admin", qp.get("admin")); history.replaceState(null, "", location.pathname + location.hash); }
  var admin = store("dz_admin") || "";
  function headers(extra) { var h = { "x-uid": uid }; if (admin) h["x-admin"] = admin; return Object.assign(h, extra || {}); }
  function err(code, message, text) { var e = { code: code, message: message || code }; if (text) e.text = text; return e; }

  /* ---------- sample (AI) ---------- */
  function parseJSON(t) {
    try { return JSON.parse(t); } catch (e) {}
    var m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    var i = t.search(/[\[{]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {} }
    throw err("invalid_json", "Could not read the answer", t);
  }
  async function run(input, opts, wantJson) {
    opts = opts || {};
    var text = "", res;
    try {
      res = await fetch("/api/sample", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ input: input, json: wantJson }), signal: opts.signal });
    } catch (e) { throw err(opts.signal && opts.signal.aborted ? "cancelled" : "upstream_error"); }
    if (!res.ok) { var j = {}; try { j = await res.json(); } catch (e) {} throw err(j.code || (res.status === 429 ? "rate_limited" : "upstream_error"), j.message); }
    var reader = res.body.getReader(), dec = new TextDecoder();
    try {
      for (;;) {
        var r = await reader.read(); if (r.done) break;
        var d = dec.decode(r.value, { stream: true });
        if (d) { text += d; if (opts.onText) { try { opts.onText({ text: text, delta: d }); } catch (e) { console.error(e); } } }
      }
    } catch (e) { throw err(opts.signal && opts.signal.aborted ? "cancelled" : "upstream_error", "", text); }
    if (!text.trim()) throw err("empty_completion");
    return text;
  }
  function sample(input, opts) { return run(input, opts, false).then(function (t) { return { text: t, truncated: false, modelTierApplied: "default" }; }); }
  sample.json = function (input, opts) { return run(input, opts, true).then(parseJSON); };
  sample.limits = function () { return Promise.resolve({ maxPromptBytes: 262144 }); };

  /* ---------- db ---------- */
  function snapDoc(id, data) { return { id: id, exists: data != null, data: function () { return data == null ? undefined : JSON.parse(JSON.stringify(data)); }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  async function api(method, url, body) {
    var r = await fetch(url, { method: method, headers: headers(body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw err(r.status === 429 ? "resource_exhausted" : "invalid_argument");
    return r.json();
  }
  var listeners = new Set();
  function notify() { listeners.forEach(function (fn) { fn(); }); }
  function randId() { var a = new Uint8Array(10); crypto.getRandomValues(a); return Array.from(a, function (b) { return (b % 36).toString(36); }).join(""); }
  function docRef(p) {
    var id = p.slice(p.lastIndexOf("/") + 1);
    return {
      id: id, path: p,
      get: async function () { var j = await api("GET", "/api/db/doc?path=" + encodeURIComponent(p)); return snapDoc(id, j.exists ? j.data : null); },
      set: async function (data) { await api("PUT", "/api/db/doc", { path: p, data: data }); notify(); },
      update: async function (data) { await api("PUT", "/api/db/doc", { path: p, data: data, merge: true }); notify(); },
      delete: async function () { await api("DELETE", "/api/db/doc?path=" + encodeURIComponent(p)); notify(); },
      onSnapshot: function (next, onErr) { var self = this; return poll(function () { return self.get(); }, next, onErr); },
      collection: function (sub) { return collRef(p + "/" + sub); }
    };
  }
  function query(coll, order, lim) {
    var q = {
      where: function () { return q; },
      orderBy: function (f, dir) { return query(coll, { f: f, dir: dir || "asc" }, lim); },
      limit: function (n) { return query(coll, order, n); },
      get: async function () {
        var u = "/api/db/query?coll=" + encodeURIComponent(coll) + (order ? "&orderBy=" + encodeURIComponent(order.f) + "&dir=" + order.dir : "") + (lim ? "&limit=" + lim : "");
        var j = await api("GET", u);
        var docs = j.docs.map(function (d) { return snapDoc(d.id, d.data); });
        return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
      },
      onSnapshot: function (next, onErr) { return poll(q.get, next, onErr); }
    };
    return q;
  }
  function collRef(coll) {
    var q = query(coll);
    q.path = coll;
    q.doc = function (id) { return docRef(coll + "/" + (id || randId())); };
    q.add = async function (data) { var r = q.doc(); await r.set(data); return r; };
    return q;
  }
  function poll(getter, next, onErr) {
    var dead = false, timer = null, last = "";
    async function tick() {
      if (dead) return;
      try { var s = await getter(); var sig = JSON.stringify(s.docs ? s.docs.map(function (d) { return [d.id, d.data()]; }) : [s.exists, s.data()]); if (sig !== last) { last = sig; next(s); } }
      catch (e) { if (onErr) { onErr(e); dead = true; return; } }
      if (!dead) timer = setTimeout(tick, document.hidden ? 30000 : 8000);
    }
    var fire = function () { clearTimeout(timer); tick(); };
    listeners.add(fire); tick();
    return function () { dead = true; clearTimeout(timer); listeners.delete(fire); };
  }
  var db = { doc: docRef, collection: collRef };

  /* ---------- user ---------- */
  var me = fetch("/api/me", { headers: headers() }).then(function (r) { return r.json(); }).catch(function () { return { admin: false }; });
  var user = {
    id: function () { return Promise.resolve(uid); },
    isOwner: function () { return me.then(function (m) { return !!m.admin; }); },
    canEdit: function () { return me.then(function (m) { return !!m.admin; }); },
    can: function () { return Promise.resolve(true); },
    me: function () { return Promise.resolve({ id: uid, name: "" }); },
    profiles: function () { return Promise.resolve({}); }
  };

  /* ---------- assets (tip photos) ---------- */
  var assets = {
    upload: async function (blob) {
      var r = await fetch("/api/assets", { method: "POST", headers: headers({ "content-type": blob.type || "image/jpeg" }), body: blob });
      if (!r.ok) throw err(r.status === 429 ? "rate_limited" : "upstream_error");
      return r.json();
    },
    list: function () { return Promise.resolve({ assets: [], usage: {} }); },
    delete: function () { return Promise.resolve({ deleted: false }); }
  };

  /* ---------- downloads ---------- */
  var downloads = {
    save: async function (req) {
      var type = /\.ics$/i.test(req.filename) ? "text/calendar;charset=utf-8" : /\.html?$/i.test(req.filename) ? "text/html;charset=utf-8" : "application/octet-stream";
      var b = req.data instanceof Blob ? req.data : new Blob([req.data], { type: type });
      var u = URL.createObjectURL(b), a = document.createElement("a");
      a.href = u; a.download = req.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
      return { status: "saved" };
    }
  };

  var caps = { sample: sample, db: db, user: user, assets: assets, downloads: downloads };
  window.claude = { use: function (name) { return Promise.resolve(caps[name] || null); } };
})();
