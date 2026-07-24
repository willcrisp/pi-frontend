# OpenCode V2 Web Harness

A sleek, minimal Vue 3 web frontend harness for **OpenCode V2** (`opencode`).

Connects directly to the OpenCode V2 HTTP REST & Event (SSE) API without requiring any intermediate custom server.

## Features

- **Direct OpenCode Integration**: Communicates directly with `opencode serve` (`http://localhost:4096` by default).
- **Real-Time Streaming**: Uses Server-Sent Events (`/api/event`) for streaming assistant output and status updates.
- **Session Management**: List, create, and delete OpenCode sessions seamlessly from the sidebar.
- **Model & Agent Selection**: Choose active LLM models and built-in agents from OpenCode V2 dynamically.
- **Coder & Cloud Workspaces**: Supports connecting to remote OpenCode V2 instances running inside Coder cloud workspaces or over SSH port forwarding (`ssh -L 4096:localhost:4096 user@remote-host`).

## Development & Build

### Prerequisites
- Node.js (v18+)
- Running instance of `opencode serve` (or remote OpenCode V2 endpoint)

### Run Locally (Dev loop)

```sh
cd web
npm install
npm run dev
```

Open http://localhost:5173.

### Build Production Bundle

```sh
cd web
npm run build
```

The output will be in `web/dist/`.
