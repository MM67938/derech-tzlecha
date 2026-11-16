"use strict";
const fs = require("fs");
const { execSync } = require("child_process");
const NAMES = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL", "ADMIN_TOKEN", "AI_PROVIDER", "CLAUDE_MODEL", "GEMINI_MODEL", "PLANS_PER_HOUR", "PLANS_PER_DAY_TOTAL"];
const found = {};
for (const n of NAMES) if (process.env[n] && String(process.env[n]).trim()) found[n] = String(process.env[n]).trim();
if (!Object.keys(found).length || !process.env.CLOUDFLARE_API_TOKEN && !process.env.WORKERS_CI) {
  console.log("[push-secrets] nothing to push");
  process.exit(0);
}
const file = ".secrets.tmp.json";
try {
  fs.writeFileSync(file, JSON.stringify(found));
  execSync("npx --yes wrangler secret bulk " + file, { stdio: "inherit" });
  console.log("[push-secrets] pushed: " + Object.keys(found).join(", "));
} catch (e) {
  console.log("[push-secrets] could not push secrets: " + e.message);
} finally {
  try { fs.unlinkSync(file); } catch {}
}
