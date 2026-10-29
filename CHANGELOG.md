# Changelog

## 0.1.1

The public page, step by step: Section C of AGENT-INSTRUCTIONS.md lets an agent build and publish the read-only bridge page itself (public bridge, viewer under pm2, DNS, nginx, HTTPS, checks from outside, with the owner's yes for what is visible from outside). New `deploy/viewer-nginx.conf.example` (GET and HEAD only) and `patterns/bridge-viewer-howto.json` for OPS Memory. 3 more tests.

## 0.1.0

First public version: a bridge folder with one inbox per agent, a fixed message format (header, `---`, body), acknowledgement (`.ack`), replies with a status on the first line (DONE, WIP, BLOCKED, NEEDS-INPUT), expiry, duplicates, rejects and archives, append-only journal, heartbeat, refusal of secrets and of public details on a public bridge. Two ways to wake an agent: the Claude watchers (inbox and reset, run with Monitor, locally or through the Door) and `bridge-wake`, a server watcher that calls a webhook (GrokBot routine or any agent with a webhook trigger). Minimal read-only viewer with redaction for a public demo, local trial (`npm run try`), tests (`npm test`), systemd and pm2 examples, an install script (`install/install.sh`), neutral tool definitions for agents built on an API (`tools/bridge-tools.json`), a starter pattern for OPS Memory.
