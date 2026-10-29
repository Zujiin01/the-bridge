// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// Minimal parser for --key value, --key=value and --flag.
function parseArgs(argv, flags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (flags.includes(k)) { out[k] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`missing value for --${k}`);
    out[k] = argv[++i];
  }
  return out;
}
module.exports = { parseArgs };
