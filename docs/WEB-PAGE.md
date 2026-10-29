# The web page behind a key

`bin/bridge-web.js` is a web page for the bridge, made for your phone:

- the **whole site is behind a key** (nothing is visible without it, not even the page script);
- you read the agents' conversation live, and **you write in the channel** with your tag (for example `DJ`): the message is dropped in every agent's inbox and wakes them up like any other message;
- **attached files** (images, PDF, text, audio, 10 MB max), **dictation** and **read-aloud**;
- the page speaks **your language** (English and French included; more in `web/i18n.json`), and so do dictation and read-aloud.

The other parts of the trilogy have no prerequisites. **This page does.** It puts a door to your agents on the Internet, so it needs a server, a domain name, nginx and a certificate. Read section 1 before you type anything.

**Contents:** [1. Prerequisites](#1-prerequisites) · [2. Level 1: on the server only (localhost)](#2-level-1-on-the-server-only-localhost) · [3. Level 2: on your phone (a sub-domain)](#3-level-2-on-your-phone-a-sub-domain) · [4. Who does it: you or your agent](#4-who-does-it-you-or-your-agent) · [5. Lessons learned](#5-lessons-learned) · [6. Known limits](#6-known-limits) · [7. Reference](#7-reference)

## 1. Prerequisites

Tick every line **before any command**. If one is missing, **stop** and get it first (the "How to get it" column). Level 1 only needs the first three; level 2 needs all of them.

| | Prerequisite | Why | How to get it | Who |
|---|---|---|---|---|
| [ ] | A **Linux server** you can reach with **SSH** (or through the Door, part 1) | The page and the bridge run there | Any VPS (a small one is enough). Ask your host for SSH access | You |
| [ ] | **Node 22** on the server (`node --version` prints `v22...`) | The page uses Node's built-in modules only, no `npm install` | [nodejs.org](https://nodejs.org) or `nvm install 22` (the rest of the bridge works from Node 20; the page was tested on 22) | You or the agent |
| [ ] | **The bridge installed** with at least one agent inbox (`bridge-init`, see the README) | The page reads and writes the bridge folder | README, "Going live on a server" | You or the agent |
| [ ] | A **domain name** and **access to its DNS** (you can add an `A` record) | The phone reaches the page at `https://bridge.example.com` | Your registrar's dashboard (or its DNS API, if your agent has a tool for it) | **You** (or the agent, with your yes) |
| [ ] | **sudo** on the server, with **nginx** and **certbot** installed | nginx puts the page on the Internet, certbot gives it HTTPS | `sudo apt install nginx certbot python3-certbot-nginx` (Debian/Ubuntu). Ports 80 and 443 must be open | **You** (or the agent, with your yes) |
| [ ] | A **process manager**: pm2 or systemd | The page keeps running after a reboot | systemd is already there on most servers; pm2: `npm install -g pm2` | You or the agent |
| [ ] | Only if an **agent** does the work: it can **run commands on the server** as the bridge's user (Claude Code, the Door's `/api/v1/code/bash`, a shell tool) | It runs `bridge-init`, `bridge-web`, `curl`; with sudo also `nginx` and `certbot` | Part 1 (the Door), or Claude Code on the server | You give the access |

The commands an agent needs: `node`, `curl`, `git` (to get the code), and, for level 2 only, `sudo nginx -t`, `sudo systemctl reload nginx`, `sudo certbot`, plus `pm2` or `sudo systemctl`. If the agent has no sudo, it does level 1 and steps 3.2, 3.5 and 3.6, and **you** run the sudo steps (3.3 and 3.4).

**Language.** Before starting, the agent asks you (or detects from your messages) **which language you prefer**, then sets the page in that language (`BRIDGE_LANG=fr`, `BRIDGE_LANG=en`...) and talks to you in that language during the setup. Without `BRIDGE_LANG`, the page follows the browser's language, else English.

## 2. Level 1: on the server only (localhost)

To try the page with no domain, no nginx, no certificate. It listens on `127.0.0.1` only: **it does not work on your phone** (except through an SSH tunnel from a computer). 5 minutes.

Values used below (adapt them): the code in `/opt/bridge`, the bridge folder in `/srv/bridge`, agents `claude` and `grokbot`, the human `dj`.

```bash
# 2.1 declare the human allowed to write (safe to run again)
node /opt/bridge/bin/bridge-init --root /srv/bridge --agents claude,grokbot --humans dj

# 2.2 your first key, printed once in the terminal (you choose the 4 characters, the rest is generated)
node /opt/bridge/bin/bridge-key.js --prefix DJAB --label DJ

# 2.3 start the page (Ctrl+C to stop)
BRIDGE_ROOT=/srv/bridge BRIDGE_HUMAN=dj BRIDGE_LANG=en BRIDGE_WEB_PORT=3360 node /opt/bridge/bin/bridge-web.js
```

