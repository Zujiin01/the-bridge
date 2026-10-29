# Changelog

## 0.2.0

The web page behind a key: `bin/bridge-web.js` (whole site behind a key, the human writes in the channel with a tag, attached files, dictation and read-aloud, page in the person's language: `web/i18n.json` with English and French, `BRIDGE_LANG`, else the browser's language) and `bin/bridge-key.js` (prefix of 4 characters chosen by the person, the rest generated, only a scrypt hash stored, mode 600; one-time setup link or key printed in the terminal). Node built-in modules only. Humans allowed to write are configured with `bridge-init --humans <name>` (`<bridge>/.humans`): `bridge-send` refuses and `bridge-recv` rejects a sender that is neither an agent nor a declared human. Messages can carry extra `X-` header fields. A page key or a setup link in a message is refused like any secret. New guide `docs/WEB-PAGE.md` (prerequisites first, level 1 localhost, level 2 sub-domain, who does what, lessons learned, limits), Section D of AGENT-INSTRUCTIONS.md, `deploy/web-nginx.conf.example`, `deploy/bridge-web.service.example`, `patterns/bridge-web-page-howto.json`. New test file `test/web.js`; `npm test` runs both files.

## 0.1.1

The public page, step by step: Section C of AGENT-INSTRUCTIONS.md lets an agent build and publish the read-only bridge page itself (public bridge, viewer under pm2, DNS, nginx, HTTPS, checks from outside, with the owner's yes for what is visible from outside). New `deploy/viewer-nginx.conf.example` (GET and HEAD only) and `patterns/bridge-viewer-howto.json` for OPS Memory. 3 more tests.

## 0.1.0

First public version: a bridge folder with one inbox per agent, a fixed message format (header, `---`, body), acknowledgement (`.ack`), replies with a status on the first line (DONE, WIP, BLOCKED, NEEDS-INPUT), expiry, duplicates, rejects and archives, append-only journal, heartbeat, refusal of secrets and of public details on a public bridge. Two ways to wake an agent: the Claude watchers (inbox and reset, run with Monitor, locally or through the Door) and `bridge-wake`, a server watcher that calls a webhook (GrokBot routine or any agent with a webhook trigger). Minimal read-only viewer with redaction for a public demo, local trial (`npm run try`), tests (`npm test`), systemd and pm2 examples, an install script (`install/install.sh`), neutral tool definitions for agents built on an API (`tools/bridge-tools.json`), a starter pattern for OPS Memory.
