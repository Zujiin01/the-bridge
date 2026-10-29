#!/usr/bin/env node
// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// bridge-web: the bridge web page behind a key. The human reads the agents' conversation live, writes in the
// channel with their tag (the message is dropped in every agent's inbox and wakes them), attaches files,
// dictates, and listens to messages read aloud. Node built-in modules only. Listens on 127.0.0.1 (nginx in front).
// Read docs/WEB-PAGE.md first: it lists the prerequisites.
//
// Environment:
//   BRIDGE_ROOT        the bridge folder (required)
//   BRIDGE_WEB_URL     the public address, e.g. https://bridge.example.com (without it: local mode, http://127.0.0.1:<port>)
//   BRIDGE_WEB_PORT    port on 127.0.0.1 (default 3360)
//   BRIDGE_HUMAN       the human's sender name in the bridge (default: the first name in <root>/.humans)
//   BRIDGE_LANG        language of the page (en, fr; default: the browser's language, else en)
//   BRIDGE_SPEECH_LANG force the dictation / read-aloud language (e.g. fr-FR); default from the page language
//   BRIDGE_WEB_DIR     private folder for keys and the session secret (default ~/.config/bridge/web, mode 700)
//   BRIDGE_WEB_AGENTS  agents that receive the human's messages (default: every inbox), comma separated
//   BRIDGE_WEB_SINCE   hide messages older than this ID (YYYYMMDDTHHMMSS)
//   BRIDGE_WEB_TITLE   page title (default from the language file)
//   BRIDGE_WEB_SESSION_DAYS  session length (default 7)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bridge = require("../lib/bridge");
const { redact } = require("../lib/redact");
const keystore = require("../lib/keystore");
const i18n = require("../lib/web-i18n");

