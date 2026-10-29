// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// Language of the web page. The repository is in English; the PAGE speaks the person's language.
// Order: BRIDGE_LANG (if it is a language of web/i18n.json) > the browser's Accept-Language > English.
// Dictation and read-aloud use the same language (_speech, or BRIDGE_SPEECH_LANG to force one, e.g. fr-FR).
const fs = require("node:fs");
const path = require("node:path");

const STRINGS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "i18n.json"), "utf8"));
const LANGS = Object.keys(STRINGS);
const DEFAULT = "en";

function norm(l) { return String(l || "").trim().toLowerCase().split(/[-_]/)[0]; }
// Accept-Language: "fr-CA,fr;q=0.9,en;q=0.8" -> best supported language, or null.
function fromAccept(header) {
  const items = String(header || "").split(",").map((part, i) => {
    const [tag, ...params] = part.trim().split(";");
    const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).filter(Boolean).map((m) => Number(m[1]))[0];
    return { lang: norm(tag), q: q === undefined ? 1 : q, i };
  }).filter((x) => x.lang && x.lang !== "*" && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  const hit = items.find((x) => LANGS.includes(x.lang));
  return hit ? hit.lang : null;
}
// forced: the configured language (BRIDGE_LANG). An unknown value is ignored (browser, then English).
function pick(forced, acceptHeader) {
  const f = norm(forced);
  if (f && LANGS.includes(f)) return f;
  return fromAccept(acceptHeader) || DEFAULT;
}
function strings(lang, env = process.env) {
  const s = { ...STRINGS[DEFAULT], ...(STRINGS[lang] || {}) };
  if (env.BRIDGE_SPEECH_LANG && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(env.BRIDGE_SPEECH_LANG)) s._speech = env.BRIDGE_SPEECH_LANG;
  s._lang = STRINGS[lang] ? lang : DEFAULT;
  return s;
}
function fill(str, vars = {}) { return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k]))); }

module.exports = { STRINGS, LANGS, DEFAULT, pick, fromAccept, strings, fill };
