# Serena cookbook

Practical recipes for using [Serena](https://github.com/oraios/serena)'s
semantic code tools with pi-web, once the bridge extension (`serena.ext.ts`,
see `README.md` in this directory) is installed. Nothing here is pi-web
code — it's usage guidance for you and for the prompts you write.

## 1. Install Serena itself

Serena is a separate tool you install on whichever machine runs `pi` (the
pi-web host, or the remote SSH host in `--ssh` relay mode) — this repo does
not vendor or install it.

No persistent install, run via `uv`:

```sh
uvx --from git+https://github.com/oraios/serena serena start-mcp-server --help
```

Or clone and install locally per Serena's own README, then confirm it's on
`PATH`:

```sh
which serena
```

## 2. Start a persistent instance for the project

Unlike older versions of this bridge, the extension no longer spawns Serena
itself — you (or systemd) start one long-lived Serena instance per project,
**before** opening any pi-web chats against it:

```sh
pi-serena/serena-daemon.sh /path/to/your/project
```

This picks a free port, starts `serena start-mcp-server --transport
streamable-http` detached from your shell, and writes the port to
`.serena/pi-web-port` inside the project — the file the bridge extension
reads to find it. Logs go to `.serena/pi-web-daemon.log`.

Prefer it survive reboots/logouts without a standing terminal? Use the
`serena@.service` systemd **user** unit template in this directory instead
— see the comments at the top of that file for the full setup (it covers
the `systemd-escape` step needed to turn a project path into a valid unit
instance name).

Either way, this is a one-time step per project (until you reboot or the
instance dies) — not something you repeat per chat.

## 3. Index a project

Semantic tools (`find_symbol`, `find_referencing_symbols`, …) work without
an index, but building one first makes the initial symbol lookups fast
instead of lazily built on first use — worth it for anything beyond a small
repo:

```sh
serena project index /path/to/your/project
```

This writes `.serena/cache/<language>/document_symbols_cache_*.pkl` inside
the project. That directory's presence is what pi-web's monitoring popover
(the header's Serena dot) reports as "indexed."

Re-run it after large refactors or language-server upgrades if symbol
lookups start feeling stale; there's no watch mode, it's a point-in-time
snapshot.

## 4. Add a project to pi-web

Starting the persistent instance, indexing, and adding the project to
pi-web's sidebar are three independent steps — do all three:

1. `pi-serena/serena-daemon.sh /path/to/project` (step 2 above).
2. `serena project index /path/to/project` (step 3 above).
3. Add the same path as a pi-web project from the sidebar (`+` button), or
   via `POST /api/projects`.

The bridge extension matches a chat to its project's Serena instance purely
by reading `<project>/.serena/pi-web-port` — pi's own `cwd` for that chat
is always the project path, so no pi-web-side project mapping is needed
beyond having started the instance at the right path.

## 5. Check the connection

Open any chat and hover/click the Serena indicator next to the SSH dot in
the header. It shows, per live Serena instance:

- **Connected** — at least one `serena start-mcp-server` process is up and
  its dashboard answered `/heartbeat`.
- **Active project** — which project that instance is bound to.
- **Indexed projects** — every known pi-web project with a `.serena/cache/`
  directory, regardless of whether an instance is currently running for it.
- **Tool call counts / token usage** — per-tool stats straight from
  Serena's own dashboard API, plus which token estimator produced them.

If it shows disconnected: confirm you ran `serena-daemon.sh` (or started
the `serena@.service` unit) for that project and that it's still running
(`ps aux | grep start-mcp-server`, or `systemctl --user status
serena@<escaped-path>.service`), check pi's own logs for the "couldn't
connect" warning the bridge extension emits, and confirm the extension is
actually installed (`~/.pi/agent/extensions/serena.ext.ts` — see
`README.md`).

## 6. Prompting patterns that use Serena well

The bridge extension already nudges the model to reach for Serena first;
these patterns get more out of it once it does:

- **"Where is X defined/used?"** — let the model use `find_symbol` /
  `find_referencing_symbols` instead of grepping. Faster and precise on
  symbol boundaries (won't match a comment or string containing the name).
- **"Give me the shape of this file/module before you dive in"** — maps to
  `get_symbols_overview`, cheaper than reading a whole large file.
- **Renames / structural edits** — `rename_symbol`, `safe_delete_symbol`,
  `replace_symbol_body` are LSP-aware; prefer them over text-diff edits
  for anything symbol-shaped (a function, a class, a method body).
- **Free-text / non-code search** (log lines, TODO comments, config
  values) — Serena's `search_for_pattern` still works, but this is exactly
  the case where plain text search is equally fine; don't force it.
- **Cross-project questions** — `list_queryable_projects` /
  `query_project` if you've indexed more than one related repo and want
  the agent to check a sibling project without switching chats.

## 7. Tool call coloring in the UI

Any tool call whose name matches `mcp__serena__*` renders in a distinct
violet (`--msg-tool-serena` in `style.css`, user-adjustable from the color
profile popover) instead of the default blue, both in the main transcript
and inside sub-agent activity logs — so you can tell at a glance whether
the agent is using Serena's semantic tools or falling back to built-ins.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Popover shows disconnected, no error in chat | No persistent instance running for that project — run `serena-daemon.sh /path/to/project` (or check the systemd unit's status); check `--ssh` target if relay mode is active, since the instance must run on the same host as `pi` |
| Popover connected, but tool calls never appear violet / model never uses Serena | Extension loaded but tool registration or the system-prompt append didn't take — check pi's own logs for extension load errors; see the "Status" caveats in `README.md` about unverified API surface |
| Project shows as not indexed despite running `serena project index` | Indexed a different path than the one added to pi-web (symlinks, trailing slash, or a monorepo subdirectory mismatch) — the check is an exact-path `.serena/cache/` lookup |
| Works locally, not over `--ssh` | Serena must be installed **and running** on the **remote** host, not the pi-web host — start `serena-daemon.sh` there (or the systemd unit there), not on the machine running the pi-web server |
| Stale/dead port file — extension logs a "couldn't connect" warning even though `.serena/pi-web-port` exists | The instance that wrote it was killed (manual `kill`, reboot without the systemd unit enabled, OOM, …) and never restarted. Delete `<project>/.serena/pi-web-port` and re-run `serena-daemon.sh /path/to/project` (or restart the systemd unit, which rewrites the port file itself on every start) |
| Dashboard stats look stale/reset | Restarting a project's Serena instance (manually, or via systemd's `Restart=on-failure`) starts fresh in-memory stats — call counts don't persist across a restart |

## 9. Uninstall / disable

Stop the persistent instance(s) — `pkill -f start-mcp-server` for a
manually-started one, or `systemctl --user disable --now
serena@<escaped-path>.service` per project for the systemd path — then
remove the extension so pi stops trying to connect to Serena:

```sh
rm ~/.pi/agent/extensions/serena.ext.ts
```

Existing `.serena/cache/` indexes and `.serena/pi-web-port` files are
harmless to leave in place — safe to delete per-project if you want to
reclaim the space or force a clean re-check.