const PORT = Number(process.env.BRIDGE_WEB_PORT || 3360);
const R = bridge.root();
if (!fs.existsSync(R)) { console.error(`bridge folder not found: run bridge-init first`); process.exit(2); }
const BASE = (process.env.BRIDGE_WEB_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const HTTPS = /^https:\/\//.test(BASE);
const ORIGIN = new URL(BASE).origin;
const SINCE = process.env.BRIDGE_WEB_SINCE || "";
const SESSION_S = Number(process.env.BRIDGE_WEB_SESSION_DAYS || 7) * 86400;
const MAX_TEXT = 4000, MAX_FILE = 10 * 1024 * 1024;
const FILES = path.join(R, "files");
// The secure cookie needs HTTPS. In local mode (http://127.0.0.1) a plain cookie is used instead.
const COOKIE = HTTPS ? "__Host-bridge" : "bridge_local";
const WEB = path.join(__dirname, "..", "web");

function human() {
  const list = bridge.humans(R);
  const h = String(process.env.BRIDGE_HUMAN || list[0] || "").toLowerCase();
  return h;
}
{
  const h = human();
  if (!h) { console.error("no human declared: run bridge-init --root <bridge> --humans <name> (for example dj)"); process.exit(2); }
  if (!bridge.humans(R).includes(h)) { console.error(`the human "${h}" is not declared: run bridge-init --root <bridge> --humans ${h}`); process.exit(2); }
}
const ks = keystore.open(process.env.BRIDGE_WEB_KEYS);
const SECRET = keystore.sessionSecret(process.env.BRIDGE_WEB_SECRET_FILE);
if (!fs.existsSync(FILES)) fs.mkdirSync(FILES, { recursive: true, mode: 0o700 });
fs.chmodSync(FILES, 0o700);

function recipients() {
  const all = bridge.agents(R);
  const want = String(process.env.BRIDGE_WEB_AGENTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return want.length ? all.filter((a) => want.includes(a)) : all;
}

// ---------- files accepted (extension AND signature) ----------
const TYPES = {
  png: ["image/png", "image"], jpg: ["image/jpeg", "image"], jpeg: ["image/jpeg", "image"], gif: ["image/gif", "image"], webp: ["image/webp", "image"],
  pdf: ["application/pdf", "pdf"],
  txt: ["text/plain; charset=utf-8", "text"], md: ["text/plain; charset=utf-8", "text"], csv: ["text/csv; charset=utf-8", "text"], log: ["text/plain; charset=utf-8", "text"],
  mp3: ["audio/mpeg", "audio"], m4a: ["audio/mp4", "audio"], ogg: ["audio/ogg", "audio"], opus: ["audio/ogg", "audio"], wav: ["audio/wav", "audio"], webm: ["audio/webm", "audio"],
};
function sniff(ext, b) {
  const s = (i, str) => b.slice(i, i + str.length).toString("latin1") === str;
  switch (ext) {
    case "png": return b[0] === 0x89 && s(1, "PNG");
    case "jpg": case "jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "gif": return s(0, "GIF87a") || s(0, "GIF89a");
    case "webp": return s(0, "RIFF") && s(8, "WEBP");
    case "pdf": return s(0, "%PDF-");
    case "mp3": return s(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case "m4a": return s(4, "ftyp");
    case "ogg": case "opus": return s(0, "OggS");
    case "wav": return s(0, "RIFF") && s(8, "WAVE");
    case "webm": return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case "txt": case "md": case "csv": case "log":
      if (b.includes(0)) return false;
      try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch (_) { return false; }
    default: return false;
  }
}
function cleanName(n) {
  const base = String(n || "").split(/[\\/]/).pop().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const s = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").replace(/^[.\s_-]+/, "").trim();
  if (!s) return "";
  const dot = s.lastIndexOf(".");
  return dot > 0 ? s.slice(0, dot).slice(0, 70) + s.slice(dot).slice(0, 8) : s.slice(0, 78);
}
const STORED_RE = /^[0-9a-f]{24}\.[a-z0-9]{2,5}$/; // 24 hex: shorter than the 32-character "long token" rule of a public bridge

// ---------- reading the bridge ----------
function parse(txt) {
  const i = txt.indexOf("\n---\n");
  const h = {};
  for (const l of (i >= 0 ? txt.slice(0, i) : "").split("\n")) { const m = /^([A-Z-]+): ?(.*)$/.exec(l); if (m) h[m[1]] = m[2].trim(); }
  return { h, body: (i >= 0 ? txt.slice(i + 5) : txt).trim() };
}
function attachment(h, clean) {
  const f = h["X-FILE"];
  if (!f || !STORED_RE.test(f)) return null;
  const ext = f.split(".").pop();
  if (!TYPES[ext]) return null;
  return { url: "f/" + f, name: clean(h["X-FILE-NAME"] || f).slice(0, 100), kind: TYPES[ext][1], size: Number(h["X-FILE-SIZE"]) || 0 };
}
function collect() {
  const names = bridge.internalNames(R), humans = bridge.humans(R), agents = bridge.agents(R);
  const clean = (s) => redact(s, names);
  const side = (from) => (humans.includes(from) ? "human" : "a" + (Math.max(0, agents.indexOf(from)) % 2));
  const out = [], seen = new Set();
  for (const a of agents) {
    const box = bridge.boxDir(a, R);
    for (const dir of [box, path.join(box, "done")]) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch (_) { continue; }
      for (const f of files) {
        const m = /^(\d{8}T\d{6}-[0-9a-f]{4})\.(msg|reply\.md)$/.exec(f);
        if (!m || (SINCE && m[1] < SINCE)) continue;
        const kind = m[2] === "msg" ? "message" : "reply";
        // A human message sits in every inbox with the same ID: shown once. Replies: one per inbox.
        const key = kind === "message" ? "m" + m[1] : "r" + m[1] + a;
        if (seen.has(key)) continue;
        seen.add(key);
        let txt; try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch (_) { continue; }
        const { h, body } = parse(txt);
        const from = String(h.FROM || (kind === "reply" ? a : "?")).toLowerCase();
        const sd = side(from);
        out.push({
          id: m[1], kind, side: sd,
          from: sd === "human" ? String(h["X-AUTHOR"] || from).toUpperCase().slice(0, 12) : clean(from),
          created: h.CREATED || "", status: h.STATUS || "", type: h.TYPE || "",
          task: sd === "human" ? "" : clean(h.TASK || ""),
          body: clean(body.replace(/\n*\[Attached file: [^\n]*\]\s*$/, "")),
          att: attachment(h, clean),
        });
      }
    }
  }
  return out.sort((x, y) => (x.created || x.id).localeCompare(y.created || y.id) || (x.kind === "message" ? -1 : 1));
}
const listening = (a) => bridge.readHeartbeat(bridge.boxDir(a, R)).ok;

// ---------- writing in the bridge: the same message, same ID, in every recipient's inbox ----------
class WebError extends Error { constructor(status, code, vars) { super(code); this.status = status; this.code = code; this.vars = vars; } }
function dropInBridge({ author, text, file }) {
  const to = recipients();
  if (!to.length) throw new WebError(500, "noAgent");
  const from = human();
  if (!bridge.knownSender(from, R)) throw new WebError(422, "sender");
  const now = new Date();
  let id = bridge.genId(now);
  const taken = (x) => to.some((a) => bridge.findMessage(bridge.boxDir(a, R), x));
  for (let i = 0; i < 20 && taken(id); i++) id = bridge.genId(now);
  const firstLine = (text.split("\n").find((l) => l.trim()) || "").trim();
  let task = firstLine || (file ? "Attached file: " + file.name : "Message");
  if (task.length > 100) task = task.slice(0, 97) + "...";
  const body = (text || "(attached file, no text)") +
    (file ? `\n\n[Attached file: ${file.name} (${file.mime.split(";")[0]}, ${Math.max(1, Math.round(file.size / 1024))} KB), in the bridge folder: files/${file.stored}]` : "");
  const extra = { "X-SOURCE": "web", "X-AUTHOR": author };
  if (file) Object.assign(extra, { "X-FILE": file.stored, "X-FILE-NAME": file.name, "X-FILE-TYPE": file.mime.split(";")[0], "X-FILE-SIZE": file.size });
  // Check once for every inbox before writing anything (size, secrets, public details).
  for (const a of to) {
    const header = { ID: id, FROM: from, TO: a, TYPE: "question", TASK: task, "REPLY-TO": "-", CREATED: bridge.isoNow(now), EXPIRES: bridge.isoNow(new Date(now.getTime() + 86400000)), ...extra };
    const c = bridge.checkContent(bridge.buildMessage(header, body), R);
    if (!c.ok) throw c.reason === "size" ? new WebError(413, "bridgeSize") : c.reason === "secret" ? new WebError(422, "secret") : new WebError(422, "public", { d: (/\(([^)]+)\)/.exec(c.message) || [])[1] || "" });
  }
  const written = [];
  for (const a of to) {
    bridge.send({ root: R, to: a, from, type: "question", task, body, id, extra, now: now.toISOString(), queue: true });
    written.push(a);
  }
  return { id, to: written };
}

// ---------- sessions (HMAC-signed cookie; a revoked key ends its sessions) ----------
const b64u = (b) => Buffer.from(b).toString("base64url");
const mac = (p) => crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
function makeSession(k) {
  const p = b64u(JSON.stringify({ sid: crypto.randomBytes(9).toString("hex"), kid: k.id, exp: Math.floor(Date.now() / 1000) + SESSION_S }));
  return p + "." + mac(p);
}
function cookieOf(req) {
  for (const part of String(req.headers.cookie || "").split(";")) { const [n, ...v] = part.trim().split("="); if (n === COOKIE) return v.join("="); }
  return "";
}
function session(req) {
  const [p, m] = cookieOf(req).split(".");
  if (!p || !m) return null;
  const a = Buffer.from(mac(p)), b = Buffer.from(m);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let s; try { s = JSON.parse(Buffer.from(p, "base64url").toString()); } catch (_) { return null; }
  if (!s.exp || s.exp < Date.now() / 1000) return null;
  let k; try { k = ks.active(s.kid); } catch (_) { return null; }
  return k ? { ...s, key: k } : null;
}
const setCookie = (v, age) => `${COOKIE}=${v}; Path=/; HttpOnly;${HTTPS ? " Secure;" : ""} SameSite=Strict; Max-Age=${age}`;

// ---------- limits (in memory: they reset when the service restarts) ----------
const hits = new Map();
function limited(bucket, max, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(bucket) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(bucket, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k); }, 60000).unref();
const ipOf = (req) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "?").slice(0, 64);

