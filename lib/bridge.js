// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// The Bridge: a folder where agents talk. Shared library, Node built-in modules only.
//
// Layout of a bridge root:
//   <root>/to-<agent>/            the inbox of <agent> (mode 700)
//     <id>.msg                    a message waiting (header, ---, body)
//     <id>.ack                    the recipient has taken it
//     <id>.reply.md               the answer (first line STATUS: DONE|WIP|BLOCKED|NEEDS-INPUT)
//     done/ expired/ rejected/    archives
//     .heartbeat                  "someone is listening to this inbox" (ISO date, refreshed every 30 s)
//     .owner                      the watcher that holds the inbox (the last one started takes over)
//     .seen-replies               replies already announced by the watcher
//     index.log                   append-only journal: date, id, event. Never the content.
//   <root>/.public                optional: the bridge is shown on a public page (stricter sending rules)
//   <root>/.internal-names        optional: names that must never appear publicly (one per line)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { findSecret, findPublicDetail } = require("./redact");

const MAX_BYTES = 4096;
const HEARTBEAT_MAX_AGE_S = 180;
const HEARTBEAT_FUTURE_SKEW_S = 120;
const PURGE_DAYS = 30;
const DEFAULT_TTL_S = 24 * 3600;
const MAX_TTL_S = 30 * 24 * 3600;
const TYPES = ["question", "review", "status", "action"];
const STATUSES = ["DONE", "WIP", "BLOCKED", "NEEDS-INPUT"];
const HEADER_FIELDS = ["ID", "FROM", "TO", "TYPE", "TASK", "REPLY-TO", "CREATED", "EXPIRES"];
const ID_RE = /^\d{8}T\d{6}-[0-9a-f]{4}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

class BridgeError extends Error {
  constructor(code, message, exitCode) { super(message); this.code = code; this.exitCode = exitCode || 2; }
}

function root(r) {
  const v = r || process.env.BRIDGE_ROOT;
  if (!v) throw new BridgeError("root", "no bridge folder: set BRIDGE_ROOT or pass --root", 2);
  return path.resolve(v);
}
function checkName(n, what = "agent name") {
  const s = String(n || "").toLowerCase();
  if (!NAME_RE.test(s)) throw new BridgeError("name", `${what} invalid (a-z, 0-9, -, 32 max)`, 2);
  return s;
}
function boxDir(agent, r) { return path.join(root(r), "to-" + checkName(agent)); }
function agents(r) {
  const R = root(r);
  if (!fs.existsSync(R)) return [];
  return fs.readdirSync(R).filter((n) => n.startsWith("to-") && fs.statSync(path.join(R, n)).isDirectory()).map((n) => n.slice(3)).sort();
}
function isPublic(r) { return fs.existsSync(path.join(root(r), ".public")); }
function internalNames(r) {
  const p = path.join(root(r), ".internal-names");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

const pad = (n) => String(n).padStart(2, "0");
function isoNow(d = new Date()) { return d.toISOString().replace(/\.\d{3}Z$/, "Z"); }
function genId(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${crypto.randomBytes(2).toString("hex")}`;
}
function isValidId(id) { return ID_RE.test(String(id)); }

function writeAtomic(p, content) {
  const tmp = path.join(path.dirname(p), `.tmp-${path.basename(p)}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  return p;
}
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 }); fs.chmodSync(p, 0o700); }

// ---------- journal ----------
function logEvent(dir, id, event, detail) {
  const line = `${new Date().toISOString()}\t${id || "-"}\t${event}\t${String(detail || "").replace(/[\r\n\t]/g, " ")}\n`;
  fs.appendFileSync(path.join(dir, "index.log"), line, { mode: 0o600 });
}
function readIndex(dir) {
  const p = path.join(dir, "index.log");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { const [ts, id, event, detail] = l.split("\t"); return { ts, id, event, detail }; });
}

// ---------- init ----------
function init(names, opts = {}) {
  const R = root(opts.root);
  if (!fs.existsSync(R)) fs.mkdirSync(R, { recursive: true, mode: 0o700 });
  fs.chmodSync(R, 0o700);
  const made = [];
  for (const n of names) {
    const d = boxDir(n, R);
    for (const sub of ["", "done", "expired", "rejected"]) ensureDir(path.join(d, sub));
    const log = path.join(d, "index.log");
    if (!fs.existsSync(log)) fs.writeFileSync(log, "", { mode: 0o600 });
    made.push(d);
  }
  if (opts.public) fs.writeFileSync(path.join(R, ".public"), "This bridge is shown on a public page.\n", { mode: 0o600 });
  return made;
}

