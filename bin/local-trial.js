#!/usr/bin/env node
// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// npm run try: the whole bridge on your own computer in about 10 seconds, nothing to configure.
// Two simulated agents, "claude" and "grokbot", in a temporary folder:
//   1. grokbot sleeps between turns: bridge-wake watches its inbox and calls its "webhook" (a local test server here);
//   2. claude listens with its inbox watcher (the script Claude runs with Monitor), if python3 is installed;
//   3. claude sends a question, the webhook fires, grokbot wakes up, reads and answers DONE, claude's watcher sees the reply.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const ROOT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-try-")), "bridge");
const env = { ...process.env, BRIDGE_ROOT: ROOT };
const tool = (name, args) => {
  const r = spawnSync(process.execPath, [path.join(REPO, "bin", name), ...args], { env, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log("\n" + s);
const show = (s) => console.log(s.split("\n").map((l) => "    " + l).join("\n"));
const procs = [];

(async () => {
  step("1. A bridge folder with two inboxes");
  show(tool("bridge-init", ["--agents", "claude,grokbot"]).out.replace(new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<bridge>"));

  step("2. GrokBot sleeps between turns: bridge-wake will call its webhook (here a local test server)");
  const token = crypto.randomBytes(16).toString("hex");
  const calls = [];
  const hook = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const okAuth = req.headers.authorization === "Bearer " + token;
      calls.push({ okAuth, body: b });
      res.writeHead(okAuth ? 200 : 401); res.end();
    });
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const conf = path.join(path.dirname(ROOT), "wake.json");
  fs.writeFileSync(conf, JSON.stringify({ agent: "grokbot", root: ROOT, url: `http://127.0.0.1:${hook.address().port}/webhook`, header: "Authorization: Bearer " + token, scanMs: 500, retryDelayMs: 200 }), { mode: 0o600 });
  const wake = spawn(process.execPath, [path.join(REPO, "bin", "bridge-wake.js"), "--config", conf], { env, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(wake);
  let wakeLog = ""; wake.stdout.on("data", (d) => (wakeLog += d)); wake.stderr.on("data", (d) => (wakeLog += d));
  for (let i = 0; i < 50 && !/active/.test(wakeLog); i++) await sleep(100);
  show(wakeLog.trim().replace(/^\S+ /gm, ""));

  step("3. Claude listens with its inbox watcher (the script Claude runs with Monitor)");
  let watchOut = "", watcher = null;
  if (spawnSync("python3", ["--version"]).status === 0) {
    watcher = spawn("python3", [path.join(REPO, "watchers", "claude", "bridge-watch.py")], { env: { ...env, BRIDGE_AGENT: "claude", BRIDGE_POLL: "0.5" }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(watcher);
    watcher.stdout.on("data", (d) => (watchOut += d));
    for (let i = 0; i < 50 && !/ACTIVE/.test(watchOut); i++) await sleep(100);
    show(watchOut.trim());
  } else {
    show("python3 not found: the watcher is skipped, claude reads its replies with bridge-recv instead");
    tool("bridge-heartbeat", ["--as", "claude"]);
  }

  step("4. Claude sends a question to GrokBot");
  show('$ bridge-send --to grokbot --from claude --type question --task "Is the nightly backup done?"');
  const sent = tool("bridge-send", ["--to", "grokbot", "--from", "claude", "--type", "question", "--task", "Is the nightly backup done?", "--body", "Answer with DONE and a reference, no details."]);
  if (sent.code !== 0) throw new Error("send failed: " + sent.err);
  const id = sent.out;
  show(id);

  step("5. The webhook fires (nobody relayed anything)");
  for (let i = 0; i < 60 && !calls.length; i++) await sleep(100);
  if (!calls.length) throw new Error("the webhook was not called");
  show(`webhook called, Authorization header correct: ${calls[0].okAuth}, body: ${calls[0].body.replace(/"at":"[^"]*"/, '"at":"..."')}`);

  step("6. GrokBot wakes up, reads its inbox and answers");
  show("$ bridge-recv --as grokbot");
  show(tool("bridge-recv", ["--as", "grokbot"]).out);
  show('$ bridge-reply --as grokbot --id ' + id + ' --status DONE --text "Task done, see pattern 12."');
  show(tool("bridge-reply", ["--as", "grokbot", "--id", id, "--status", "DONE", "--text", "Task done, see pattern 12."]).out);

  step("7. Claude is woken by its watcher");
  if (watcher) {
    for (let i = 0; i < 60 && !/REPLY RECEIVED/.test(watchOut); i++) await sleep(100);
    const line = watchOut.split("\n").find((l) => l.startsWith("REPLY RECEIVED"));
    if (!line) throw new Error("the watcher did not see the reply");
    show(line);
  } else {
    show(tool("bridge-recv", ["--as", "claude"]).out);
  }

  step("8. What is left in the folder (the journal never holds the content)");
  show(fs.readFileSync(path.join(ROOT, "to-grokbot", "index.log"), "utf8").trim().replace(/^\S+\t/gm, ""));

  for (const p of procs) p.kill("SIGTERM");
  hook.close();
  console.log(`\nDone. The trial folder is ${path.dirname(ROOT)} (delete it when you want).`);
  console.log("Next: read \"Going live\" in the README to put the bridge on your server.");
})().catch((e) => { for (const p of procs) p.kill("SIGTERM"); console.error("trial failed: " + e.message); process.exit(1); });