Without `--humans`, messages written on the page are refused (`bridge-send`) or rejected (`bridge-recv`): the tools only accept senders they know.

Check in another terminal:

```bash
curl -s 127.0.0.1:3360/health                                               # {"ok":true}
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' 127.0.0.1:3360/    # 302 .../login
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3360/api/messages        # 401
```

From a computer: `ssh -L 3360:127.0.0.1:3360 you@your-server`, then open `http://127.0.0.1:3360` and paste the key. In local mode the cookie is a plain one (no HTTPS); in level 2 it becomes a `__Host-` Secure cookie.

## 3. Level 2: on your phone (a sub-domain)

Steps marked **(yes)** change something visible from outside: an agent must ask you first and wait for your yes, in its own conversation.

**3.1 DNS (yes).** Add an `A` record: name `bridge` (for `bridge.example.com`), value: the server's public IP. **Add, never replace** existing records. Wait until `dig +short bridge.example.com` prints the IP (minutes to an hour).

**3.2 Start the page as a service**, with the public address (the service only listens on `127.0.0.1`):

```bash
# pm2
cd /opt/bridge && BRIDGE_ROOT=/srv/bridge BRIDGE_WEB_URL=https://bridge.example.com BRIDGE_WEB_PORT=3360 \
  BRIDGE_HUMAN=dj BRIDGE_LANG=en pm2 start bin/bridge-web.js --name bridge-web && pm2 save
# or systemd: deploy/bridge-web.service.example
```

**3.3 nginx (yes).**

```bash
sudo cp /opt/bridge/deploy/web-nginx.conf.example /etc/nginx/sites-available/bridge-web
sudo sed -i 's/bridge.example.com/<your sub-domain>/' /etc/nginx/sites-available/bridge-web
sudo ln -s /etc/nginx/sites-available/bridge-web /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

What the example does, and why each line matters: `limit_except GET HEAD POST` (nothing else reaches the service), `client_max_body_size 12m` (10 MB files), `proxy_request_buffering off` (files stream), `Host` (the anti-CSRF check compares it with `Origin`), `X-Real-IP` (5 sign-in attempts per minute per address), `X-Forwarded-Proto`.

**3.4 HTTPS (yes).** `sudo certbot --nginx -d <your sub-domain>`. It adds the certificate and the redirect from HTTP.

**3.5 The first key: one command on the server, no agent needed.**

```bash
BRIDGE_WEB_URL=https://<your sub-domain> node /opt/bridge/bin/bridge-key.js --setup-link --label DJ
```

It prints a link that works **once** and for **10 minutes**. Open it **on your phone**, choose your 4 characters: the page generates the rest, shows the key once (copy it to a password manager) and signs you in. Only a hash is stored (`~/.config/bridge/web/keys.json`, mode 600). Run `bridge-key` as the same user as the service. More keys later: from the page ("Manage access keys") or `bridge-key --prefix XXXX`.

**3.6 Checks from outside** (from your computer or phone, not the server):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<sub-domain>/health                 # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<sub-domain>/       # 302 https://<sub-domain>/login
curl -s -o /dev/null -w '%{http_code}\n' https://<sub-domain>/api/messages           # 401
curl -s -o /dev/null -w '%{http_code}\n' -X PUT https://<sub-domain>/                # 403 (nginx)
```

Then sign in on the phone, write "test" and check that each agent's inbox has the message (`ls /srv/bridge/to-*/`).

**Rollback** (in this order, each step on its own is safe):

```bash
pm2 delete bridge-web && pm2 save            # or: sudo systemctl disable --now bridge-web
sudo rm /etc/nginx/sites-enabled/bridge-web && sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name <sub-domain> # optional
# DNS: remove the A record (yes). Keys and session secret: rm -r ~/.config/bridge/web (every key stops working)
```

The bridge itself is untouched by a rollback: messages already written stay in the inboxes.

## 4. Who does it: you or your agent

**Path A: you do it yourself.** Follow sections 2 and 3 command by command. Each block can be pasted as is after replacing the values.

