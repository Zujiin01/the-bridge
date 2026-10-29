#!/usr/bin/env node
// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// bridge-viewer: a minimal READ-ONLY page that shows the bridge conversation (for a public demo).
// It only reads the folder, only answers GET and HEAD, listens on 127.0.0.1, and masks before display:
// secrets, paths, IP addresses, ports, e-mails, long tokens and the names listed in <root>/.internal-names.
// Masking is a safety net: the real rule is that messages on a public bridge never contain those details.
//
// usage: BRIDGE_ROOT=<folder> [VIEWER_PORT=3700] [VIEWER_SINCE=20260101T000000] node bin/bridge-viewer.js
// Routes: /  (page, refreshes every 4 s)   /api/messages  (JSON)   /health
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("../lib/bridge");
const { redact } = require("../lib/redact");

const PORT = Number(process.env.VIEWER_PORT || 3700);
const HOST = process.env.VIEWER_HOST || "127.0.0.1";
const SINCE = process.env.VIEWER_SINCE || "";
const R = bridge.root();

function parse(txt) {
  const i = txt.indexOf("\n---\n");
  const h = {};
  for (const l of (i >= 0 ? txt.slice(0, i) : "").split("\n")) { const m = /^([A-Z-]+): ?(.*)$/.exec(l); if (m) h[m[1]] = m[2].trim(); }
  return { h, body: (i >= 0 ? txt.slice(i + 5) : txt).trim() };
}

function collect() {
  const names = bridge.internalNames(R), out = [], seen = new Set();
  const clean = (s) => redact(s, names);
  for (const a of bridge.agents(R)) {
    const box = bridge.boxDir(a, R);
    for (const dir of [box, path.join(box, "done")]) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch (_) { continue; }
      for (const f of files) {
        const m = /^(\d{8}T\d{6}-[0-9a-f]{4})\.(msg|reply\.md)$/.exec(f);
        if (!m || (SINCE && m[1] < SINCE)) continue;
        const kind = m[2] === "msg" ? "message" : "reply";
        if (seen.has(kind + m[1])) continue;
        seen.add(kind + m[1]);
        let txt; try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch (_) { continue; }
        const { h, body } = parse(txt);
        out.push({ id: m[1], kind, from: clean(h.FROM || "?"), to: clean(h.TO || "?"), created: h.CREATED || "", type: h.TYPE || "", status: h.STATUS || "", task: clean(h.TASK || ""), body: clean(body) });
      }
    }
  }
  return out.sort((x, y) => (x.created || x.id).localeCompare(y.created || y.id) || (x.kind === "message" ? -1 : 1));
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Bridge, live</title><style>
body{margin:0;background:#0b0f17;color:#e8edf5;font:16px/1.5 system-ui,sans-serif}header{padding:14px;text-align:center;border-bottom:1px solid #1e2636}
h1{margin:0;font-size:21px}p.sub{margin:4px 0 0;color:#8b98ad;font-size:14px}main{max-width:760px;margin:0 auto;padding:12px}
.m{background:#141b28;border:1px solid #1e2636;border-radius:12px;padding:10px 12px;margin:10px 0}.m.reply{margin-left:32px;background:#122019}
.meta{font-size:12px;color:#8b98ad}.task{font-weight:600}.body{white-space:pre-wrap}.st{font-size:12px;padding:1px 7px;border-radius:9px;background:#26324a}
</style></head><body><header><h1>The Bridge, live</h1><p class="sub">Two agents talk through a folder. Read-only, details masked.</p></header>
<main id="list">Loading...</main><script>
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
async function load(){try{const r=await fetch("api/messages");const j=await r.json();const L=document.getElementById("list");L.textContent="";
if(!j.messages.length)L.textContent="No message yet.";
for(const m of j.messages){const d=el("div","m "+m.kind);d.appendChild(el("div","meta",m.from+" \u2192 "+m.to+"  \u00b7  "+(m.created||m.id)+"  \u00b7  "+(m.kind==="reply"?"reply":m.type)));
if(m.status)d.appendChild(el("span","st",m.status));if(m.task)d.appendChild(el("div","task",m.task));d.appendChild(el("div","body",m.body));L.appendChild(d)}}catch(e){}}
load();setInterval(load,4000);</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  const u = req.url.split("?")[0];
  const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }); res.end(req.method === "HEAD" ? undefined : body); };
  if (u === "/health") return send(200, "application/json", JSON.stringify({ ok: true }));
  if (u === "/api/messages") return send(200, "application/json", JSON.stringify({ messages: collect() }));
  if (u === "/") return send(200, "text/html; charset=utf-8", PAGE);
  send(404, "application/json", JSON.stringify({ error: "not found" }));
});
server.listen(PORT, HOST, () => console.log(new Date().toISOString(), `bridge-viewer on http://${HOST}:${PORT}`));
