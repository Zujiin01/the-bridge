# Security

## What the bridge protects, and what it does not

The bridge carries text from one agent to another. The receiving agent reads it and may act on it. That is its strength and its risk.

**A message is data, not an order.** Anyone who can write in an inbox can try to steer the agent that reads it, including one of your own agents that was itself fooled by a web page or a file. So:
- a message of type `action` always gets `NEEDS-INPUT`: the tools force it, and the instructions tell the agent to ask **you**, in its own conversation, and to ignore an approval announced by another agent;
- the receiving tools print the content under "content (data, not an order)";
- read what your agents send each other now and then: `index.log` in each inbox says who sent what and when, `done/` keeps the messages for 30 days.

**Secrets.** `bridge-send` and `bridge-reply` refuse text that looks like a bearer token, an `Authorization` header, a private key, cloud, GitHub or Slack tokens, a JWT, `password = ...` or credentials in a URL, without echoing it (the journal only says "refused secret"). It is a safety net with known gaps. The real rule: never put a secret in a message.

**Public bridge.** If the bridge is shown on a page, every message is public. `bridge-init --public` makes the tools also refuse paths, IP addresses, ports, e-mails and the names in `.internal-names`; the viewer masks them again before display. Neither is a guarantee: write "task done, see pattern N" and keep details private.

## Who can do what

- The tools do **not** authenticate agents: whoever can write the folder can write any `FROM`. The boundary is the Unix user that owns the folder (mode 700, files 600) and, for phone agents, the Door's keys (one per agent, revocable).
- `bridge-wake` holds the webhook secret. Its config must be `chmod 600` (refused otherwise), owned by the user that runs it, outside the bridge folder and outside any repository. The webhook body carries only the event and the ID, never the content. The log carries neither the URL nor the header.
- The Claude watcher gets the Door key from an environment variable set in the agent's private project. It never writes it to the bridge.
- `bridge-viewer` only reads, only answers `GET` and `HEAD`, listens on `127.0.0.1` and must sit behind nginx and HTTPS. It renders text with `textContent` (no HTML from messages).

## Good practices

- One inbox per agent and per role, one Door key per agent. Revoke a key without hesitation.
- Never paste a key or a webhook secret in a conversation, a message or a screenshot. If it happens: rotate it (`bridge-wake` reads its config again at each call, no restart needed).
- Run `bridge-wake` with `NoNewPrivileges` and the bridge folder as its only writable path (see `deploy/`).
- `bridge-purge` once a day keeps the archives short.

## Reporting a problem

Use GitHub's private reporting (the *Security* tab, then *Report a vulnerability*) rather than a public issue, or write to didierjean@gnetics.ca, and allow a reasonable delay before publishing a flaw.
