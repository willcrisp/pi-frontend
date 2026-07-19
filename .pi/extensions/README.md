# Custom pi extensions

Project-local extensions for the `pi` coding agent, auto-loaded from
`.pi/extensions/*.ts` whenever `pi` runs with this repo as its `--cwd`
(the server's default). See pi's own docs for the extension API:
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md

Untested against a real `pi` build — this environment doesn't have the
`pi` binary installed. Try it with `pi -e ./.pi/extensions/mode-system-prompt.ts`
(or just run the server normally, since it auto-loads) and fix up anything
that doesn't match the actual API.

## mode-system-prompt.ts

Adds a `/mode` command (`build`, `plan`, or `none`) that silently appends a
mode-specific system prompt to every turn via `before_agent_start`, until you
switch modes again. Selection persists across a session restart through a
custom `mode-selection` entry (`pi.appendEntry`).

- `/mode build` — implement changes directly.
- `/mode plan` — research only, no edits, propose a plan.
- `/mode none` (or `/mode`) — clear it.
