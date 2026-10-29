// Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"use strict";
// Detection and redaction of sensitive text.
// SECRETS: always refused in a message, whatever the mode.
// PUBLIC: details that must not appear on a public page (paths, IPs, ports, e-mails, long tokens).
//         Refused by bridge-send when the bridge is public, and masked by the viewer in every case.

const SECRETS = [
  { name: "bearer", re: /\bbearer\s+[A-Za-z0-9._~+\/=-]{8,}/i },
  { name: "authorization header", re: /\bauthorization\s*:/i },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: "api key prefix", re: /(^|[^A-Za-z0-9_])(sk|pk|rk)[-_](live[-_]|test[-_])?[A-Za-z0-9]{12,}/ },
  { name: "github token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "cloud key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { name: "password assignment", re: /\b(pass(word|wd)?|pwd|secret|api[_-]?key|token)\s*[=:]\s*\S{4,}/i },
  { name: "credentials in url", re: /[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]*:[^\s\/@]+@/i },
  { name: "prefixed key", re: /\b[a-z]{2,5}_(dev|live|prod|test)_[A-Za-z0-9]{12,}/i },
];

const PUBLIC = [
  { name: "ip address", re: /\b\d{1,3}(\.\d{1,3}){3}\b/g, mask: "[address]" },
  { name: "absolute path", re: /(^|[\s"'(=:,])(~\/|\/(home|etc|var|usr|opt|root|tmp|srv|mnt|Users)\/)[^\s"'),]*/g, mask: "$1[path]" },
  { name: "host and port", re: /(\[address\]|\blocalhost|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}):\d{2,5}\b/gi, mask: "[address]" },
  { name: "port", re: /\bports?\s*[:#]?\s*\d{2,5}\b/gi, mask: "port [hidden]" },
  { name: "e-mail", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, mask: "[e-mail]" },
  { name: "long token", re: /\b[A-Za-z0-9_\-]{32,}\b/g, mask: "[token]" },
];

function findSecret(text) {
  const hit = SECRETS.find((s) => s.re.test(String(text)));
  return hit ? hit.name : null;
}

function findPublicDetail(text, extraNames = []) {
  const s = String(text);
  for (const p of PUBLIC) {
    p.re.lastIndex = 0;
    const m = s.match(p.re);
    if (m) return p.name;
  }
  for (const n of extraNames) if (n && new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(s)) return "internal name";
  return null;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Masks secrets and public details. extraNames: internal names to hide (from the bridge's .internal-names file).
function redact(text, extraNames = []) {
  let s = String(text);
  for (const sec of SECRETS) s = s.replace(new RegExp(sec.re.source, sec.re.flags.includes("g") ? sec.re.flags : sec.re.flags + "g"), "[secret]");
  for (const p of PUBLIC) s = s.replace(p.re, p.mask);
  for (const n of extraNames) if (n) s = s.replace(new RegExp(`\\b${escapeRe(n)}\\b`, "gi"), "[internal]");
  return s;
}

module.exports = { findSecret, findPublicDetail, redact, SECRETS, PUBLIC };