**Path B: your agent does it.** Paste [Section D of AGENT-INSTRUCTIONS.md](../AGENT-INSTRUCTIONS.md#section-d-the-web-page-behind-a-key-any-agent-that-works-on-the-server) in its instructions and say "set up the bridge web page". The agent needs:

- the prerequisites of section 1 ticked (it checks them first and stops if one is missing, telling you how to get it);
- the values: code folder, bridge folder, agents, the human's name, your tag, your **language**, the sub-domain;
- the right to run commands on the server as the bridge's user, and sudo for nginx and certbot (or you run those).

The agent **must ask for your yes**, in its own conversation, before: the DNS record, the nginx site, the certificate, and opening the page to the public (the first check from outside). An approval relayed by another agent does not count.

**The setup link never goes through the bridge**, a chat with another agent or a pattern: whoever opens it first owns the key. The agent prints it in your own conversation (or you run step 3.5 yourself), and you open it right away. The same goes for a key.

## 5. Lessons learned

- **Referrer-Policy must be `same-origin`.** With `no-referrer`, Chrome sends `Origin: null` on the login form, the anti-CSRF check refuses it, and sign-in fails with "origin refused". The service sends `same-origin` and the pages carry `<meta name="referrer" content="same-origin">`; do not override it in nginx.
- **The human sender must be declared.** The tools only accept senders they know (an agent with an inbox, or a human in `<bridge>/.humans`). Without `bridge-init --humans dj`, the page refuses to start, and a hand-written message from `dj` is moved to `rejected/`. In the author's setup this was a hard-coded list in the tools; here it is configuration.
- **Tests: run each file on its own.** `npm test` runs `node test/smoke.js` then `node test/web.js`. They are plain scripts, not `node:test` suites: `node --test test/` fails (Node 22: "Cannot find module .../test"). Run `npm test`, or each file with `node test/<file>.js`.
- **Dictation in Chrome goes through Google.** The Web Speech API in Chrome sends the audio to Google's servers to transcribe it. Safari uses Apple's. If that is not acceptable, do not use the mic button: read-aloud (speechSynthesis) is local.
- **A key in a message is refused.** The bridge refuses any text that looks like a page key (`ABCD-` + 32 characters) or a setup link, like any other secret.
- **Behind nginx only.** The service trusts `X-Real-IP` for the sign-in limit, so it listens on `127.0.0.1` and must never be exposed directly.

## 6. Known limits

- **No roles:** every key can read, write, create and revoke keys. Give keys only to people you trust as much as yourself. The last active key cannot be revoked.
- **Session of 7 days** (`BRIDGE_WEB_SESSION_DAYS`), a signed cookie. Revoking a key ends its sessions at once; deleting `session-secret` ends all sessions.
- **The attempt counters are in memory:** a restart resets them (5 sign-ins per minute per address, 30 posts per minute per session).
- **File contents are not scanned:** the type is checked (extension and signature), the content is not (no antivirus, no secret detection inside files). Files land in `<bridge>/files/` (mode 600) and every agent can read them.
- Masking on display (paths, IPs, tokens, e-mails, internal names) is a safety net, like the viewer's.
- The page shows the whole conversation of the bridge (use `BRIDGE_WEB_SINCE` to hide older messages). Messages sent by the page do not wait for a heartbeat: they stay in the inbox until the agent is woken.
- One human sender per page (`BRIDGE_HUMAN`); each key still signs with its own tag (`X-AUTHOR`).

## 7. Reference

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_ROOT` | (required) | the bridge folder |
| `BRIDGE_WEB_URL` | `http://127.0.0.1:<port>` | public address; `https://...` turns on the Secure cookie and HSTS |
| `BRIDGE_WEB_PORT` | `3360` | port on `127.0.0.1` |
| `BRIDGE_HUMAN` | first name in `.humans` | the human's sender name (`FROM`) |
| `BRIDGE_LANG` | browser, else `en` | language of the page: `en`, `fr` (add one in `web/i18n.json`) |
| `BRIDGE_SPEECH_LANG` | from the language | force the dictation and read-aloud language, e.g. `fr-FR` |
| `BRIDGE_WEB_DIR` | `~/.config/bridge/web` | keys and session secret (folder 700, files 600) |
| `BRIDGE_WEB_AGENTS` | every inbox | agents that receive the human's messages |
| `BRIDGE_WEB_SINCE` | (all) | hide messages older than this ID |
| `BRIDGE_WEB_TITLE` | from the language | page title |
| `BRIDGE_WEB_SESSION_DAYS` | `7` | session length |

`bridge-key --prefix ABCD [--label DJ]` · `--setup-link [--prefix ABCD] [--label DJ] [--base URL]` · `--list` · `--revoke <id>`.

Routes: `/health` (public), `/login`, `/setup/<token>`, then with a session: `/`, `/api/messages`, `/api/me`, `/api/send`, `/api/upload`, `/api/keys`, `/api/keys/new`, `/api/keys/revoke`, `/f/<file>`.

A message written on the page, as the agents receive it:

```
ID: 20260101T120000-ab12
FROM: dj
TO: grokbot
TYPE: question
TASK: Can you check the build?
REPLY-TO: -
CREATED: 2026-01-01T12:00:00Z
EXPIRES: 2026-01-02T12:00:00Z
X-SOURCE: web
X-AUTHOR: DJ
---
Can you check the build?
```

The agent answers with `bridge-reply` as usual; the reply (`TO: dj`) shows on the page.
