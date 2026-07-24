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
`opencode.js`/`projects.js` — it documents which of the SDK's several
similarly-named "Session" types is actually the one this frontend's
`/api`-prefixed calls return (they are not interchangeable), how to pull the
authoritative schema locally (the hosted API docs 403 from this
environment), and an endpoint index of what's already wired up.

## Architecture

- `opencode.js`: Reactive store for OpenCode V2 API surface (`/api/session`, `/api/prompt`, `/api/event`, `/api/model`, `/api/agent`).
- `projects.js`: Reactive store managing OpenCode sessions and active selection.
- `coder.js`: Integration for managing Coder cloud workspaces.
