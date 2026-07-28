# radius

A sleek, minimal Vue 3 web frontend harness for **OpenCode V2**.

Connects directly to the OpenCode V2 HTTP REST & Event (SSE) API — there is no
intermediate server of our own.

## Features

- **Direct OpenCode integration** — talks to `opencode2 serve`
  (`http://127.0.0.1:4096` by default) over its REST API, with basic auth.
- **Real-time streaming** — Server-Sent Events (`/api/event`) drive assistant
  output, tool calls and status, with a per-chat activity dot in the sidebar
  that tracks *every* session, not just the one on screen.
- **Steering** — send a prompt into a run that is already going and the agent
  picks it up at its next turn, without interrupting the tool it is mid-way
  through.
- **Sub-agent sessions** — a `subagent` tool call is rendered as an expandable
  card with the child's own live transcript, and can be drilled into.
- **Permission & question gating** — approval prompts and structured
  mid-execution questions are queued and answered from the UI.
- **Model & agent selection** — models grouped by provider and ranked by tier,
  reasoning-effort variants, and agent switching, all read from the server.
- **Composer conveniences** — file attachments by paste, drag-and-drop or
  picker, image markup, `/` for commands and skills, `@` for project file paths.
- **Remote servers** — reached by tunnelling to a local port, e.g.
  `ssh -L 5000:localhost:4096 user@remote-host`, then pointing the connect
  dialog at that port.

## Getting started

### Prerequisites

- Node.js v18+
- An OpenCode V2 server:

  ```sh
  npm install -g opencode-ai@next   # ships the `opencode2` binary
  opencode2 serve --hostname 127.0.0.1 --port 4096
  opencode2 service password        # the basic-auth password to enter in the UI
  ```

### Run

```sh
npm install
npm run dev
```

Open http://localhost:5173 and set the port and password in the connect dialog.

### Build

```sh
npm run build     # output in dist/
```

### Test

```sh
npx playwright install chromium   # first run only
npm test
```

Playwright drives the composer against a mock OpenCode server that the test
config starts for you — no running `opencode2` needed.

## Project layout

```
src/
  stores/          reactive() singletons (no Pinia), imported directly
    opencode.js    facade re-exporting the OpenCode V2 client
    opencode/      that client, split by concern (events, messages, steering…)
  composables/     the composer's parts (attachments, autocomplete, autosize…)
  components/      chat/, dialogs/, popovers/, sidebar/
  lib/             api.js and storage.js, plus hand-rolled markdown/diff/fuzzy
  styles/          one CSS partial per feature, imported in order by style.css
docs/              API ground truth and sub-agent notes — see docs/opencode-api.md
```

Two conventions worth knowing before changing anything:

- **Every server call goes through `lib/api.js`.** It applies the dev-proxy
  prefix and the auth header, both of which fail at runtime only if omitted.
- **The CSS import order in `style.css` is load-bearing** — the rules are a flat
  global cascade, so ties resolve by source order.

`CLAUDE.md` has the full architecture notes and the API gotchas.