// ---------- uploaded files waiting to be sent ----------
const pending = new Map(); // token -> { stored, name, mime, size, sid, t }
setInterval(() => {
  for (const [tok, f] of pending) if (Date.now() - f.t > 3600000) { pending.delete(tok); for (const x of [f.stored, f.stored + ".json"]) { try { fs.unlinkSync(path.join(FILES, x)); } catch (_) {} } }
}, 300000).unref();

// ---------- responses ----------
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// Referrer-Policy must stay same-origin: with no-referrer, Chrome sends "Origin: null" on the login form and the CSRF check fails.
const SEC = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Cache-Control": "no-store",
  "Content-Security-Policy": CSP, "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", Vary: "Accept-Language, Cookie",
  ...(HTTPS ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
};
function send(req, res, code, type, body, extra = {}) {
  res.writeHead(code, { ...SEC, ...(type ? { "Content-Type": type } : {}), ...extra });
  res.end(req.method === "HEAD" ? undefined : body);
}
const json = (req, res, code, obj, extra) => send(req, res, code, "application/json; charset=utf-8", JSON.stringify(obj), extra);
const html = (req, res, code, body, extra) => send(req, res, code, "text/html; charset=utf-8", body, extra);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const langOf = (req) => i18n.pick(process.env.BRIDGE_LANG, req.headers["accept-language"]);
const fail = (req, res, T, status, code, vars, extra) => json(req, res, status, { ok: false, code, error: i18n.fill(T["err." + code] || code, vars) }, extra);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > limit) return reject(new WebError(413, "tooBig"));
    const chunks = []; let n = 0, over = false;
    req.on("data", (c) => { if (over) return; n += c.length; if (n > limit) { over = true; reject(new WebError(413, "tooBig")); req.resume(); return; } chunks.push(c); });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}
