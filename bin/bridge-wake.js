#!/usr/bin/env node
// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// bridge-wake: wakes an agent that sleeps between turns (GrokBot, any agent with a webhook trigger).
// Runs on the server (pm2 or systemd). The second a message arrives in to-<agent>/ (or a reply addressed to
// <agent> appears in another inbox), it POSTs a small JSON to the agent's webhook URL, with the header read from
// a config file that must be chmod 600. 3 attempts, then it logs and moves on. fs.watch plus a scan every 3 s
// (fs.watch alone misses events on some filesystems). It also keeps the inbox heartbeat fresh, so senders know
// the agent can be reached.
//
// The webhook body never contains the message: only {event, id, agent, at}. The agent then reads the bridge itself.
// The log never contains the URL or the header.
//
// usage: BRIDGE_WAKE_CONFIG=/path/wake.json node bin/bridge-wake.js     (or --config <file>)
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("../lib/bridge");

const argi = process.argv.indexOf("--config");
const CONF = path.resolve(argi > 0 ? process.argv[argi + 1] : process.env.BRIDGE_WAKE_CONFIG || "wake.json");
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadConf() {
  const st = fs.statSync(CONF);
  if (st.mode & 0o077) throw new Error("config file must be readable by its owner only (chmod 600)");
  const c = JSON.parse(fs.readFileSync(CONF, "utf8"));
  if (!c.url || !/^https?:\/\//.test(c.url)) throw new Error('config: "url" missing or not http(s)');
  if (c.header && !/^[A-Za-z0-9-]+\s*:/.test(c.header)) throw new Error('config: "header" must look like "Name: value"');
  return {
    root: c.root || process.env.BRIDGE_ROOT, agent: bridge.checkName(c.agent, "agent"), url: c.url, header: c.header || "",
    events: c.events || ["message", "reply"], scanMs: c.scanMs || 3000, heartbeatMs: c.heartbeatMs || 30000,
    retries: c.retries || 3, retryDelayMs: c.retryDelayMs === undefined ? 2000 : c.retryDelayMs, timeoutMs: c.timeoutMs || 10000,
    ringPendingOnStart: c.ringPendingOnStart !== false,
  };
}

let cfg;
try { cfg = loadConf(); } catch (e) { console.error("bridge-wake: " + e.message); process.exit(2); }
const R = bridge.root(cfg.root);
const DIR = bridge.boxDir(cfg.agent, R);
if (!fs.existsSync(DIR)) { console.error("bridge-wake: no inbox to-" + cfg.agent + " (run bridge-init)"); process.exit(2); }

const rung = new Set();
async function ring(event, id) {
  let c;
  try { c = loadConf(); } catch (e) { log("config error:", e.message); return; } // read again: the key can be rotated without restart
  const headers = { "Content-Type": "application/json" };
  if (c.header) { const i = c.header.indexOf(":"); headers[c.header.slice(0, i).trim()] = c.header.slice(i + 1).trim(); }
  const body = JSON.stringify({ event: "bridge-" + event, id, agent: c.agent, at: bridge.isoNow() });
  for (let t = 1; t <= c.retries; t++) {
    try {
      const r = await fetch(c.url, { method: "POST", headers, body, signal: AbortSignal.timeout(c.timeoutMs) });
      log("wake", event, id, "http", r.status, "attempt", t);
      if (r.ok) { try { bridge.logEvent(DIR, id, "wake", event + " http=" + r.status); } catch (_) {} return true; }
    } catch (e) { log("wake", event, id, "error", e.name === "TimeoutError" ? "timeout" : (e.cause && e.cause.code) || e.message, "attempt", t); }
    if (t < c.retries) await new Promise((res) => setTimeout(res, c.retryDelayMs * t));
  }
  log("wake", event, id, "gave up after", c.retries, "attempts");
  try { bridge.logEvent(DIR, id, "wake-failed", event); } catch (_) {}
  return false;
}

function scan(first) {
  if (cfg.events.includes("message")) {
    let names = [];
    try { names = fs.readdirSync(DIR); } catch (_) { return; }
    for (const n of names) {
      if (!n.endsWith(".msg") || n.startsWith(".")) continue;
      const id = n.slice(0, -4), key = "m" + id;
      if (rung.has(key)) continue;
      rung.add(key);
      const pending = !fs.existsSync(path.join(DIR, id + ".ack"));
      if (!first || (cfg.ringPendingOnStart && pending)) ring("message", id);
    }
  }
  if (cfg.events.includes("reply")) {
    for (const r of bridge.listReplies(R, cfg.agent)) {
      const key = "r" + r.id;
      if (rung.has(key)) continue;
      rung.add(key);
      if (!first) ring("reply", r.id);
    }
  }
}

function beat() { try { bridge.writeHeartbeat(DIR); } catch (e) { log("heartbeat error", e.code || e.message); } }

beat();
scan(true);
const watchers = [];
const later = () => setTimeout(() => scan(false), 200);
try { watchers.push(fs.watch(DIR, later)); } catch (e) { log("fs.watch unavailable, scan only:", e.code || e.message); }
if (cfg.events.includes("reply")) for (const a of bridge.agents(R)) if (a !== cfg.agent) { try { watchers.push(fs.watch(bridge.boxDir(a, R), later)); } catch (_) {} }
const timers = [setInterval(() => scan(false), cfg.scanMs), setInterval(beat, cfg.heartbeatMs)];
log("bridge-wake active for", cfg.agent, "events", cfg.events.join(","));
const stop = () => { watchers.forEach((w) => w.close()); timers.forEach(clearInterval); log("bridge-wake stopped"); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