// ---------- heartbeat ----------
function readHeartbeat(dir, now = Date.now()) {
  const p = path.join(dir, ".heartbeat");
  let st;
  try { st = fs.statSync(p); } catch (_) { return { ok: false, reason: "absent", message: "no heartbeat: nobody listens to this inbox (no watcher running)" }; }
  let t = st.mtimeMs, source = "mtime";
  const first = fs.readFileSync(p, "utf8").split("\n")[0].trim();
  if (first && /^\d{4}-\d{2}-\d{2}T/.test(first) && !Number.isNaN(Date.parse(first))) { t = Date.parse(first); source = "content"; }
  const age = Math.round((now - t) / 1000);
  if (age < -HEARTBEAT_FUTURE_SKEW_S) return { ok: false, reason: "future", age, source, message: "heartbeat in the future: check the clocks" };
  if (age > HEARTBEAT_MAX_AGE_S) return { ok: false, reason: "old", age, source, message: `heartbeat too old (${age} s, max ${HEARTBEAT_MAX_AGE_S} s): the recipient's watcher has stopped` };
  return { ok: true, age, source };
}
function writeHeartbeat(dir) { return writeAtomic(path.join(dir, ".heartbeat"), isoNow() + "\n"); }

// ---------- format ----------
function buildMessage(h, body) {
  const lines = HEADER_FIELDS.map((k) => `${k}: ${h[k]}`);
  if (h.TYPE === "action") lines.push("REPLY-STATUS: NEEDS-INPUT");
  return lines.join("\n") + "\n---\n" + (body || "") + (body && !body.endsWith("\n") ? "\n" : "");
}
function parseMessage(text) {
  const sep = text.indexOf("\n---\n");
  if (sep < 0) throw new BridgeError("format", "separator --- missing");
  const h = {};
  for (const l of text.slice(0, sep).split("\n")) {
    const m = /^([A-Z-]+): (.*)$/.exec(l);
    if (!m) throw new BridgeError("format", "invalid header line");
    h[m[1]] = m[2];
  }
  return { header: h, body: text.slice(sep + 5) };
}
function validateHeader(h) {
  for (const k of HEADER_FIELDS) {
    if (h[k] === undefined || h[k] === null || String(h[k]).trim() === "") throw new BridgeError("header", `field ${k} missing`);
    if (/[\r\n]/.test(String(h[k]))) throw new BridgeError("header", `field ${k} on several lines`);
  }
  if (!isValidId(h.ID)) throw new BridgeError("header", "invalid ID (YYYYMMDDTHHMMSS-xxxx)");
  checkName(h.FROM, "FROM"); checkName(h.TO, "TO");
  if (!TYPES.includes(h.TYPE)) throw new BridgeError("header", `invalid TYPE (${TYPES.join("|")})`);
  if (h["REPLY-TO"] !== "-" && !isValidId(h["REPLY-TO"])) throw new BridgeError("header", "invalid REPLY-TO (- or an ID)");
  if (!ISO_RE.test(h.CREATED) || !ISO_RE.test(h.EXPIRES)) throw new BridgeError("header", "CREATED and EXPIRES must be ISO 8601 UTC");
  if (Date.parse(h.EXPIRES) <= Date.parse(h.CREATED)) throw new BridgeError("header", "EXPIRES must be after CREATED");
  if (h.TYPE === "action" && h["REPLY-STATUS"] !== undefined && h["REPLY-STATUS"] !== "NEEDS-INPUT") throw new BridgeError("header", "an action requires REPLY-STATUS: NEEDS-INPUT");
  return true;
}
// An action ALWAYS gets NEEDS-INPUT: a human approves it in their own conversation.
function effectiveStatus(type, requested) {
  if (type === "action") return "NEEDS-INPUT";
  if (!STATUSES.includes(requested)) throw new BridgeError("status", `invalid STATUS (${STATUSES.join("|")})`);
  return requested;
}
// Content check shared by send, recv and reply. Never returns the matched text.
function checkContent(text, r) {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { ok: false, reason: "size", message: `refused: larger than ${MAX_BYTES} bytes (header included)` };
  if (findSecret(text)) return { ok: false, reason: "secret", message: "refused: looks like a secret (never put a key or a password in a message)" };
  if (r && isPublic(r)) {
    const d = findPublicDetail(text, internalNames(r));
    if (d) return { ok: false, reason: "public", message: `refused: this bridge is public and the text contains a detail (${d}). Write "task done, see <reference>" and put the details elsewhere.` };
  }
  return { ok: true };
}

