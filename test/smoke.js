// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// Checks the bridge end to end in temporary folders: the tools, the wake watcher, the Claude watcher, the viewer, the trial.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const bridge = require("../lib/bridge");
const { redact, findSecret } = require("../lib/redact");
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) pass++; else { failN++; console.log("FAIL: " + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmps = [];
function mkRoot(agents = ["claude", "grokbot"], hb = true) {
  const R = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-")), "b");
  tmps.push(path.dirname(R));
  bridge.init(agents, { root: R });
  if (hb) for (const a of agents) bridge.writeHeartbeat(bridge.boxDir(a, R));
  return R;
}
function run(R, cmd, args, input) {
  const r = spawnSync(process.execPath, [path.join(REPO, "bin", cmd), ...args], { env: { ...process.env, BRIDGE_ROOT: R }, encoding: "utf8", input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ls = (d) => fs.readdirSync(d).filter((n) => !n.startsWith("."));
const q = (extra = []) => ["--to", "grokbot", "--from", "claude", "--type", "question", "--task", "Test", ...extra];
async function until(fn, ms = 6000) { for (let t = 0; t < ms; t += 50) { if (fn()) return true; await sleep(50); } return false; }
function hookServer(status = () => 200) {
  const calls = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { calls.push({ auth: req.headers.authorization, body: b }); res.writeHead(status(calls.length)); res.end(); }); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/hook` })));
}

(async () => {
  // ---------- init ----------
  const R = mkRoot();
  ok(["done", "expired", "rejected"].every((s) => fs.existsSync(path.join(R, "to-grokbot", s))), "init creates the inbox and its archives");
  ok((fs.statSync(path.join(R, "to-grokbot")).mode & 0o777) === 0o700, "inbox is mode 700");
  ok(run(R, "bridge-init", ["--agents", "Bad Name"]).code === 2, "invalid agent name refused");
  ok(run(R, "bridge-init", ["--agents", "claude"]).code === 0 && ls(path.join(R, "to-claude")).includes("done"), "init can run again");
  ok(spawnSync(process.execPath, [path.join(REPO, "bin", "bridge-send"), ...q()], { env: { ...process.env, BRIDGE_ROOT: "" }, encoding: "utf8" }).status === 2, "no BRIDGE_ROOT refused");

  // ---------- send ----------
  const s1 = run(R, "bridge-send", q(["--body", "Is the backup done?"]));
  const id1 = s1.out.trim();
  ok(s1.code === 0 && bridge.isValidId(id1), "send prints a valid ID");
  const f1 = path.join(R, "to-grokbot", id1 + ".msg");
  ok(fs.existsSync(f1) && (fs.statSync(f1).mode & 0o777) === 0o600, "message written in mode 600");
  const p1 = bridge.parseMessage(fs.readFileSync(f1, "utf8"));
  ok(p1.header.FROM === "claude" && p1.header.TO === "grokbot" && p1.header["REPLY-TO"] === "-" && p1.body === "Is the backup done?\n", "message header and body");
  ok(Date.parse(p1.header.EXPIRES) - Date.parse(p1.header.CREATED) === 24 * 3600 * 1000, "default expiry 24 h");
  ok(!ls(path.join(R, "to-grokbot")).some((n) => n.startsWith(".tmp")) && !fs.readdirSync(path.join(R, "to-grokbot")).some((n) => n.startsWith(".tmp")), "no temporary file left");
  ok(run(R, "bridge-send", q(["--body-file", "-"]), "from stdin").code === 0, "body from stdin");
  ok(run(R, "bridge-send", ["--to", "nobody", "--from", "claude", "--type", "question", "--task", "x"]).code === 2, "unknown recipient refused");
  ok(run(R, "bridge-send", ["--to", "grokbot", "--from", "claude", "--type", "order", "--task", "x"]).code === 2, "unknown type refused");
  ok(run(R, "bridge-send", q(["--ttl", "0"])).code === 2, "bad ttl refused");
  ok(run(R, "bridge-send", q(["--reply-to", "nope"])).code === 2, "bad reply-to refused");
  ok(run(R, "bridge-send", ["--from", "claude"]).code === 2, "missing options refused");
  ok(run(R, "bridge-send", q(["--body", "x".repeat(5000)])).code === 3, "message over 4096 bytes refused");
  const secrets = ["Authorization: Bearer abcdefghijklmnop", "use key sk-abcdefghijklmnopqrstu", "ghp_" + "a".repeat(30), "password = hunter22", "-----BEGIN OPENSSH PRIVATE KEY-----", "AKIA" + "ABCDEFGHIJKLMNOP", "https://user:pw123@example.com/x", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "xx_dev_" + "a1b2c3d4e5f6g7h8"];
  for (const s of secrets) ok(run(R, "bridge-send", q(["--body", s])).code === 3, "secret refused: " + s.slice(0, 12));
  const log1 = fs.readFileSync(path.join(R, "to-grokbot", "index.log"), "utf8");
  ok(!/hunter22|abcdefghijklmnop|BEGIN/.test(log1), "the journal never holds the refused text");
  ok(run(R, "bridge-send", q(["--body", "The task-1 is done, see desk-2 and pattern 12."])).code === 0, "ordinary words are not secrets");

  // heartbeat
  const R2 = mkRoot(["claude", "grokbot"], false);
  ok(run(R2, "bridge-send", q()).code === 4, "no heartbeat: refused with code 4");
  ok(run(R2, "bridge-send", q(["--queue"])).code === 0, "--queue sends anyway");
  fs.writeFileSync(path.join(R2, "to-grokbot", ".heartbeat"), new Date(Date.now() - 600e3).toISOString() + "\n");
  ok(run(R2, "bridge-send", q()).code === 4, "old heartbeat refused");
  fs.writeFileSync(path.join(R2, "to-grokbot", ".heartbeat"), new Date(Date.now() + 3600e3).toISOString() + "\n");
  ok(run(R2, "bridge-send", q()).code === 4, "heartbeat in the future refused");
  ok(run(R2, "bridge-heartbeat", ["--as", "grokbot"]).code === 0 && run(R2, "bridge-heartbeat", ["--check", "grokbot"]).code === 0, "heartbeat write and check");
  ok(run(R2, "bridge-heartbeat", ["--check", "claude"]).code === 4, "heartbeat check fails when absent");

  // ---------- recv ----------
  const RR = mkRoot();
  const a = run(RR, "bridge-send", q(["--body", "first"])).out.trim();
  const act = run(RR, "bridge-send", ["--to", "grokbot", "--from", "claude", "--type", "action", "--task", "Restart the service"]).out.trim();
  const exp = bridge.send({ root: RR, to: "grokbot", from: "claude", type: "question", task: "old", now: Date.now() - 7200e3, ttl: 60, queue: true }).id;
  fs.writeFileSync(path.join(RR, "to-grokbot", "garbage.msg"), "x");
  const bad = bridge.genId();
  fs.writeFileSync(path.join(RR, "to-grokbot", bad + ".msg"), "no header here");
  const sneaky = bridge.genId();
  fs.writeFileSync(path.join(RR, "to-grokbot", sneaky + ".msg"), bridge.buildMessage({ ID: sneaky, FROM: "claude", TO: "grokbot", TYPE: "question", TASK: "x", "REPLY-TO": "-", CREATED: bridge.isoNow(), EXPIRES: bridge.isoNow(new Date(Date.now() + 3600e3)) }, "token=abcdefgh1234"));
  const rv = JSON.parse("[" + run(RR, "bridge-recv", ["--as", "grokbot", "--json"]).out.trim().split("\n").join(",") + "]");
  const ev = (e) => rv.filter((x) => x.event === e);
  ok(ev("message").length === 2 && ev("message").some((m) => m.id === a && m.body === "first\n"), "recv returns the messages");
  ok(ev("message").find((m) => m.id === act).forcedStatus === "NEEDS-INPUT", "an action gets NEEDS-INPUT at once");
  ok(/^STATUS: NEEDS-INPUT/.test(fs.readFileSync(path.join(RR, "to-grokbot", act + ".reply.md"), "utf8")), "NEEDS-INPUT reply written for the action");
  ok(ev("expired").length === 1 && fs.existsSync(path.join(RR, "to-grokbot", "expired", exp + ".msg")), "expired message archived unread");
  ok(ev("rejected").length === 3, "invalid name, invalid header and hidden secret rejected");
  ok(fs.existsSync(path.join(RR, "to-grokbot", "done", a + ".msg")) && fs.existsSync(path.join(RR, "to-grokbot", a + ".ack")), "taken message acked and moved to done/");
  ok(/^ID: .*\nACK-BY: grokbot\nACKED: /.test(fs.readFileSync(path.join(RR, "to-grokbot", a + ".ack"), "utf8")), "ack format");
  fs.copyFileSync(path.join(RR, "to-grokbot", "done", a + ".msg"), path.join(RR, "to-grokbot", a + ".msg"));
  const rv2 = run(RR, "bridge-recv", ["--as", "grokbot", "--json"]).out;
  ok(/"event":"duplicate"/.test(rv2) && !/"event":"message"/.test(rv2), "a message already handled is not given twice");
  ok(fs.existsSync(path.join(RR, "to-grokbot", ".heartbeat")), "recv writes the heartbeat");
  fs.writeFileSync(path.join(RR, "to-grokbot", ".recv.lock"), "1");
  ok(run(RR, "bridge-recv", ["--as", "grokbot"]).code === 5, "a second recv on the same inbox is refused");
  fs.unlinkSync(path.join(RR, "to-grokbot", ".recv.lock"));
  ok(/summary: 0 message/.test(run(RR, "bridge-recv", ["--as", "grokbot"]).out), "text summary");

  // ---------- reply ----------
  const r1 = run(RR, "bridge-reply", ["--as", "grokbot", "--id", a, "--status", "done", "--text", "Task done, see pattern 12."]);
  ok(r1.code === 0 && /DONE -> claude/.test(r1.out), "reply written and addressed to the sender");
  const rtxt = fs.readFileSync(path.join(RR, "to-grokbot", a + ".reply.md"), "utf8");
  ok(/^STATUS: DONE\nID: .*\nFROM: grokbot\nTO: claude\nCREATED: .*\n---\nTask done, see pattern 12.\n$/.test(rtxt), "reply format, STATUS on the first line");
  ok(run(RR, "bridge-reply", ["--as", "grokbot", "--id", act, "--status", "DONE"]).err.includes("forced"), "an action reply is forced to NEEDS-INPUT");
  ok(/^STATUS: NEEDS-INPUT/.test(fs.readFileSync(path.join(RR, "to-grokbot", act + ".reply.md"), "utf8")), "action reply stays NEEDS-INPUT");
  ok(run(RR, "bridge-reply", ["--as", "grokbot", "--id", a, "--status", "MAYBE"]).code === 2, "invalid status refused");
  ok(run(RR, "bridge-reply", ["--as", "grokbot", "--id", bridge.genId(), "--status", "DONE"]).code === 2, "reply to an unknown ID refused");
  ok(run(RR, "bridge-reply", ["--as", "grokbot", "--id", a, "--status", "DONE", "--text", "Bearer abcdefghijklmnopq"]).code === 3, "secret in a reply refused");
  for (const st of ["WIP", "BLOCKED", "NEEDS-INPUT"]) {
    const i = run(RR, "bridge-send", q()).out.trim();
    ok(run(RR, "bridge-reply", ["--as", "grokbot", "--id", i, "--status", st]).code === 0 && fs.existsSync(path.join(RR, "to-grokbot", "done", i + ".msg")), "reply " + st + " and the message goes to done/ without recv");
  }
  const cr = JSON.parse("[" + run(RR, "bridge-recv", ["--as", "claude", "--json"]).out.trim().split("\n").join(",") + "]");
  ok(cr.filter((x) => x.event === "reply").length === 5 && cr.find((x) => x.id === a).status === "DONE", "the sender gets its replies");
  ok(!/"event":"reply"/.test(run(RR, "bridge-recv", ["--as", "claude", "--json"]).out), "a reply is given once");
  const chain = run(RR, "bridge-send", ["--to", "claude", "--from", "grokbot", "--type", "status", "--task", "follow-up", "--reply-to", a]);
  ok(chain.code === 0, "a message can point to an earlier one (REPLY-TO)");

  // ---------- public mode ----------
  const RP = mkRoot();
  ok(run(RP, "bridge-init", ["--agents", "claude", "--public"]).code === 0 && bridge.isPublic(RP), "public mode on");
  fs.writeFileSync(path.join(RP, ".internal-names"), "# names never shown\nproject-x\n");
  for (const s of ["see /etc/someapp/file", "server 192.0.2.12", "listening on port 8080", "call localhost:3000", "write to me@example.org", "the project-x service"]) ok(run(RP, "bridge-send", q(["--body", s])).code === 3, "public bridge refuses: " + s);
  ok(run(RP, "bridge-send", q(["--body", "Task done, see pattern 12. Meeting at 14:30."])).code === 0, "public bridge accepts a reference");

  // ---------- redaction ----------
  const red = redact("key sk-abcdefghijklmnopqrstu path /var/lib/app/x ip 198.51.100.20:8080 port 3000 mail a@b.io token " + "z".repeat(40) + " project-x", ["project-x"]);
  ok(!/abcdefghijklmnop|\/var|198\.51|8080|3000|a@b\.io|zzzz|project-x/.test(red), "redact masks secrets, paths, IPs, ports, e-mails, tokens, internal names");
  ok(redact("Task done at 14:30, see pattern 12.") === "Task done at 14:30, see pattern 12.", "redact keeps ordinary text");
  ok(findSecret("the deploy is done") === null, "no false positive on plain text");

  // ---------- purge ----------
  const old = path.join(RR, "to-grokbot", "done", a + ".msg");
  const t = (Date.now() - 40 * 86400e3) / 1000;
  fs.utimesSync(old, t, t);
  ok(/would delete/.test(run(RR, "bridge-purge", ["--dry-run"]).out) && fs.existsSync(old), "purge dry-run deletes nothing");
  ok(run(RR, "bridge-purge", []).code === 0 && !fs.existsSync(old), "purge deletes archives older than 30 days");
  ok(run(RR, "bridge-purge", ["--days", "0"]).code === 2, "purge refuses --days 0");

  // ---------- bridge-wake ----------
  const RW = mkRoot(["claude", "grokbot"], false);
  const h = await hookServer();
  const conf = path.join(path.dirname(RW), "wake.json");
  const cfg = { agent: "grokbot", root: RW, url: h.url, header: "Authorization: Bearer test-secret-value", scanMs: 300, retryDelayMs: 50, heartbeatMs: 500 };
  fs.writeFileSync(conf, JSON.stringify(cfg), { mode: 0o644 });
  const open = spawnSync(process.execPath, [path.join(REPO, "bin", "bridge-wake.js"), "--config", conf], { encoding: "utf8", timeout: 5000 });
  ok(open.status === 2 && /chmod 600/.test(open.stderr), "wake refuses a config readable by others");
  fs.chmodSync(conf, 0o600);
  const pending = bridge.send({ root: RW, to: "grokbot", from: "claude", type: "question", task: "sent while the watcher was off", queue: true }).id;
  const w = spawn(process.execPath, [path.join(REPO, "bin", "bridge-wake.js"), "--config", conf], { stdio: ["ignore", "pipe", "pipe"] });
  let wlog = ""; w.stdout.on("data", (d) => (wlog += d)); w.stderr.on("data", (d) => (wlog += d));
  ok(await until(() => /active/.test(wlog)), "wake starts");
  ok(await until(() => h.calls.some((c) => c.body.includes(pending))), "wake rings once for a message left unread while it was off");
  ok(bridge.readHeartbeat(bridge.boxDir("grokbot", RW)).ok, "wake keeps the inbox heartbeat fresh");
  const t0 = Date.now();
  const wid = run(RW, "bridge-send", q(["--task", "wake up"])).out.trim();
  ok(await until(() => h.calls.some((c) => c.body.includes(wid))), "wake rings when a message arrives");
  const wcall = h.calls.find((c) => c.body.includes(wid));
  ok(Date.now() - t0 < 3000, "wake rings within seconds");
  ok(wcall.auth === "Bearer test-secret-value", "wake sends the header from the config");
  const wb = JSON.parse(wcall.body);
  ok(wb.event === "bridge-message" && wb.id === wid && wb.agent === "grokbot" && !("body" in wb) && !wcall.body.includes("wake up"), "webhook body has the ID, never the content");
  await sleep(800);
  ok(h.calls.filter((c) => c.body.includes(wid)).length === 1, "one ring per message");
  bridge.writeHeartbeat(bridge.boxDir("claude", RW));
  const back = run(RW, "bridge-send", ["--to", "claude", "--from", "grokbot", "--type", "question", "--task", "q"]).out.trim();
  run(RW, "bridge-reply", ["--as", "claude", "--id", back, "--status", "DONE", "--text", "ok"]);
  ok(await until(() => h.calls.some((c) => c.body.includes(back) && c.body.includes("bridge-reply"))), "wake rings when a reply addressed to the agent arrives");
  ok(!/test-secret-value|\/hook/.test(wlog), "the wake log never holds the header or the URL");
  ok(/\twake\tmessage http=200/.test(fs.readFileSync(path.join(RW, "to-grokbot", "index.log"), "utf8")), "the ring is in the journal");
  w.kill("SIGTERM");
  h.srv.close();

  // retries
  const RW2 = mkRoot(["claude", "grokbot"], false);
  const h2 = await hookServer((n) => (n < 3 ? 500 : 200));
  const conf2 = path.join(path.dirname(RW2), "wake.json");
  fs.writeFileSync(conf2, JSON.stringify({ ...cfg, root: RW2, url: h2.url }), { mode: 0o600 });
  const w2 = spawn(process.execPath, [path.join(REPO, "bin", "bridge-wake.js"), "--config", conf2], { stdio: ["ignore", "pipe", "pipe"] });
  let w2log = ""; w2.stdout.on("data", (d) => (w2log += d));
  await until(() => /active/.test(w2log));
  bridge.send({ root: RW2, to: "grokbot", from: "claude", type: "question", task: "retry" });
  ok(await until(() => h2.calls.length === 3), "wake retries after an error, 3 attempts");
  ok(/http 500 attempt 1/.test(w2log) && /http 200 attempt 3/.test(w2log), "attempts are logged");
  const h3 = await hookServer(() => 503);
  fs.writeFileSync(conf2, JSON.stringify({ ...cfg, root: RW2, url: h3.url }), { mode: 0o600 });
  bridge.send({ root: RW2, to: "grokbot", from: "claude", type: "question", task: "fail" });
  ok(await until(() => /gave up after 3 attempts/.test(w2log)), "wake gives up after 3 attempts and says so (config re-read, no restart)");
  ok(h3.calls.length === 3, "exactly 3 attempts");
  w2.kill("SIGTERM"); h2.srv.close(); h3.srv.close();

  // ---------- Claude watcher (local mode) ----------
  if (spawnSync("python3", ["--version"]).status === 0) {
    const RC = mkRoot();
    const W = path.join(REPO, "watchers", "claude", "bridge-watch.py");
    const watch = (extra = {}) => spawnSync("python3", [W], { env: { ...process.env, BRIDGE_ROOT: RC, BRIDGE_AGENT: "claude", BRIDGE_POLL: "0.2", BRIDGE_MAX_POLLS: "2", ...extra }, encoding: "utf8", timeout: 15000 });
    const m1 = bridge.send({ root: RC, to: "claude", from: "grokbot", type: "question", task: "hi" }).id;
    const o1 = watch().stdout;
    ok(/^BRIDGE WATCHER ACTIVE for claude/.test(o1) && o1.includes("NEW MESSAGE " + m1), "Claude watcher announces a new message");
    ok(fs.existsSync(path.join(RC, "to-claude", m1 + ".ack")), "Claude watcher acks it");
    ok((o1.match(/NEW MESSAGE/g) || []).length === 1, "announced once");
    ok(watch().stdout.includes("NEW MESSAGE " + m1), "an unanswered message is announced again after a restart");
    run(RC, "bridge-reply", ["--as", "claude", "--id", m1, "--status", "DONE", "--text", "done"]);
    ok(!watch().stdout.includes("NEW MESSAGE"), "an answered message is not announced again");
    const m2 = run(RC, "bridge-send", q(["--task", "to grok"])).out.trim();
    run(RC, "bridge-reply", ["--as", "grokbot", "--id", m2, "--status", "WIP", "--text", "on it"]);
    const o3 = watch().stdout;
    ok(o3.includes("REPLY RECEIVED " + m2 + ": on it") && o3.includes("[STATUS: WIP]"), "Claude watcher announces a reply with its status");
    ok(!watch().stdout.includes("REPLY RECEIVED"), "a reply is announced once");
    ok(bridge.readHeartbeat(bridge.boxDir("claude", RC)).ok, "Claude watcher writes the heartbeat");
    const long = spawn("python3", [W], { env: { ...process.env, BRIDGE_ROOT: RC, BRIDGE_AGENT: "claude", BRIDGE_POLL: "0.2" }, stdio: ["ignore", "pipe", "pipe"] });
    let lo = ""; long.stdout.on("data", (d) => (lo += d));
    await until(() => /ACTIVE/.test(lo));
    await sleep(400);
    watch({ BRIDGE_MAX_POLLS: "1" });
    ok(await until(() => /TAKEN OVER/.test(lo)), "the previous watcher stops when another one takes the inbox");
    ok(await until(() => long.exitCode !== null), "and it exits by itself");
    const noDoorKey = watch({ BRIDGE_DOOR_URL: "https://door.example.com" });
    ok(noDoorKey.status !== 0 && /BRIDGE_DOOR_KEY/.test(noDoorKey.stderr), "door mode needs a key");
    // door mode against a fake door that runs the command locally
    const door = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      if (req.headers.authorization !== "Bearer door-test-key") { res.writeHead(401); return res.end(); }
      const r = spawnSync("bash", ["-c", JSON.parse(b).command], { encoding: "utf8" });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ exit_code: r.status, stdout: r.stdout }));
    }); });
    await new Promise((r) => door.listen(0, "127.0.0.1", r));
    const m3 = bridge.send({ root: RC, to: "claude", from: "grokbot", type: "question", task: "through the door" }).id;
    const od = await new Promise((resolve) => { const p = spawn("python3", [W], { env: { ...process.env, BRIDGE_ROOT: RC, BRIDGE_AGENT: "claude", BRIDGE_POLL: "0.2", BRIDGE_MAX_POLLS: "1", BRIDGE_DOOR_URL: `http://127.0.0.1:${door.address().port}`, BRIDGE_DOOR_KEY: "door-test-key" } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => resolve(o)); });
    ok(od.includes("NEW MESSAGE " + m3), "Claude watcher works through the Door (part 1)");
    door.close();
    const reset = spawnSync("bash", [path.join(REPO, "watchers", "claude", "reset-watch.sh")], { env: { ...process.env, BRIDGE_RESET_AFTER: "0" }, encoding: "utf8" });
    ok(/^RESTART/.test(reset.stdout), "reset watcher prints RESTART");
  } else {
    console.log("python3 not found: Claude watcher tests skipped");
  }

  // ---------- viewer ----------
  const RV = mkRoot();
  fs.writeFileSync(path.join(RV, ".internal-names"), "project-x\n");
  const v1 = bridge.send({ root: RV, to: "grokbot", from: "claude", type: "question", task: "check project-x", body: "see /srv/app and 192.0.2.3" }).id;
  bridge.writeReply({ root: RV, as: "grokbot", id: v1, status: "DONE", text: "Task done, see pattern 12." });
  const vport = 3900 + Math.floor(Math.random() * 90);
  const v = spawn(process.execPath, [path.join(REPO, "bin", "bridge-viewer.js")], { env: { ...process.env, BRIDGE_ROOT: RV, VIEWER_PORT: String(vport) }, stdio: ["ignore", "pipe", "pipe"] });
  let vlog = ""; v.stdout.on("data", (d) => (vlog += d)); v.stderr.on("data", (d) => (vlog += d));
  await until(() => /viewer on/.test(vlog));
  const V = `http://127.0.0.1:${vport}`;
  ok((await (await fetch(V + "/health")).json()).ok === true, "viewer health");
  const vm = (await (await fetch(V + "/api/messages")).json()).messages;
  ok(vm.length === 2 && vm[0].kind === "message" && vm[1].kind === "reply" && vm[1].status === "DONE", "viewer lists the message and its reply");
  const vj = JSON.stringify(vm);
  ok(!/\/srv|192\.0\.2\.3|project-x/.test(vj) && /\[path\]/.test(vj) && /\[internal\]/.test(vj), "viewer masks paths, IPs and internal names");
  ok((await fetch(V + "/api/messages", { method: "POST" })).status === 405, "viewer is read-only");
  ok((await fetch(V + "/")).headers.get("content-type").startsWith("text/html"), "viewer page");
  ok((await fetch(V + "/../../etc/passwd")).status === 404, "viewer serves nothing else");
  v.kill("SIGTERM");

  // ---------- the local trial ----------
  const tr = spawnSync(process.execPath, [path.join(REPO, "bin", "local-trial.js")], { encoding: "utf8", timeout: 30000 });
  ok(tr.status === 0 && /webhook called, Authorization header correct: true/.test(tr.stdout), "npm run try: the webhook fires");
  const trDir = (/trial folder is (\S+)/.exec(tr.stdout) || [])[1];
  if (trDir) tmps.push(trDir);

  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  console.log(`${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
