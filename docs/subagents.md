# Setting up pi-mono's sub-agent extension

Cookbook for getting pi-web's sub-agent UI (live monitoring + the agent
manager dialog) working end to end with pi-mono's example `subagent`
extension and its 4 default agents (scout, planner, reviewer, worker).

Run all of this on the machine where `pi` actually executes — that's the
same machine you passed to `--cwd` normally, or the `--ssh` remote host if
pi-web is running in relay mode. It has nothing to do with where pi-web's
own server/frontend are built or run.

## 1. Install pi itself

```sh
npm install -g @earendil-works/pi-coding-agent
pi --version   # sanity check
```

Log in once so pi has model credentials — either run `pi` and use
`/login`, or use pi-web's "connect model" button in the sidebar later
(see step 5).

## 2. Install the subagent extension and its 4 default agents

```sh
git clone https://github.com/badlogic/pi-mono.git
cd pi-mono

mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" \
  ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" \
  ~/.pi/agent/extensions/subagent/agents.ts

mkdir -p ~/.pi/agent/agents
cp packages/coding-agent/examples/extensions/subagent/agents/*.md ~/.pi/agent/agents/
```

This gives you `scout.md`, `planner.md`, `reviewer.md`, `worker.md` in
`~/.pi/agent/agents/`. The extension is symlinked deliberately (it's
code, not something you'd edit from pi-web); the agent `.md` files are
**copied**, not symlinked, so that editing an agent through pi-web's
agent manager dialog writes into your `~/.pi` config instead of into the
pi-mono checkout.

## 3. Build and run pi-web

From a checkout of this repo:

```sh
cd web && npm install && npm run build
cd ../server && cargo run --release -- --cwd /path/to/a/project/you/want/to/chat-with
```

Open `http://127.0.0.1:3210`.

## 4. Verify the extension loaded

Click the people icon in the header (top right) — you should see all
four agents listed under "User agents." If the list is empty, pi didn't
pick up the extension symlink; double-check
`~/.pi/agent/extensions/subagent/index.ts` resolves, then restart
pi-web (or just reconnect the project) so it respawns the `pi` process.

## 5. Connect a model, if you haven't already

Use the "connect model" button in the sidebar (pi-web's built-in
`/login` flow), or run `pi` directly once and use `/login`. Not
supported over `--ssh` relay mode — see the main README's "Provider
connect" notes.

## 6. Try it

In the chat, prompt something like:

> Use the subagent tool to have scout survey this repo's structure.

You should see a live card stream in with scout's status, model
(`claude-haiku-4-5`), running token/cost counts, and its final output.
Try a parallel dispatch too:

> Dispatch scout and reviewer in parallel to look over this codebase.

## Notes

- **`--ssh` relay mode**: do steps 1–2 on the remote host pi actually
  execs on, not the machine running the pi-web server — the agent files
  need to live wherever `pi` runs, and pi-web's `/api/agents` reads and
  writes them there over SSH automatically.
- **Reasoning level**: pi-mono's example extension has no dedicated
  "thinking" frontmatter field, so pi-web's agent editor encodes it as a
  `model:<level>` suffix (e.g. `claude-sonnet-4-5:high`), which the
  extension forwards straight to pi's `--model` flag. This only applies
  to this specific extension — a different/custom sub-agent extension
  with its own reasoning field may need manual editing instead (see the
  raw-editor fallback in the agent manager dialog).
- **A different or custom extension**: pi-web's detection is heuristic
  and doesn't require pi-mono's extension specifically — any tool
  result whose `details.results` is an array of `{ agent, model, usage,
  exitCode, ... }` objects renders the same way. See `CLAUDE.md`'s
  "Sub-agent support" section for the exact shape.
