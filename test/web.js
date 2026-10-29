// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// Checks the web page (bin/bridge-web.js) and its keys (bin/bridge-key.js) in temporary folders:
// keys and hashes, setup link used once, sign-in, 401 without a key, CSRF, the human sender, secrets refused,
// files, language selection. Run it alone: node test/web.js (npm test runs every test file one by one).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const bridge = require("../lib/bridge");
const i18n = require("../lib/web-i18n");
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) pass++; else { failN++; console.log("FAIL: " + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-web-test-"));
const R = path.join(TMP, "b"), WD = path.join(TMP, "web");
const env = { ...process.env, BRIDGE_ROOT: R, BRIDGE_WEB_DIR: WD, BRIDGE_LANG: "", BRIDGE_WEB_URL: "" };
const key = (args, e = {}) => spawnSync(process.execPath, [path.join(REPO, "bin", "bridge-key.js"), ...args], { env: { ...env, ...e }, encoding: "utf8" });
const tool = (cmd, args) => spawnSync(process.execPath, [path.join(REPO, "bin", cmd), ...args], { env, encoding: "utf8" });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let PORT, ORIGIN, ipN = 0;
function req(method, url, { headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = { "X-Real-IP": "10.0.0." + (++ipN % 250), ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined && h["Content-Length"] === undefined) h["Content-Length"] = Buffer.byteLength(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString("utf8") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const form = (o) => new URLSearchParams(o).toString();
const post = (url, body, extra = {}) => req("POST", url, { body, headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", ...extra.headers }, cookie: extra.cookie });
const postJson = (url, obj, cookie, headers = {}) => req("POST", url, { body: JSON.stringify(obj), headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, cookie });
const cookieFrom = (r) => String((r.headers["set-cookie"] || [""])[0]).split(";")[0];
function start(e = {}) {
  const p = spawn(process.execPath, [path.join(REPO, "bin", "bridge-web.js")], { env: { ...env, BRIDGE_WEB_PORT: String(PORT), ...e }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.output = () => out;
  return p;
}
async function up() { for (let i = 0; i < 100; i++) { try { if ((await req("GET", "/health")).status === 200) return true; } catch (_) {} await sleep(50); } return false; }

(async () => {
  // ---------- language selection (unit) ----------
  ok(i18n.pick("", "fr-CA,fr;q=0.9,en;q=0.8") === "fr", "language: browser fr-CA gives fr");
  ok(i18n.pick("", "de-DE,de;q=0.9,fr;q=0.5") === "fr", "language: first supported language of the browser");
  ok(i18n.pick("", "de-DE") === "en" && i18n.pick("", "") === "en", "language: English when nothing matches");
  ok(i18n.pick("en", "fr-CA,fr") === "en" && i18n.pick("FR", "en-US") === "fr", "language: BRIDGE_LANG wins over the browser");
  ok(i18n.pick("xx", "fr") === "fr", "language: an unknown BRIDGE_LANG falls back to the browser");
  ok(i18n.strings("fr")._speech === "fr-CA" && i18n.strings("en")._speech === "en-US", "language: dictation and read-aloud follow the page language");
  ok(i18n.strings("fr", { BRIDGE_SPEECH_LANG: "fr-FR" })._speech === "fr-FR", "language: BRIDGE_SPEECH_LANG forces the speech language");
  const en = Object.keys(i18n.STRINGS.en), fr = Object.keys(i18n.STRINGS.fr);
  ok(en.length > 50 && en.every((k) => fr.includes(k)) && fr.every((k) => en.includes(k)), "language: en and fr have the same texts");

  // ---------- the human sender must be declared ----------
  bridge.init(["claude", "grokbot"], { root: R });
  for (const a of ["claude", "grokbot"]) bridge.writeHeartbeat(bridge.boxDir(a, R));
  const qdj = ["--to", "grokbot", "--from", "dj", "--type", "question", "--task", "Hi", "--body", "hello"];
  ok(tool("bridge-send", qdj).status === 2, "an undeclared human sender is refused by bridge-send");
  const fake = bridge.genId();
  fs.writeFileSync(path.join(R, "to-grokbot", fake + ".msg"), bridge.buildMessage({ ID: fake, FROM: "dj", TO: "grokbot", TYPE: "question", TASK: "x", "REPLY-TO": "-", CREATED: bridge.isoNow(), EXPIRES: bridge.isoNow(new Date(Date.now() + 3600e3)) }, "x"), { mode: 0o600 });
  const rj = bridge.recv({ root: R, as: "grokbot" });
  ok(rj.rejected.length === 1 && rj.rejected[0].reason === "sender", "an undeclared human sender is rejected by bridge-recv");
  PORT = await freePort(); ORIGIN = `http://127.0.0.1:${PORT}`;
  const noHuman = start(); const code = await new Promise((r) => noHuman.on("exit", r));
  ok(code === 2 && /bridge-init .*--humans/.test(noHuman.output()), "bridge-web refuses to start without a declared human");
  ok(tool("bridge-init", ["--agents", "claude,grokbot", "--humans", "dj"]).status === 0 && bridge.humans(R).includes("dj"), "bridge-init --humans declares the human");
  ok(tool("bridge-init", ["--humans", "claude"]).status === 2, "a human cannot take an agent's name");
  const s1 = tool("bridge-send", qdj);
  ok(s1.status === 0, "a declared human sender is accepted by bridge-send");
  ok(bridge.recv({ root: R, as: "grokbot" }).processed.some((p) => p.header.FROM === "dj"), "a declared human sender is accepted by bridge-recv");

  // ---------- keys ----------
  ok(key(["--prefix", "AB1"]).status === 2 && key(["--prefix", "AB-1"]).status === 2, "prefix must be exactly 4 letters or digits");
  const k1 = key(["--prefix", "djab", "--label", "DJ"]);
  const K1 = (/^([A-Za-z0-9]{4}-[A-Za-z0-9]{32})$/m.exec(k1.stdout) || [])[1];
  ok(k1.status === 0 && K1 && K1.startsWith("DJAB-"), "bridge-key prints PREFIX-<32 characters>, prefix chosen by the person");
  const KF = path.join(WD, "keys.json");
  ok((fs.statSync(KF).mode & 0o777) === 0o600 && (fs.statSync(WD).mode & 0o777) === 0o700, "keys file 600, private folder 700");
  ok(!fs.readFileSync(KF, "utf8").includes(K1.slice(5)) && /"hash"/.test(fs.readFileSync(KF, "utf8")), "only the hash of the key is stored");
  ok(/DJAB-\*\*\*\*/.test(key(["--list"]).stdout) && !key(["--list"]).stdout.includes(K1), "bridge-key --list never shows a key");
  ok(key(["--revoke", JSON.parse(fs.readFileSync(KF, "utf8")).keys[0].id]).status === 2, "the last active key cannot be revoked");

  // ---------- the server ----------
  const srv = start();
  ok(await up(), "bridge-web starts and /health answers 200");
  ok((fs.statSync(path.join(WD, "session-secret")).mode & 0o777) === 0o600, "session secret 600");
  ok((fs.statSync(path.join(R, "files")).mode & 0o777) === 0o700, "files folder 700");
  const root = await req("GET", "/");
  ok(root.status === 302 && root.headers.location === "/login", "/ without a key redirects to /login");
  ok((await req("GET", "/api/messages")).status === 401 && (await req("GET", "/api/keys")).status === 401, "API answers 401 without a key");
  ok((await req("GET", "/app.js")).status === 302, "the page script is not public");
  ok((await req("PUT", "/")).status === 405, "other methods refused");
  ok((await post("/login", form({ key: K1 }), { headers: { Origin: "null" } })).status === 403, "POST with Origin: null refused (CSRF)");
  ok((await req("POST", "/login", { body: form({ key: K1 }), headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status === 403, "POST without Origin refused (CSRF)");
  ok((await req("GET", "/login")).headers["referrer-policy"] === "same-origin", "Referrer-Policy same-origin (no-referrer breaks the CSRF check in Chrome)");
  ok((await post("/login", form({ key: "DJAB-" + "x".repeat(32) }))).status === 401, "a wrong key is refused");
  const li = await post("/login", form({ key: K1 }));
  const C1 = cookieFrom(li);
  ok(li.status === 303 && li.headers.location === "/" && /^bridge_local=/.test(C1) && /HttpOnly/.test(li.headers["set-cookie"][0]) && /SameSite=Strict/.test(li.headers["set-cookie"][0]), "sign-in sets a session cookie");
  ok((await req("GET", "/api/messages", { cookie: C1 })).status === 200, "API answers 200 with the session");
  ok((await req("GET", "/api/messages", { cookie: C1.slice(0, -2) + "xx" })).status === 401, "a forged session is refused");
  const ipL = "203.0.113.9";
  let last; for (let i = 0; i < 6; i++) last = await post("/login", form({ key: "nope" }), { headers: { "X-Real-IP": ipL } });
  ok(last.status === 429, "5 sign-in attempts per minute per address");

  // ---------- language of the page ----------
  const lfr = await req("GET", "/login", { headers: { "Accept-Language": "fr-CA,fr;q=0.9" } });
  const len = await req("GET", "/login", { headers: { "Accept-Language": "en-US" } });
  ok(/lang="fr"/.test(lfr.body) && lfr.body.includes("Cle d&#39;acces") && /lang="en"/.test(len.body) && len.body.includes("Access key"), "the page follows the browser language");
  const mfr = await req("GET", "/", { cookie: C1, headers: { "Accept-Language": "fr" } });
  const js = JSON.parse((/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/.exec(mfr.body) || [])[1] || "{}");
  ok(mfr.status === 200 && js._speech === "fr-CA" && js._lang === "fr" && mfr.body.includes("Ecris aux agents (DJ)"), "main page in French with the speech language for dictation and read-aloud");

  // ---------- writing as the human ----------
  const sm = await postJson("/api/send", { text: "Hello agents, please check the build" }, C1);
  const sj = JSON.parse(sm.body);
  ok(sm.status === 200 && sj.ok && sj.to.length === 2, "the human's message is accepted");
  const inG = path.join(R, "to-grokbot", sj.id + ".msg"), inC = path.join(R, "to-claude", sj.id + ".msg");
  ok(fs.existsSync(inG) && fs.existsSync(inC) && (fs.statSync(inG).mode & 0o777) === 0o600, "dropped in every agent's inbox, same ID, mode 600");
  const ph = bridge.parseMessage(fs.readFileSync(inG, "utf8")).header;
  ok(ph.FROM === "dj" && ph["X-AUTHOR"] === "DJ" && ph["X-SOURCE"] === "web", "FROM is the human, the tag is X-AUTHOR");
  const rv = bridge.recv({ root: R, as: "grokbot" });
  ok(rv.processed.some((p) => p.id === sj.id) && !rv.rejected.length, "the agent receives the human's message (not rejected)");
  bridge.writeReply({ root: R, as: "grokbot", id: sj.id, status: "DONE", text: "Build is green." });
  const msgs = JSON.parse((await req("GET", "/api/messages", { cookie: C1 })).body);
  ok(msgs.filter((m) => m.id === sj.id && m.kind === "message").length === 1 && msgs.some((m) => m.id === sj.id && m.side === "human" && m.from === "DJ"), "the human's message is shown once, with the tag");
  ok(msgs.some((m) => m.id === sj.id && m.kind === "reply" && m.from === "grokbot" && m.status === "DONE"), "the agent's reply is shown");
  ok(JSON.parse((await postJson("/api/send", { text: "password=hunter2abc" }, C1)).body).code === "secret", "a password is refused");
  ok((await postJson("/api/send", { text: "my key " + K1 }, C1)).status === 422, "a page key is refused");
  ok((await postJson("/api/send", { text: "open http://x.example.com/setup/" + "A".repeat(40) }, C1)).status === 422, "a setup link is refused");
  ok((await postJson("/api/send", { text: "" }, C1)).status === 400, "an empty message is refused");
  ok((await postJson("/api/send", { text: "x".repeat(4001) }, C1)).status === 413, "a too long message is refused");
  ok(JSON.parse((await postJson("/api/send", { text: "" }, C1, { "Accept-Language": "fr" })).body).error === "message vide", "errors in the page language");

  // ---------- files ----------
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const upH = (name) => ({ Origin: ORIGIN, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) });
  ok((await req("POST", "/api/upload", { body: "not a png", headers: upH("a.png"), cookie: C1 })).status === 415, "a file whose content does not match its type is refused");
  ok((await req("POST", "/api/upload", { body: "x", headers: upH("a.exe"), cookie: C1 })).status === 415, "an unknown file type is refused");
  const up1 = JSON.parse((await req("POST", "/api/upload", { body: png, headers: upH("photo.png"), cookie: C1 })).body);
  ok(up1.ok && /^[0-9a-f]{24}$/.test(up1.token), "an image is uploaded");
  const sf = JSON.parse((await postJson("/api/send", { text: "see the photo", file: up1.token }, C1)).body);
  const fh = bridge.parseMessage(fs.readFileSync(path.join(R, "to-claude", sf.id + ".msg"), "utf8"));
  ok(sf.ok && fh.header["X-FILE"] === up1.token + ".png" && fh.body.includes("files/" + up1.token + ".png") && (fs.statSync(path.join(R, "files", up1.token + ".png")).mode & 0o777) === 0o600, "the file is attached, stored 600, its place is in the message");
  const fget = await req("GET", "/f/" + up1.token + ".png", { cookie: C1 });
  ok(fget.status === 200 && fget.headers["content-type"] === "image/png" && (await req("GET", "/f/" + up1.token + ".png")).status === 401, "the file is served to the session only");

  // ---------- setup link: once ----------
  const sl = key(["--setup-link", "--prefix", "ZQ12", "--label", "ZQ"], { BRIDGE_WEB_URL: "https://bridge.example.com" });
  const tok = (/\/setup\/([A-Za-z0-9]{40})/.exec(sl.stdout) || [])[1];
  ok(sl.status === 0 && tok && sl.stdout.includes("https://bridge.example.com/setup/"), "bridge-key --setup-link prints a link with the configured address");
  ok(!fs.readFileSync(KF, "utf8").includes(tok), "only the hash of the setup token is stored");
  ok((await req("GET", "/setup/" + tok)).status === 200, "the setup page opens");
  const su = await post("/setup/" + tok, form({ prefix: "ZQ12", label: "ZQ" }));
  const K2 = (/<code id="newkey">([^<]+)<\/code>/.exec(su.body) || [])[1];
  ok(su.status === 200 && /^ZQ12-[A-Za-z0-9]{32}$/.test(K2 || "") && cookieFrom(su), "the setup link shows the key once and signs in");
  ok((await post("/setup/" + tok, form({ prefix: "ZQ12" }))).status === 410 && (await req("GET", "/setup/" + tok)).status === 404, "the setup link works only once");
  const C2 = cookieFrom(await post("/login", form({ key: K2 })));
  ok((await req("GET", "/api/me", { cookie: C2 })).status === 200, "the new key signs in");

  // ---------- revoke ----------
  const list = JSON.parse((await req("GET", "/api/keys", { cookie: C1 })).body);
  ok(list.length === 2 && list.every((k) => !("hash" in k) && !("salt" in k)), "the key list never contains hashes");
  const id2 = list.find((k) => k.prefix === "ZQ12").id;
  ok(JSON.parse((await postJson("/api/keys/revoke", { id: id2 }, C1)).body).ok, "a key is revoked from the page");
  await sleep(20);
  ok((await req("GET", "/api/me", { cookie: C2 })).status === 401, "a revoked key ends its sessions");
  const nk = JSON.parse((await postJson("/api/keys/new", { prefix: "x!" }, C1)).body);
  ok(!nk.ok && nk.code === "prefix", "the page refuses a bad prefix");
  srv.kill();
  await new Promise((r) => srv.on("exit", r));

  // ---------- HTTPS mode and forced language ----------
  const srv2 = start({ BRIDGE_WEB_URL: "https://bridge.example.com", BRIDGE_LANG: "fr" });
  await up();
  const l2 = await req("GET", "/login", { headers: { "Accept-Language": "en-US" } });
  ok(/lang="fr"/.test(l2.body), "BRIDGE_LANG=fr forces French whatever the browser");
  ok(/max-age/.test(l2.headers["strict-transport-security"] || ""), "HTTPS mode sends HSTS");
  const li2 = await req("POST", "/login", { body: form({ key: K1 }), headers: { Origin: "https://bridge.example.com", "Content-Type": "application/x-www-form-urlencoded" } });
  ok(li2.status === 303 && /^__Host-bridge=/.test(li2.headers["set-cookie"][0]) && /Secure/.test(li2.headers["set-cookie"][0]), "HTTPS mode: __Host- cookie, Secure");
  ok((await req("POST", "/login", { body: form({ key: K1 }), headers: { Origin: "https://evil.example.net", "Content-Type": "application/x-www-form-urlencoded" } })).status === 403, "HTTPS mode: another origin is refused");
  srv2.kill();
  await new Promise((r) => srv2.on("exit", r));

  // ---------- the recipe ----------
  const doc = fs.readFileSync(path.join(REPO, "docs", "WEB-PAGE.md"), "utf8");
  ok(/^## 1\. Prerequisites/m.test(doc) && doc.indexOf("Prerequisites") < doc.indexOf("```"), "docs/WEB-PAGE.md starts with the prerequisites, before any command");
  ok(/language/i.test(doc) && /BRIDGE_LANG/.test(doc), "docs/WEB-PAGE.md tells the agent to set the person's language");
  const nx = fs.readFileSync(path.join(REPO, "deploy", "web-nginx.conf.example"), "utf8");
  ok(/limit_except GET HEAD POST \{ deny all; \}/.test(nx) && /client_max_body_size 12m;/.test(nx) && /proxy_request_buffering off;/.test(nx) && /X-Real-IP/.test(nx) && /X-Forwarded-Proto/.test(nx) && /proxy_set_header Host \$host;/.test(nx) && /bridge\.example\.com/.test(nx), "web nginx example: methods, body size, streaming, headers, example domain");
  const pat = JSON.parse(fs.readFileSync(path.join(REPO, "patterns", "bridge-web-page-howto.json"), "utf8"));
  ok(["title", "description", "quick_fix", "root_fix"].every((k) => typeof pat[k] === "string" && pat[k].length > 20), "web page pattern: valid, with its recipe");
  ok(/## Section D: the web page/.test(fs.readFileSync(path.join(REPO, "AGENT-INSTRUCTIONS.md"), "utf8")), "agent instructions point to the web page guide");

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
