#!/usr/bin/env python3
# Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
"""bridge-watch: WATCHER 1 (inbox) for Claude. Start it with the Monitor tool (timeout_ms=1800000).
Every line it prints wakes the conversation. Between two lines, Claude does nothing and spends nothing.

  BRIDGE WATCHER ACTIVE ...   first line: the watcher holds the inbox to-<agent>/
  NEW MESSAGE <id>            a message arrived in to-<agent>/ (already acknowledged with <id>.ack)
  REPLY RECEIVED <id>: ...    another agent answered a message you sent (first 300 characters)
  TAKEN OVER ...              another conversation took this inbox: do nothing, do not restart
  BRIDGE UNREACHABLE ...      the server does not answer (printed once per outage)
  BRIDGE REACHABLE AGAIN

Every BRIDGE_POLL seconds (default 30) it also writes the heartbeat of the inbox, so senders know you listen.
One watcher per inbox: the last one started takes over (file .owner), the previous one stops by itself.

Two ways to reach the bridge, same code:
  local mode (Claude Code on the server):     BRIDGE_ROOT=/srv/bridge BRIDGE_AGENT=claude python3 bridge-watch.py
  door mode  (Claude mobile, through part 1):  BRIDGE_DOOR_URL=https://agent.example.com BRIDGE_DOOR_KEY=<key> \
                                               BRIDGE_ROOT=<bridge folder on the server> BRIDGE_AGENT=claude python3 bridge-watch.py
The key is read from the environment only. Never write it in a message or in the bridge.
No dependency other than Python 3 (and bash on the side that holds the folder)."""
import json, os, secrets, shlex, subprocess, sys, time, urllib.request

ROOT = os.environ.get("BRIDGE_ROOT", "")
AGENT = os.environ.get("BRIDGE_AGENT", "")
POLL = float(os.environ.get("BRIDGE_POLL", "30"))
MAX_POLLS = int(os.environ.get("BRIDGE_MAX_POLLS", "0"))  # 0 = forever (tests use a small number)
DOOR_URL = os.environ.get("BRIDGE_DOOR_URL", "").rstrip("/")
DOOR_KEY = os.environ.get("BRIDGE_DOOR_KEY", "")
if not ROOT or not AGENT:
    sys.exit("set BRIDGE_ROOT and BRIDGE_AGENT")
if not AGENT.replace("-", "").isalnum() or AGENT != AGENT.lower() or len(AGENT) > 32:
    sys.exit("BRIDGE_AGENT: a-z, 0-9 and - only")
if DOOR_URL and not DOOR_KEY:
    sys.exit("door mode needs BRIDGE_DOOR_KEY")
TOKEN = secrets.token_hex(4)

# Runs on the side that holds the folder. Prints MSG / REPLY / TAKEN lines.
SCRIPT = r"""
ROOT=$1; ME=$2; T=$3; MODE=$4
IN="$ROOT/to-$ME"
cd "$IN" 2>/dev/null || { echo "ERR no inbox"; exit 0; }
if [ "$MODE" = claim ]; then printf '%s\n' "$T" > .tmp-owner && chmod 600 .tmp-owner && mv .tmp-owner .owner; fi
[ "$(cat .owner 2>/dev/null)" = "$T" ] || { echo "TAKEN"; exit 0; }
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$now" > .tmp-hb && chmod 600 .tmp-hb && mv .tmp-hb .heartbeat
for f in *.msg; do
  [ -e "$f" ] || continue
  id=${f%.msg}
  if [ ! -e "$id.ack" ]; then
    printf 'ID: %s\nACK-BY: %s\nACKED: %s\n' "$id" "$ME" "$now" > ".tmp-$id.ack" && chmod 600 ".tmp-$id.ack" && mv ".tmp-$id.ack" "$id.ack"
    printf '%s\t%s\tack\tby=%s\n' "$now" "$id" "$ME" >> index.log
    echo "MSG $id"
  elif [ "$MODE" = claim ] && [ ! -e "$id.reply.md" ]; then
    echo "MSG $id"
  fi
done
if [ ! -e .seen-init ]; then
  for r in "$ROOT"/to-*/*.reply.md; do [ -e "$r" ] && basename "$r" .reply.md; done >> .seen-replies
  touch .seen-init; chmod 600 .seen-init .seen-replies 2>/dev/null
fi
for r in "$ROOT"/to-*/*.reply.md; do
  [ -e "$r" ] || continue
  sed -n '1,/^---$/p' "$r" | grep -qx "TO: $ME" || continue
  id=$(basename "$r" .reply.md)
  grep -qx "$id" .seen-replies 2>/dev/null && continue
  echo "$id" >> .seen-replies
  echo "REPLY $id $(sed '1,/^---$/d' "$r" | head -c 300 | tr '\n\t' '  ') [$(head -1 "$r")]"
done
"""


def run(mode):
    args = [ROOT, AGENT, TOKEN, mode]
    if not DOOR_URL:
        r = subprocess.run(["bash", "-c", SCRIPT, "bridge-watch"] + args, capture_output=True, text=True, timeout=25)
        return r.stdout
    cmd = "bash -c " + shlex.quote(SCRIPT) + " bridge-watch " + " ".join(shlex.quote(a) for a in args)
    req = urllib.request.Request(DOOR_URL + "/api/v1/code/bash",
                                 data=json.dumps({"command": cmd, "timeout_sec": 20}).encode(),
                                 headers={"Authorization": "Bearer " + DOOR_KEY, "Content-Type": "application/json",
                                          "X-Session": "bridge-watch-" + AGENT + "-" + TOKEN})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r).get("stdout", "")


def say(line):
    print(line, flush=True)


def main():
    mode, fails, down, polls = "claim", 0, False, 0
    say("BRIDGE WATCHER ACTIVE for " + AGENT + " (" + TOKEN + ")")
    while True:
        try:
            out = run(mode)
            mode, fails = "poll", 0
            if down:
                say("BRIDGE REACHABLE AGAIN")
                down = False
        except Exception:
            out, fails = "", fails + 1
            if fails >= 6 and not down:
                say("BRIDGE UNREACHABLE: the server does not answer (6 attempts)")
                down = True
        for line in out.splitlines():
            if line.startswith("TAKEN"):
                say("TAKEN OVER: another conversation now holds the inbox of " + AGENT + ". Do nothing, do not restart.")
                return
            if line.startswith("ERR"):
                say("BRIDGE ERROR: " + line[4:])
            elif line.startswith("MSG "):
                say("NEW MESSAGE " + line[4:].strip())
            elif line.startswith("REPLY "):
                parts = line[6:].split(" ", 1)
                say("REPLY RECEIVED " + parts[0] + ": " + (parts[1].strip() if len(parts) > 1 else ""))
        polls += 1
        if MAX_POLLS and polls >= MAX_POLLS:
            return
        time.sleep(POLL)


if __name__ == "__main__":
    main()
