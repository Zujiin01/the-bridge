#!/usr/bin/env node
// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// bridge-key: access keys of the web page (bin/bridge-web.js). The person chooses the 4-character prefix,
// the platform generates the rest. Only a hash is stored (BRIDGE_WEB_DIR/keys.json, mode 600).
const { parseArgs } = require("../lib/args");
const keystore = require("../lib/keystore");
const USAGE = `usage: bridge-key --prefix ABCD [--label DJ]
         generates ABCD-<32 random characters>, stores its hash, prints the key ONCE (local use: the terminal is the safe place)
       bridge-key --setup-link [--prefix ABCD] [--label DJ] [--base https://bridge.example.com]
         one-time link (10 min) that shows the key once in the browser; give it only to the person, never in a bridge message
       bridge-key --list            lists the keys (never the hashes)
       bridge-key --revoke <id>     revokes a key (its sessions end)
  BRIDGE_WEB_DIR: private folder (default ~/.config/bridge/web). BRIDGE_WEB_URL: default --base. Run it as the user of bridge-web.`;
let a;
try { a = parseArgs(process.argv.slice(2), ["help", "list", "setup-link"]); } catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
if (a.help) { console.log(USAGE); process.exit(0); }
try {
  const ks = keystore.open(process.env.BRIDGE_WEB_KEYS);
  if (a.list) {
    const l = ks.list();
    if (!l.length) console.log("no key");
    for (const k of l) console.log(`${k.id}  ${k.prefix}-****  tag=${k.label}  created=${k.created}  ${k.revoked ? "REVOKED " + k.revoked : "active"}${k.lastLogin ? "  last sign-in=" + k.lastLogin : ""}`);
  } else if (a.revoke) {
    const k = ks.revoke(String(a.revoke));
    console.log(`key ${k.id} (${k.prefix}) revoked`);
  } else if (a["setup-link"]) {
    const port = process.env.BRIDGE_WEB_PORT || 3360;
    const base = String(a.base || process.env.BRIDGE_WEB_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(base)) throw new Error("--base must look like https://bridge.example.com");
    const s = ks.createSetup({ prefix: a.prefix, label: a.label });
    console.log(`Setup link (works once, valid ${s.minutes} min):\n${base}/setup/${s.token}\nOpen it only on the device of the person who receives the key. Never paste it in a bridge message.`);
  } else if (a.prefix) {
    const k = ks.createKey({ prefix: a.prefix, label: a.label, by: "bridge-key" });
    console.log(`New key (id ${k.id}, tag ${k.label}). It will never be shown again, keep it now (a password manager):\n${k.key}`);
  } else { console.error(USAGE); process.exit(2); }
} catch (e) { console.error("refused: " + e.message); process.exit(2); }
