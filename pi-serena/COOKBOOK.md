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

The bridge extension spawns `serena start-mcp-server` itself — you don't
run that command by hand day to day. Use the CLI directly only for the
one-off setup steps below.

## 2. Index a project

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

## 3. Add a project to pi-web

Indexing and adding the project to pi-web's sidebar are independent steps
— do both:

1. `serena project index /path/to/project` (above).
2. Add the same path as a pi-web project from the sidebar (`+` button), or
   via `POST /api/projects`.

Serena resolves which project it's working on itself
(`--project-from-cwd`, matching pi's own cwd for that chat), so no
pi-web-side project mapping is needed beyond having indexed the right path.

## 4. Check the connection

Open any chat and hover/click the Serena indicator next to the SSH dot in
the header. It shows, per live Serena instance:

- **Connected** — at least one `serena start-mcp-server` process is up and
  its dashboard answered `/heartbeat`.
- **Active project** — which project that instance is bound to.
- **Indexed projects** — every known pi-web project with a `.serena/cache/`
  directory, regardless of whether an instance is currently running for it.
- **Tool call counts / token usage** — per-tool stats straight from
  Serena's own dashboard API, plus which token estimator produced them.

If it shows disconnected: confirm `serena` is on `PATH` on the host running
`pi`, check that host's pi logs for the "Serena not available" warning the
bridge extension emits, and confirm the extension is actually installed
(`~/.pi/agent/extensions/serena.ext.ts` — see `README.md`).

## 5. Prompting patterns that use Serena well

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

## 6. Tool call coloring in the UI

Any tool call whose name matches `mcp__serena__*` renders in a distinct
violet (`--msg-tool-serena` in `style.css`, user-adjustable from the color
profile popover) instead of the default blue, both in the main transcript
and inside sub-agent activity logs — so you can tell at a glance whether
the agent is using Serena's semantic tools or falling back to built-ins.

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Popover shows disconnected, no error in chat | `serena` not on `PATH` for the `pi` process's host — check `--ssh` target if relay mode is active |
| Popover connected, but tool calls never appear violet / model never uses Serena | Extension loaded but tool registration or the system-prompt append didn't take — check pi's own logs for extension load errors; see the "Status" caveats in `README.md` about unverified API surface |
| Project shows as not indexed despite running `serena project index` | Indexed a different path than the one added to pi-web (symlinks, trailing slash, or a monorepo subdirectory mismatch) — the check is an exact-path `.serena/cache/` lookup |
| Works locally, not over `--ssh` | Serena must be installed on the **remote** host, not the pi-web host — the bridge extension and the `serena` binary both need to be reachable where `pi` actually runs |
| Dashboard stats look stale | Each `pi` process runs its own `serena start-mcp-server` (stdio-per-process); reaping/respawning a chat's process starts a fresh Serena instance with fresh in-memory stats — call counts don't persist across a respawn |

## 8. Uninstall / disable

Remove the extension so pi stops spawning Serena:

```sh
rm ~/.pi/agent/extensions/serena.ext.ts
```

Existing `.serena/cache/` indexes are harmless to leave in place — they're
just cache, safe to delete per-project if you want to reclaim the space.