// Anti-CSRF: a POST must come from the page itself (Origin = the configured address or the same host).
function originOk(req) {
  const o = req.headers.origin;
  if (!o || o === "null") return false;
  const host = req.headers.host || "";
  return o === ORIGIN || o === "https://" + host || (!HTTPS && o === "http://" + host);
}

// ---------- pages ----------
const ASSET = (n) => fs.readFileSync(path.join(WEB, n), "utf8");
const CSS = ASSET("app.css"), JS = ASSET("app.js"), SETUP_JS = ASSET("setup.js"), MAIN = ASSET("index.html");
const page = (T, title, inner) => `<!doctype html><html lang="${T._lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css"></head><body class="auth"><main class="box">${inner}</main></body></html>`;
function loginPage(T, msg) {
  return page(T, T.loginTitle, `<h1>${esc(process.env.BRIDGE_WEB_TITLE || T.appTitle)}</h1><p class="sub">${esc(T.loginSub)}</p>
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<form method="post" action="/login"><label for="key">${esc(T.keyLabel)}</label>
<input id="key" name="key" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus placeholder="ABCD-...">
<button type="submit">${esc(T.enter)}</button></form><p class="fine">${esc(T.keyFormat)}</p>`);
}
function setupPage(T, token, s, msg) {
  return page(T, T.setupTitle, `<h1>${esc(T.setupH)}</h1>${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<p class="sub">${esc(T.setupSub)}</p>
<form method="post" action="/setup/${esc(token)}">
<label for="prefix">${esc(T.prefixLabel)}</label><input id="prefix" name="prefix" maxlength="4" minlength="4" pattern="[A-Za-z0-9]{4}" required autocapitalize="characters" value="${esc(s.prefix || "")}" ${s.prefix ? "readonly" : ""}>
<label for="label">${esc(T.tagLabel)}</label><input id="label" name="label" maxlength="12" pattern="[A-Za-z0-9]{1,12}" value="${esc(s.label || human().toUpperCase().slice(0, 12))}" ${s.label ? "readonly" : ""}>
<button type="submit">${esc(T.generate)}</button></form>`);
}
const invalidLink = (T) => page(T, T.linkInvalidH, `<h1>${esc(T.linkInvalidH)}</h1><p class="err">${esc(T.linkInvalid)}</p>`);
function keyShownPage(T, k) {
  return page(T, T.newKeyTitle, `<h1>${esc(T.newKeyTitle)}</h1><p class="warn">${esc(T.newKeyWarn)}</p>
<div class="keybox"><code id="newkey">${esc(k.key)}</code><button type="button" id="copy" class="copy" data-copied="${esc(T.copied)}" data-selected="${esc(T.selected)}">${esc(T.copy)}</button></div>
<p class="fine">${esc(i18n.fill(T.tagIs, { label: k.label }))}</p><p><a class="btn" href="/">${esc(T.goPage)}</a></p>
<script src="/setup.js"></script>`);
}
function mainPage(T, S) {
  const vars = { label: S.key.label };
  const pub = Object.fromEntries(Object.entries(T).filter(([k]) => !k.startsWith("err.")));
  return MAIN.replace(/\{\{(@?[\w.]+)\}\}/g, (m, k) => {
    if (k === "@json") return JSON.stringify(pub).replace(/</g, "\\u003c");
    if (k === "title") return esc(process.env.BRIDGE_WEB_TITLE || T.appTitle);
    if (k === "label") return esc(S.key.label);
    return T[k] === undefined ? m : esc(i18n.fill(T[k], vars));
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const u = (req.url || "/").split("?")[0];
  const m = req.method;
  const T = i18n.strings(langOf(req));
  if (m !== "GET" && m !== "HEAD" && m !== "POST") return send(req, res, 405, "text/plain", "method not allowed", { Allow: "GET, HEAD, POST" });

  // public
  if (u === "/health" && m !== "POST") return json(req, res, 200, { ok: true });
  if (u === "/app.css" && m !== "POST") return send(req, res, 200, "text/css; charset=utf-8", CSS, { "Cache-Control": "no-cache" });
  if (u === "/setup.js" && m !== "POST") return send(req, res, 200, "text/javascript; charset=utf-8", SETUP_JS, { "Cache-Control": "no-cache" });
  if (m === "POST" && !originOk(req)) return fail(req, res, T, 403, "origin");

  if (u === "/login") {
    if (m !== "POST") return session(req) ? send(req, res, 303, null, "", { Location: "/" }) : html(req, res, 200, loginPage(T, ""));
    if (limited("login:" + ipOf(req), 5)) return html(req, res, 429, loginPage(T, T.tooMany), { "Retry-After": "60" });
    let key = "";
    try { key = new URLSearchParams((await readBody(req, 2048)).toString("utf8")).get("key") || ""; } catch (_) { return html(req, res, 413, loginPage(T, T.tooBig)); }
    const k = await ks.verify(key);
    if (!k) return html(req, res, 401, loginPage(T, T.keyRefused));
    return send(req, res, 303, null, "", { Location: "/", "Set-Cookie": setCookie(makeSession(k), SESSION_S) });
  }
  if (u === "/logout" && m === "POST") return send(req, res, 303, null, "", { Location: "/login", "Set-Cookie": setCookie("", 0) });

  const sm = /^\/setup\/([A-Za-z0-9]{40})$/.exec(u);
  if (sm) {
    const tok = sm[1];
    if (m !== "POST") {
      if (limited("setupget:" + ipOf(req), 20)) return html(req, res, 429, page(T, T.tooMany, `<p class="err">${esc(T.tooMany)}</p>`));
      const s = ks.findSetup(tok);
      return s ? html(req, res, 200, setupPage(T, tok, s, "")) : html(req, res, 404, invalidLink(T));
    }
    if (limited("login:" + ipOf(req), 5)) return html(req, res, 429, page(T, T.tooMany, `<p class="err">${esc(T.tooMany)}</p>`), { "Retry-After": "60" });
    let f; try { f = new URLSearchParams((await readBody(req, 2048)).toString("utf8")); } catch (_) { return html(req, res, 413, page(T, T.tooBig, `<p class="err">${esc(T.tooBig)}</p>`)); }
    let k;
    try { k = ks.useSetup(tok, { prefix: f.get("prefix"), label: f.get("label") }); } catch (e) {
      const s = ks.findSetup(tok);
      return s ? html(req, res, 400, setupPage(T, tok, s, T["err." + e.code] || e.message)) : html(req, res, 410, invalidLink(T));
    }
    return html(req, res, 200, keyShownPage(T, k), { "Set-Cookie": setCookie(makeSession(k), SESSION_S) });
  }

  // everything else: a session is required
  const S = session(req);
  if (!S) {
    if (m !== "POST" && !u.startsWith("/api/") && !u.startsWith("/f/")) return send(req, res, 302, null, "", { Location: "/login" });
    return fail(req, res, T, 401, "auth");
  }

  if (m !== "POST") {
    if (u === "/" || u === "/index.html") return html(req, res, 200, mainPage(T, S));
    if (u === "/app.js") return send(req, res, 200, "text/javascript; charset=utf-8", JS, { "Cache-Control": "no-cache" });
    if (u === "/api/messages") return json(req, res, 200, collect());
    if (u === "/api/me") return json(req, res, 200, { label: S.key.label, prefix: S.key.prefix, id: S.key.id, lang: T._lang, listening: recipients().filter(listening) });
    if (u === "/api/keys") return json(req, res, 200, ks.list());
    const fm = /^\/f\/([0-9a-f]{24})\.([a-z0-9]{2,5})$/.exec(u);
    if (fm && TYPES[fm[2]]) return serveFile(req, res, T, fm[1] + "." + fm[2], fm[2]);
    return fail(req, res, T, 404, "notFound");
  }

  // signed-in POST
  if (limited("post:" + S.sid, 30)) return fail(req, res, T, 429, "rate", null, { "Retry-After": "60" });
  try {
    if (u === "/api/upload") return await upload(req, res, T, S);
    if (u === "/api/send") return await sendMsg(req, res, T, S);
    if (u === "/api/keys/new") {
      const b = JSON.parse((await readBody(req, 1024)).toString("utf8") || "{}");
      const k = ks.createKey({ prefix: b.prefix, label: b.label, by: "page (" + S.key.label + ")" });
      return json(req, res, 200, { ok: true, id: k.id, prefix: k.prefix, label: k.label, key: k.key });
    }
    if (u === "/api/keys/revoke") {
      const b = JSON.parse((await readBody(req, 1024)).toString("utf8") || "{}");
      const k = ks.revoke(String(b.id || ""));
      return json(req, res, 200, { ok: true, id: k.id, self: k.id === S.key.id });
    }
  } catch (e) {
    if (e instanceof WebError) return fail(req, res, T, e.status, e.code, e.vars);
    if (e instanceof keystore.KeyError) return fail(req, res, T, 400, e.code);
    if (e instanceof SyntaxError) return fail(req, res, T, 400, "json");
    if (e instanceof bridge.BridgeError) return fail(req, res, T, 422, e.code === "sender" ? "sender" : e.code === "secret" ? "secret" : "internal");
    throw e;
  }
  return fail(req, res, T, 404, "notFound");
}

async function upload(req, res, T, S) {
  let name = "";
  try { name = cleanName(decodeURIComponent(String(req.headers["x-file-name"] || ""))); } catch (_) { name = ""; }
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!name || !name.includes(".") || !TYPES[ext]) return fail(req, res, T, 415, "fileType");
  if (redactHit(name)) return fail(req, res, T, 422, "fileName");
  const buf = await readBody(req, MAX_FILE); // 413 above 10 MB
  if (!buf.length) return fail(req, res, T, 400, "fileEmpty");
  if (!sniff(ext, buf)) return fail(req, res, T, 415, "fileMismatch");
  const rnd = crypto.randomBytes(12).toString("hex");
  const stored = rnd + "." + ext;
  fs.writeFileSync(path.join(FILES, stored), buf, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(FILES, stored + ".json"), JSON.stringify({ name, mime: TYPES[ext][0], size: buf.length, by: S.key.label, at: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
  pending.set(rnd, { stored, name, mime: TYPES[ext][0], size: buf.length, sid: S.sid, t: Date.now() });
  return json(req, res, 200, { ok: true, token: rnd, name, size: buf.length });
}
const redactHit = (s) => !!require("../lib/redact").findSecret(s);

async function sendMsg(req, res, T, S) {
  if (!/^application\/json/i.test(req.headers["content-type"] || "")) return fail(req, res, T, 415, "json");
  const b = JSON.parse((await readBody(req, 32768)).toString("utf8") || "{}");
  const text = String(b.text || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (text.length > MAX_TEXT) return fail(req, res, T, 413, "tooLong");
  let file = null;
  if (b.file) {
    const p = pending.get(String(b.file));
    if (!p || p.sid !== S.sid) return fail(req, res, T, 400, "fileUnknown");
    file = p;
  }
  if (!text && !file) return fail(req, res, T, 400, "empty");
  if (redactHit(text)) return fail(req, res, T, 422, "secret");
  const r = dropInBridge({ author: S.key.label, text, file });
  if (file) pending.delete(String(b.file));
  return json(req, res, 200, { ok: true, id: r.id, to: r.to, notListening: r.to.filter((a) => !listening(a)) });
}

function serveFile(req, res, T, name, ext) {
  const p = path.join(FILES, name);
  let st; try { st = fs.statSync(p); } catch (_) { return fail(req, res, T, 404, "notFound"); }
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(p + ".json", "utf8")); } catch (_) { /* no meta */ }
  const [mime, kind] = TYPES[ext];
  const nm = cleanName(meta.name || name) || name;
  const disp = kind === "image" || kind === "audio" ? "inline" : "attachment";
  const hdr = { "Content-Type": mime, "Content-Disposition": `${disp}; filename="${nm.replace(/"/g, "")}"`, "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=86400", "Accept-Ranges": "bytes" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let a = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let z = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (a < 0) a = 0;
    if (a >= st.size || z < a) { res.writeHead(416, { ...SEC, "Content-Range": `bytes */${st.size}` }); return res.end(); }
    z = Math.min(z, st.size - 1);
    res.writeHead(206, { ...SEC, ...hdr, "Content-Range": `bytes ${a}-${z}/${st.size}`, "Content-Length": z - a + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(p, { start: a, end: z }).pipe(res);
  }
  res.writeHead(200, { ...SEC, ...hdr, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(p).pipe(res);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const T = i18n.strings(langOf(req));
    if (!res.headersSent) fail(req, res, T, e.status || 500, e instanceof WebError ? e.code : "internal");
    else res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  let n = 0; try { n = ks.list().filter((k) => !k.revoked).length; } catch (_) { /* unreadable */ }
  console.log(new Date().toISOString(), `bridge-web on http://127.0.0.1:${PORT} for ${BASE} (human: ${human()}, ${n} active key(s)${n ? "" : ": none yet, run bridge-key --setup-link or bridge-key --prefix ABCD"})`);
});
