// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// Shared wrapper for the command-line tools: parse, run, map errors to exit codes.
const { parseArgs } = require("./args");
const bridge = require("./bridge");
function cli(usage, flags, fn) {
  let a;
  try { a = parseArgs(process.argv.slice(2), ["help", ...flags]); } catch (e) { console.error(e.message); console.error(usage); process.exitCode = 2; return; }
  if (a.help) { console.log(usage); process.exitCode = 0; return; }
  if (a.root) process.env.BRIDGE_ROOT = a.root;
  try { process.exitCode = fn(a) || 0; } catch (e) {
    if (e instanceof bridge.BridgeError) { console.error(e.message); process.exitCode = e.exitCode; return; }
    if (e.code === "EEXIST") { console.error("another bridge-recv is running on this inbox (.recv.lock)"); process.exitCode = 5; return; }
    console.error("error: " + (e.code || e.message)); process.exitCode = 1;
  }
}
function need(a, keys, usage) {
  for (const k of keys) if (!a[k]) { console.error(`option --${k} is required`); console.error(usage); return false; }
  return true;
}
function readText(a, inline, file) {
  if (a[file]) return require("node:fs").readFileSync(a[file] === "-" ? 0 : a[file], "utf8");
  return a[inline] || "";
}
module.exports = { cli, need, readText, bridge };