// ---------- send ----------
// opts: { root, to, from, type, task, replyTo, ttl, expires, body, now, queue }
function send(opts) {
  const R = root(opts.root);
  const to = checkName(opts.to, "--to");
  const dir = boxDir(to, R);
  if (!fs.existsSync(dir)) throw new BridgeError("dest", `no inbox for "${to}" (run bridge-init)`, 2);
  const now = opts.now ? new Date(opts.now) : new Date();
  let id = genId(now);
  for (let i = 0; i < 20 && (fs.existsSync(path.join(dir, `${id}.msg`)) || fs.existsSync(path.join(dir, "done", `${id}.msg`))); i++) id = genId(now);
  const refuse = (reason, message, exitCode) => { logEvent(dir, id, "refused", reason); throw new BridgeError(reason, message, exitCode); };
  let expires = opts.expires;
  if (!expires) {
    const ttl = opts.ttl === undefined ? DEFAULT_TTL_S : Number(opts.ttl);
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_S) refuse("header", `invalid TTL (1 to ${MAX_TTL_S} s)`, 2);
    expires = isoNow(new Date(now.getTime() + ttl * 1000));
  }
  const header = { ID: id, FROM: String(opts.from || "").toLowerCase(), TO: to, TYPE: opts.type, TASK: opts.task, "REPLY-TO": opts.replyTo || "-", CREATED: isoNow(now), EXPIRES: expires };
  const text = buildMessage(header, opts.body || "");
  const c = checkContent(text, R);
  if (!c.ok) refuse(c.reason, c.message, 3);
  try { validateHeader(header); } catch (e) { refuse("header", `refused: ${e.message}`, 2); }
  if (!opts.queue) {
    const hb = readHeartbeat(dir, now.getTime());
    if (!hb.ok) refuse("heartbeat", `refused: ${hb.message}. Use --queue to leave it anyway.`, 4);
  }
  const final = path.join(dir, `${id}.msg`);
  writeAtomic(final, text);
  logEvent(dir, id, "sent", `type=${header.TYPE} from=${header.FROM}`);
  return { id, path: final, header };
}

// ---------- receive ----------
function findMessage(dir, id) {
  for (const p of [path.join(dir, `${id}.msg`), path.join(dir, "done", `${id}.msg`)]) if (fs.existsSync(p)) return p;
  return null;
}
function alreadyHandled(dir, id) {
  if (fs.existsSync(path.join(dir, "done", `${id}.msg`)) || fs.existsSync(path.join(dir, "expired", `${id}.msg`))) return true;
  return readIndex(dir).some((e) => e.id === id && (e.event === "done" || e.event === "expired"));
}
function moveTo(dir, sub, name, destName) {
  ensureDir(path.join(dir, sub));
  const dest = path.join(dir, sub, destName || name);
  fs.renameSync(path.join(dir, name), dest);
  return dest;
}
function ack(dir, id, by) {
  const p = path.join(dir, `${id}.ack`);
  if (fs.existsSync(p)) return false;
  writeAtomic(p, `ID: ${id}\nACK-BY: ${by}\nACKED: ${isoNow()}\n`);
  logEvent(dir, id, "ack", `by=${by}`);
  return true;
}
function acquireLock(dir) {
  const p = path.join(dir, ".recv.lock");
  try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(p); } catch (_) {}
  const fd = fs.openSync(p, "wx", 0o600); fs.writeSync(fd, `${process.pid}\n`); fs.closeSync(fd);
  return () => { try { fs.unlinkSync(p); } catch (_) {} };
}
// Takes every message of the agent's inbox: ack, expiry, duplicates, rejects, archive in done/.
// opts: { root, as, now, heartbeat }
function recv(opts) {
  const R = root(opts.root);
  const me = checkName(opts.as, "--as");
  const dir = boxDir(me, R);
  if (!fs.existsSync(dir)) throw new BridgeError("dest", `no inbox for "${me}" (run bridge-init)`, 2);
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  if (opts.heartbeat !== false) writeHeartbeat(dir);
  const release = acquireLock(dir);
  const res = { processed: [], expired: [], duplicates: [], rejected: [], replies: [] };
  try {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".msg") && !n.startsWith(".")).sort()) {
      const id = name.slice(0, -4);
      if (!isValidId(id)) { res.rejected.push({ id: null, path: moveTo(dir, "rejected", name, `${name}.${Date.now()}`), reason: "name" }); logEvent(dir, "-", "rejected", "invalid name"); continue; }
      if (alreadyHandled(dir, id)) { res.duplicates.push({ id, path: moveTo(dir, "done", name, `${id}.msg.duplicate-${Date.now()}`) }); logEvent(dir, id, "duplicate", "already handled"); continue; }
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      const c = checkContent(text, R);
      let parsed, reason = c.ok ? null : c.reason;
      if (!reason) {
        try { parsed = parseMessage(text); validateHeader(parsed.header); if (parsed.header.ID !== id || parsed.header.TO !== me) throw new Error("mismatch"); } catch (_) { reason = "header"; }
      }
      if (reason) { res.rejected.push({ id, path: moveTo(dir, "rejected", name), reason }); logEvent(dir, id, "rejected", reason); continue; }
      const h = parsed.header;
      if (Date.parse(h.EXPIRES) < now) { res.expired.push({ id, path: moveTo(dir, "expired", name) }); logEvent(dir, id, "expired", "archived unread"); continue; }
      ack(dir, id, me);
      let forced = null;
      if (h.TYPE === "action") { writeReply({ root: R, as: me, id, status: "NEEDS-INPUT", text: "Action requested: nothing is done without the explicit approval of the human, in their own conversation." }, h); forced = "NEEDS-INPUT"; }
      const dest = moveTo(dir, "done", name);
      logEvent(dir, id, "done", `type=${h.TYPE}`);
      res.processed.push({ id, header: h, body: parsed.body, path: dest, forcedStatus: forced });
    }
    if (opts.replies !== false) res.replies = takeReplies(R, me, ".read-replies");
  } finally { release(); }
  return res;
}

