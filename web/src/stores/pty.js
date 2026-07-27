// One-shot remote command execution via the OpenCode V2 PTY API.
// Callers get back the captured output of one command; the PTY is torn down after.
//
// Verified against a live server's openapi.json + the upstream handler source:
//   POST /api/pty                     -> { location, data: { id, status, pid, ... } }
//   POST /api/pty/{id}/connect-token  -> { data: { ticket, expires_in } }
//        requires header `x-opencode-ticket: 1` and a same-origin request, else
//        403 "Invalid PTY connect token request".
//   GET  /api/pty/{id}/connect?ticket=…  (WebSocket upgrade)
//        A valid ticket bypasses Basic Auth, so no credentials go on the URL.
//
// Wire protocol (PtyProtocol): outbound frames are raw UTF-8 terminal text; one
// binary control frame — 0x00 followed by JSON {cursor} — marks the end of replay.
//
// Why a shell session instead of running the command as the PTY process: connect
// rejects any PTY whose status is not "running" (close code 4404 "session exited"),
// and a command like `git branch` exits in milliseconds — far faster than the
// create -> token -> upgrade round-trip, so it is never attachable. Instead the PTY
// runs an interactive `sh`, which stays alive, and the command is written to its
// stdin bracketed by sentinel markers that delimit the real output.
import { apiBase, authHeaders } from "./ssh.js";

const TICKET_HEADER = "x-opencode-ticket";

function wsUrl(path) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${apiBase()}${path}`;
}

// PTY output is a terminal stream: it carries the echoed input line, the shell
// prompt, ANSI/OSC escape sequences and \r line endings. Strip the escapes and
// control bytes so line-based parsing sees real text.
export function cleanPtyOutput(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (title set etc.)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (colors, cursor moves)
    .replace(/\x1b[()#][0-~]/g, "") // charset selection (ESC ( B …)
    .replace(/\x1b[0-~]/g, "") // any remaining two-byte escape, incl. keypad ESC = / ESC >
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function shellQuote(token) {
  return `'${String(token).replace(/'/g, `'\\''`)}'`;
}

// No `location` query is sent on any PTY call: create resolves to the server's
// default location, and connect must address that same instance for the ticket
// scope to match. The process's working directory comes from `cwd`.
export async function runCommand(cwd, command, args = [], { timeoutMs = 15000 } = {}) {
  const createRes = await fetch(`${apiBase()}/pty`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      command: "sh",
      args: [],
      cwd,
      title: `harness: ${command} ${args.join(" ")}`.trim(),
    }),
  });
  if (!createRes.ok) {
    throw new Error(`pty create failed (${createRes.status}): ${command} ${args.join(" ")}`);
  }
  const created = await createRes.json();
  const ptyId = created?.data?.id ?? created?.id;
  if (!ptyId) throw new Error("pty create response had no id");

  try {
    return await runInShell(ptyId, command, args, timeoutMs);
  } finally {
    fetch(`${apiBase()}/pty/${ptyId}`, { method: "DELETE", headers: authHeaders() }).catch(() => {});
  }
}

async function runInShell(ptyId, command, args, timeoutMs) {
  const tokenRes = await fetch(`${apiBase()}/pty/${ptyId}/connect-token`, {
    method: "POST",
    headers: { ...authHeaders(), [TICKET_HEADER]: "1" },
  });
  if (!tokenRes.ok) throw new Error(`pty connect-token failed (${tokenRes.status})`);
  const tokenBody = await tokenRes.json();
  const ticket = tokenBody?.data?.ticket ?? tokenBody?.ticket;
  if (!ticket) throw new Error("pty connect-token response had no ticket");

  // The terminal echoes the line we send, so the markers must not appear literally
  // in it — `printf '__OC%sS__' _` echoes as `__OC%sS__` but prints `__OC_S__`.
  const nonce = Math.random().toString(36).slice(2, 10);
  const startMarker = `__OC_S${nonce}__`;
  const endMarker = `__OC_E${nonce}__`;
  const cmdLine = [command, ...args].map(shellQuote).join(" ");
  // `stty -echo` and the empty prompts keep the shell's own echo and PS1/PS2 out of
  // the captured region; without them the output carries stray prompt characters.
  const input =
    `stty -echo 2>/dev/null; PS1=''; PS2=''; ` +
    `printf '\\n__OC%sS${nonce}__\\n' _; ${cmdLine}; printf '\\n__OC%sE${nonce}__\\n' _\n`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(`/pty/${ptyId}/connect?ticket=${encodeURIComponent(ticket)}`));
    ws.binaryType = "arraybuffer";
    let buffer = "";
    let settled = false;

    const timer = setTimeout(
      () => finish(new Error(`pty command timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve(value);
    }

    function checkComplete() {
      const clean = cleanPtyOutput(buffer);
      const start = clean.indexOf(startMarker);
      if (start === -1) return;
      const end = clean.indexOf(endMarker, start + startMarker.length);
      if (end === -1) return;
      finish(null, clean.slice(start + startMarker.length, end).replace(/\r/g, ""));
    }

    ws.onopen = () => ws.send(input);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        buffer += ev.data;
      } else {
        const bytes = new Uint8Array(ev.data);
        if (bytes[0] === 0) return; // control frame: end-of-replay cursor
        buffer += new TextDecoder().decode(bytes);
      }
      checkComplete();
    };
    ws.onerror = () => finish(new Error("pty websocket error"));
    ws.onclose = (ev) =>
      finish(
        new Error(
          ev.code === 4404
            ? "pty session exited before it could be attached"
            : `pty websocket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}) before the command finished`
        )
      );
  });
}
