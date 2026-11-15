// Storage: Postgres (e.g. Neon) when DATABASE_URL is set, otherwise a local JSON file (for testing only –
// on Render's free plan the disk is wiped on every deploy/restart).
"use strict";
const fs = require("fs");
const path = require("path");

const URL = process.env.DATABASE_URL || "";
let pool = null;
const mem = { docs: {}, blobs: {} };
const FILE = path.join(__dirname, "local-data.json");

module.exports = {
  kind: URL ? "postgres" : "local file",
  async init() {
    if (URL) {
      const { Pool } = require("pg");
      pool = new Pool({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false }, max: 5 });
      await pool.query(`create table if not exists docs(path text primary key, coll text not null, id text not null, data jsonb not null, updated_at timestamptz default now());
        create index if not exists docs_coll on docs(coll);
        create table if not exists blobs(id text primary key, type text not null, data bytea not null, created_at timestamptz default now());`);
    } else {
      try { Object.assign(mem, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch {}
    }
  },
  async get(p) {
    if (pool) { const r = await pool.query("select data from docs where path=$1", [p]); return r.rows[0] ? r.rows[0].data : null; }
    return mem.docs[p] ? JSON.parse(JSON.stringify(mem.docs[p])) : null;
  },
  async set(p, data) {
    const seg = p.split("/"); const id = seg.pop(); const coll = seg.join("/");
    if (pool) { await pool.query("insert into docs(path,coll,id,data,updated_at) values($1,$2,$3,$4,now()) on conflict(path) do update set data=excluded.data, updated_at=now()", [p, coll, id, data]); return; }
    mem.docs[p] = data; save();
  },
  async del(p) {
    if (pool) { await pool.query("delete from docs where path=$1", [p]); return; }
    delete mem.docs[p]; save();
  },
  async list(coll) {
    if (pool) { const r = await pool.query("select id, data from docs where coll=$1", [coll]); return r.rows.map((x) => ({ id: x.id, data: x.data })); }
    return Object.entries(mem.docs).filter(([k]) => k.slice(0, k.lastIndexOf("/")) === coll).map(([k, v]) => ({ id: k.slice(k.lastIndexOf("/") + 1), data: v }));
  },
  async putBlob(id, type, buf) {
    if (pool) { await pool.query("insert into blobs(id,type,data) values($1,$2,$3)", [id, type, buf]); return; }
    mem.blobs[id] = { type, data: buf.toString("base64") }; save();
  },
  async getBlob(id) {
    if (pool) { const r = await pool.query("select type, data from blobs where id=$1", [id]); return r.rows[0] || null; }
    const b = mem.blobs[id]; return b ? { type: b.type, data: Buffer.from(b.data, "base64") } : null;
  }
};
let t = null;
function save() { clearTimeout(t); t = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) { console.error(e); } }, 300); }