// Replies addressed to <me> (they sit next to the original message, in the recipient's inbox), not yet seen.
function listReplies(R, me) {
  const out = [];
  for (const a of agents(R)) {
    const d = boxDir(a, R);
    for (const n of fs.readdirSync(d)) {
      if (!n.endsWith(".reply.md") || n.startsWith(".")) continue;
      const p = path.join(d, n);
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch (_) { continue; }
      const to = /^TO: (.*)$/m.exec(txt.split("\n---\n")[0] || "");
      if (to && to[1].trim() === me) out.push({ id: n.slice(0, -9), path: p, text: txt, status: (/^STATUS: (\S+)/.exec(txt) || [])[1] || "?" });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
function takeReplies(R, me, seenFile) {
  const p = path.join(boxDir(me, R), seenFile);
  const seen = new Set(fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
  const fresh = listReplies(R, me).filter((r) => !seen.has(r.id));
  if (fresh.length) fs.appendFileSync(p, fresh.map((r) => r.id).join("\n") + "\n", { mode: 0o600 });
  return fresh;
}

// ---------- reply ----------
// opts: { root, as (the agent who answers), id, status, text }
function writeReply(opts, knownHeader) {
  const R = root(opts.root);
  const me = checkName(opts.as, "--as");
  const dir = boxDir(me, R);
  if (!isValidId(opts.id)) throw new BridgeError("id", "invalid ID");
  let h = knownHeader;
  if (!h) {
    const p = findMessage(dir, opts.id);
    if (!p) throw new BridgeError("id", `no message ${opts.id} in the inbox of ${me}`);
    h = parseMessage(fs.readFileSync(p, "utf8")).header;
  }
  const eff = effectiveStatus(h.TYPE, opts.status);
  const content = `STATUS: ${eff}\nID: ${opts.id}\nFROM: ${me}\nTO: ${h.FROM}\nCREATED: ${isoNow()}\n---\n${opts.text || ""}\n`;
  const c = checkContent(content, R);
  if (!c.ok) { logEvent(dir, opts.id, "refused", `reply ${c.reason}`); throw new BridgeError(c.reason, c.message, 3); }
  const final = path.join(dir, `${opts.id}.reply.md`);
  writeAtomic(final, content);
  logEvent(dir, opts.id, "reply", `status=${eff}`);
  if (!knownHeader) {
    ack(dir, opts.id, me);
    if (fs.existsSync(path.join(dir, `${opts.id}.msg`))) { moveTo(dir, "done", `${opts.id}.msg`); logEvent(dir, opts.id, "done", `type=${h.TYPE}`); }
  }
  return { path: final, status: eff, forced: eff !== opts.status, to: h.FROM };
}

// ---------- purge ----------
function purge(opts = {}) {
  const R = root(opts.root);
  const days = opts.days === undefined ? PURGE_DAYS : Number(opts.days);
  const limit = (opts.now || Date.now()) - days * 86400 * 1000;
  const removed = [];
  for (const a of agents(R)) {
    const dir = boxDir(a, R);
    for (const sub of ["done", "expired", "rejected"]) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n), st = fs.statSync(p);
        if (!st.isFile() || st.mtimeMs >= limit) continue;
        if (!opts.dryRun) { fs.unlinkSync(p); logEvent(dir, isValidId(n.slice(0, 20)) ? n.slice(0, 20) : "-", "purged", `${sub}/ > ${days} d`); }
        removed.push(p);
      }
    }
  }
  return removed;
}

module.exports = {
  MAX_BYTES, HEARTBEAT_MAX_AGE_S, PURGE_DAYS, TYPES, STATUSES, HEADER_FIELDS, NAME_RE,
  BridgeError, root, checkName, boxDir, agents, isPublic, internalNames, genId, isValidId, isoNow, writeAtomic,
  logEvent, readIndex, init, readHeartbeat, writeHeartbeat, buildMessage, parseMessage, validateHeader,
  effectiveStatus, checkContent, send, recv, ack, findMessage, listReplies, takeReplies, writeReply, purge,
};
