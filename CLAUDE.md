# CLAUDE.md

This file provides guidance when working with code in this repository.

## What this is

`opencodeharness`: A minimal dark-themed Vue 3 frontend harness for **OpenCode V2**.

- `web/` — Vue 3 + Vite frontend (plain JS, no TypeScript). Communicates directly with OpenCode V2 HTTP REST & Event (SSE) API (`/api/*`).

## Development Commands

```sh
cd web && npm install
npm run dev     # Starts Vite dev server on http://localhost:5173
npm run build   # Production build to web/dist/
```

Vite proxies `/api` requests to `http://127.0.0.1:4096` by default (the standard OpenCode V2 server port).

See `docs/opencode-api.md` before touching any request/response shape in
`opencode.js`/`projects.js`. The live target server's own `/doc` (OpenAPI,
served by `opencode serve` itself) is the only source of truth for field
shapes — never a packaged SDK or hosted docs page, both of which can drift
from the server you're actually pointed at. The doc has the endpoint index
of what's already wired up and a known gotcha to re-verify against `/doc`.

## Architecture

- `opencode.js`: Reactive store for OpenCode V2 API surface (`/api/session`, `/api/prompt`, `/api/event`, `/api/model`, `/api/agent`).
- `projects.js`: Reactive store managing OpenCode sessions and active selection.
- `coder.js`: Integration for managing Coder cloud workspaces.
