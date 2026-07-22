//! Bridge between `pi --mode rpc` child processes (one per *chat* — a
//! project working directory plus one conversation) and browser clients.
//!
//! pi speaks newline-delimited JSON on stdin/stdout. For each chat this
//! server pipes those lines verbatim to/from WebSocket clients at
//! `/ws/{projectId}?chat={chatId}` — it does not parse the protocol, so it
//! stays compatible as pi evolves. Two deliberate exceptions, both
//! read-only peeks at pi's stdout: right after spawning a pi process, it
//! sends a `get_session_stats` probe and peeks at the `sessionFile` field
//! of the response to learn where pi is writing that project's session
//! history (so it can list past chats without knowing pi's
//! session-directory naming scheme); and it watches for
//! `agent_start`/`agent_settled` events to know whether a process is
//! mid-run, so the idle sweeper below never kills a working agent.
//!
//! Chats run concurrently: every chat keeps its own pi process alive in
//! the background, so an agent keeps working while a different chat — or a
//! different project — is in view. `chatId` is an opaque client-chosen
//! token; the frontend maps it to a pi session (pi.js sends
//! `switch_session` itself after connecting when it wants a specific past
//! session). Because processes are now per chat rather than per project,
//! a process with no connected clients that hasn't run anything for a
//! while is reaped (see `IDLE_REAP_SECS`) and transparently respawned on
//! the next connect. Projects are added/removed via the `/api/projects`
//! REST endpoints and persisted to `<data-dir>/projects.json`.
//!
//! When an SSH target is set (via `--ssh user@host` at first boot, or
//! afterwards through the `/api/ssh` endpoints and the frontend's popup on
//! the connection dot), every project's pi process is spawned on that
//! remote host over SSH instead of locally (see `spawn_child`) — this is
//! how the Railway/Tailscale thin-client setup in the README works. Project
//! paths are then remote paths, so local filesystem checks (path
//! validation on add, chat-history discovery) are skipped/degrade
//! gracefully rather than erroring.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc, Mutex, RwLock},
};
use axum::http::{header, Uri};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

/// Timestamped stderr logging (`eprintln!` gives no indication of *when*
/// something happened, which makes diagnosing "why did this take ages"
/// reports impossible after the fact). Millisecond-resolution wall clock,
/// not monotonic `Instant`, since these lines are read by a human against
/// real time.
macro_rules! log {
    ($($arg:tt)*) => {{
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let secs = now.as_secs();
        let millis = now.subsec_millis();
        let t = secs % 86400;
        eprintln!("[{:02}:{:02}:{:02}.{:03}] {}", t / 3600, (t / 60) % 60, t % 60, millis, format!($($arg)*));
    }};
}

/// The built frontend (`web/dist`), embedded into the binary at compile
/// time so the server needs no files from the source tree at runtime.
/// `--web-dir DIR` overrides this with a live directory for the dev loop.
#[derive(rust_embed::Embed)]
#[folder = "../web/dist"]
struct WebAssets;

/// The bundled login helper script, embedded into the binary so it doesn't
/// need to exist on disk relative to the source tree; `--login-helper PATH`
/// overrides this with a real on-disk file.
const LOGIN_HELPER_SRC: &str = include_str!("../pi-login/login-helper.mjs");

/// Persisted project metadata (`<data-dir>/projects.json`).
#[derive(Clone, Serialize, Deserialize)]
struct ProjectRecord {
    id: String,
    name: String,
    path: PathBuf,
}

/// In-memory project metadata, including the lazily-learned session directory.
struct ProjectEntry {
    name: String,
    path: PathBuf,
    session_dir: Mutex<Option<PathBuf>>,
}

/// The chat id used when a client connects without `?chat=` (and for the
/// warm-up process spawned per project at boot, whose probe response teaches
/// us the project's session dir before any client shows up).
const DEFAULT_CHAT: &str = "default";

/// A pi process with no WebSocket clients that hasn't started/finished an
/// agent run for this long is killed by the sweeper; the next connect to its
/// chat respawns one. Keeps per-chat processes from accumulating forever.
const IDLE_REAP_SECS: u64 = 300;

/// A live pi process for one chat. `streaming` is peeked from pi's own
/// `agent_start`/`agent_settled` events; together with `clients` and
/// `idle_since` it drives the idle sweeper — a process is only ever reaped
/// when nothing is connected to it *and* no agent run is in flight.
struct RunningProcess {
    to_pi: mpsc::Sender<String>,
    from_pi: broadcast::Sender<String>,
    kill_tx: mpsc::Sender<()>,
    clients: AtomicUsize,
    streaming: AtomicBool,
    idle_since: std::sync::Mutex<Instant>,
}

/// Key into `AppState.running` for one chat's process. Project ids are
/// UUIDs (never contain `/`), so the prefix `{projectId}/` is unambiguous.
fn chat_key(project_id: &str, chat_id: &str) -> String {
    format!("{project_id}/{chat_id}")
}

struct Config {
    port: u16,
    cwd: PathBuf,
    pi_bin: String,
    coder_bin: String,
    web_dir: Option<PathBuf>,
    data_dir: PathBuf,
    login_helper: Option<PathBuf>,
    pi_args: Vec<String>,
    ssh_host: Option<String>,
    ssh_identity: Option<String>,
    ssh_port: Option<u16>,
}

/// Runtime-editable SSH target (`<data-dir>/ssh.json`), applied to every
/// project's spawned pi process. `identity` is a path to a key file that
/// must already exist on the machine running the server — no secret
/// material is ever stored here. `--ssh`/`--ssh-identity`/`--ssh-port` only
/// seed this on the very first run (no persisted `ssh.json` yet); after
/// that, it's edited at runtime via `/api/ssh`.
#[derive(Clone, Serialize, Deserialize, Default)]
struct SshConfig {
    host: Option<String>,
    identity: Option<String>,
    port: Option<u16>,
}

struct AppState {
    cfg: Config,
    projects: RwLock<HashMap<String, Arc<ProjectEntry>>>,
    /// Live pi processes, keyed by `chat_key(projectId, chatId)` — one per
    /// chat, so agents in different chats of the same project run
    /// concurrently and switching chats never disturbs a running one.
    running: RwLock<HashMap<String, Arc<RunningProcess>>>,
    ssh: RwLock<SshConfig>,
}

/// The current user's home directory (`$HOME`, or `%USERPROFILE%` on
/// Windows), if the environment provides one. `None` when it doesn't (rare,
/// but callers should degrade gracefully rather than panic — see
/// `default_data_dir` and `resolve_agents_dir`'s user scope).
fn home_dir() -> Option<PathBuf> {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(home_var).ok().map(PathBuf::from)
}

fn default_data_dir() -> PathBuf {
    match home_dir() {
        Some(home) => home.join(".pi-web"),
        None => PathBuf::from(".pi-web"),
    }
}

fn parse_args() -> Config {
    let mut cfg = Config {
        port: 3210,
        cwd: PathBuf::from("."),
        pi_bin: "pi".into(),
        coder_bin: "coder".into(),
        web_dir: None,
        data_dir: default_data_dir(),
        login_helper: None,
        pi_args: Vec::new(),
        ssh_host: None,
        ssh_identity: None,
        ssh_port: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => cfg.port = args.next().expect("--port needs a value").parse().expect("invalid port"),
            "--cwd" => cfg.cwd = args.next().expect("--cwd needs a value").into(),
            "--pi-bin" => cfg.pi_bin = args.next().expect("--pi-bin needs a value"),
            "--coder-bin" => cfg.coder_bin = args.next().expect("--coder-bin needs a value"),
            "--web-dir" => cfg.web_dir = Some(args.next().expect("--web-dir needs a value").into()),
            "--login-helper" => cfg.login_helper = Some(args.next().expect("--login-helper needs a value").into()),
            "--data-dir" => cfg.data_dir = args.next().expect("--data-dir needs a value").into(),
            "--ssh" => cfg.ssh_host = Some(args.next().expect("--ssh needs a value (user@host)")),
            "--ssh-identity" => cfg.ssh_identity = Some(args.next().expect("--ssh-identity needs a value")),
            "--ssh-port" => cfg.ssh_port = Some(args.next().expect("--ssh-port needs a value").parse().expect("invalid ssh port")),
            "--" => {
                cfg.pi_args = args.collect();
                break;
            }
            other => {
                eprintln!("unknown argument: {other}");
                eprintln!(
                    "usage: pi-web-server [--port N] [--cwd DIR] [--pi-bin PATH] [--coder-bin PATH] [--web-dir DIR] [--data-dir DIR] \
                     [--ssh user@host [--ssh-identity PATH] [--ssh-port N]] [-- <extra pi args>]"
                );
                std::process::exit(2);
            }
        }
    }
    cfg
}

/// Single-quotes a string for safe inclusion in a POSIX shell command line.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[tokio::main]
async fn main() {
    let mut cfg = parse_args();
    let _ = tokio::fs::create_dir_all(&cfg.data_dir).await;

    // No --login-helper override: write the embedded helper script out to
    // the data dir (overwritten unconditionally so upgrades take effect)
    // and use that path, so the server needs no on-disk helper from the
    // source tree at runtime.
    if cfg.login_helper.is_none() {
        let path = cfg.data_dir.join("login-helper.mjs");
        if let Err(e) = tokio::fs::write(&path, LOGIN_HELPER_SRC).await {
            eprintln!("warning: failed to write embedded login helper to {}: {e}", path.display());
        }
        cfg.login_helper = Some(path);
    }

    // First run ever (no persisted ssh.json yet): seed from --ssh/etc, same
    // one-shot-seed treatment as --cwd below.
    let ssh_file = cfg.data_dir.join("ssh.json");
    let ssh_seed_needed = tokio::fs::metadata(&ssh_file).await.is_err();
    let ssh_cfg = load_ssh_config(&cfg).await;

    // First run ever (no persisted project list yet): seed one project from
    // --cwd so `cargo run -- --cwd path/to/project` still works out of the
    // box, matching the old single-project behavior.
    let projects_file = cfg.data_dir.join("projects.json");
    let seed_needed = tokio::fs::metadata(&projects_file).await.is_err();
    let mut records = load_projects(&cfg).await;
    if seed_needed {
        // When the SSH target is set, --cwd is a path on the remote host,
        // not this machine, so there's nothing local to canonicalize.
        let path = if ssh_cfg.host.is_some() {
            cfg.cwd.clone()
        } else {
            tokio::fs::canonicalize(&cfg.cwd).await.unwrap_or_else(|_| cfg.cwd.clone())
        };
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("project").to_string();
        records.push(ProjectRecord { id: Uuid::new_v4().to_string(), name, path });
    }

    let mut projects = HashMap::new();
    for r in records {
        projects.insert(
            r.id,
            Arc::new(ProjectEntry { name: r.name, path: r.path, session_dir: Mutex::new(None) }),
        );
    }

    let state = Arc::new(AppState {
        cfg,
        projects: RwLock::new(projects),
        running: RwLock::new(HashMap::new()),
        ssh: RwLock::new(ssh_cfg),
    });

    if seed_needed {
        persist_projects(&state).await;
    }
    if ssh_seed_needed {
        persist_ssh_config(&state).await;
    }

    // Warm up one process per project at startup. Beyond saving the first
    // visitor a pi cold-start, its get_session_stats probe response is what
    // teaches us the project's session dir, so the sidebar's chat history
    // works from the first page load. (The sweeper reaps these later if no
    // one ever connects.)
    let ids: Vec<String> = state.projects.read().await.keys().cloned().collect();
    for id in ids {
        ensure_running(&state, &id, DEFAULT_CHAT).await;
    }

    // Idle sweeper: with one process per chat (not per project), every chat
    // ever opened would otherwise keep a pi process alive until the server
    // exits. Reap processes that have no connected clients and no agent run
    // in flight — an agent that was left working in a closed tab still runs
    // to completion (its session file is written), and only then becomes
    // eligible.
    let sweeper_state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let doomed: Vec<(String, Arc<RunningProcess>)> = sweeper_state
                .running
                .read()
                .await
                .iter()
                .filter(|(_, p)| {
                    p.clients.load(Ordering::Relaxed) == 0
                        && !p.streaming.load(Ordering::Relaxed)
                        && p.idle_since.lock().unwrap().elapsed().as_secs() >= IDLE_REAP_SECS
                })
                .map(|(k, p)| (k.clone(), p.clone()))
                .collect();
            for (key, p) in doomed {
                log!("reaping idle pi process for chat {key}");
                let _ = p.kill_tx.try_send(());
            }
        }
    });

    let port = state.cfg.port;
    let web_dir = state.cfg.web_dir.clone();

    let app = Router::new()
        .route("/api/projects", get(list_projects).post(add_project))
        .route("/api/projects/{id}", delete(remove_project))
        .route("/api/projects/{id}/sessions", get(list_sessions))
        .route("/api/projects/{id}/search", get(search_sessions))
        .route("/api/agents", get(list_agents).put(save_agent).delete(delete_agent))
        .route("/api/export", get(export_file))
        .route("/api/browse-dirs", get(browse_dirs))
        .route("/api/ssh", get(get_ssh_config).put(save_ssh_config).delete(clear_ssh_config))
        .route("/api/ssh/test", post(test_ssh_config))
        .route("/api/coder/workspaces", get(list_coder_workspaces))
        .route("/api/coder/start", post(start_coder_workspace))
        .route("/api/coder/stop", post(stop_coder_workspace))
        .route("/api/projects/{id}/git/branches", get(list_git_branches))
        .route("/api/projects/{id}/git/checkout", post(checkout_git_branch))
        .route("/ws/{id}", get(ws_handler))
        .route("/ws-auth", get(ws_auth_handler));

    let app = match web_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            app.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(index)))
        }
        None => app.fallback(serve_embedded_asset),
    }
    .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind failed");
    eprintln!("pi-web listening on http://{addr}");
    axum::serve(listener, app).await.unwrap();
}

/// Fallback handler serving the frontend from the embedded `WebAssets`
/// (`web/dist`, baked into the binary at compile time) when no `--web-dir`
/// override is set. SPA fallback: any path that isn't a known asset (or is
/// empty) serves `index.html`.
async fn serve_embedded_asset(uri: Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/');
    let mut asset = if path.is_empty() { None } else { WebAssets::get(path) };
    if asset.is_none() {
        path = "index.html";
        asset = WebAssets::get(path);
    }
    match asset {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.as_ref().to_string())],
                file.data.into_owned(),
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Query string for `GET /api/export` — `path` is the absolute location pi's
/// `export_html` RPC wrote the HTML to, on whichever machine runs pi (local,
/// or the remote host in `--ssh` mode).
#[derive(Deserialize)]
struct ExportQuery {
    path: String,
}

/// Serves an exported-session HTML file for download. pi's `export_html`
/// command writes the file on the machine that runs pi and returns only its
/// path over RPC — the content never crosses the wire — so a browser can't
/// open it directly. This reads that file (locally, or over SSH like the
/// agent-file ops) and streams it back as a downloadable attachment, which is
/// what lets the `/export` slash command hand the user a real download link.
/// Restricted to `.html` files so it can't double as an arbitrary-file-read
/// endpoint (the server binds to 127.0.0.1, but the guard is cheap).
async fn export_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<ExportQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if !q.path.to_ascii_lowercase().ends_with(".html") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let ssh = state.ssh.read().await.clone();
    let bytes = read_export_file(&ssh, &q.path).await.ok_or(StatusCode::NOT_FOUND)?;
    // Basename for the download filename; strip characters that would break
    // out of the Content-Disposition quoted string.
    let file_name = FsPath::new(&q.path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("session.html")
        .replace(['"', '\r', '\n'], "");
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file_name}\""),
            ),
        ],
        bytes,
    ))
}

/// Reads the raw bytes of an exported HTML file — locally, or over SSH on the
/// pi host, mirroring `read_agent_file`'s local/remote duality. `None` on any
/// failure (missing, unreadable, ssh error, timeout).
async fn read_export_file(ssh: &SshConfig, path: &str) -> Option<Vec<u8>> {
    if ssh.host.is_some() {
        let remote_cmd = format!("cat {}", shell_quote(path));
        let mut c = ssh_command(ssh, 8);
        c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let out = tokio::time::timeout(std::time::Duration::from_secs(15), c.output()).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        Some(out.stdout)
    } else {
        tokio::fs::read(path).await.ok()
    }
}

// ---- process lifecycle -----------------------------------------------

/// Spawns pi for one project's `cwd` — locally, or over SSH on `ssh.host`
/// if set (in which case `cwd` is a path on the remote host, and every
/// project shares that one remote host).
fn spawn_child(cfg: &Config, ssh: &SshConfig, cwd: &FsPath) -> tokio::process::Child {
    if let Some(ssh_host) = &ssh.host {
        // Relay mode: exec pi on a remote box over SSH instead of spawning it
        // locally. The whole remote command is built as one shell-quoted
        // string so it survives ssh's own arg-joining unambiguously.
        //
        // The directory is checked with `cd` on its own line first, with an
        // explicit, attributable message on failure — rather than folding it
        // into `cd X && exec pi` — so a bad/relative project path reports
        // clearly as "pi-web: project directory not found" instead of a bare
        // `cd: ...: No such file or directory` that's easy to mistake for
        // something pi itself printed. pi is only ever exec'd once that cd
        // has actually succeeded.
        let quoted_cwd = shell_quote(cwd.to_str().expect("project path must be valid UTF-8"));
        let mut remote_cmd = format!(
            "cd {quoted_cwd} || {{ echo \"pi-web: project directory not found: {quoted_cwd}\" >&2; exit 1; }}; exec {} --mode rpc",
            shell_quote(&cfg.pi_bin)
        );
        for a in &cfg.pi_args {
            remote_cmd.push(' ');
            remote_cmd.push_str(&shell_quote(a));
        }

        let mut c = Command::new("ssh");
        c.arg("-o").arg("BatchMode=yes")
            .arg("-o").arg("StrictHostKeyChecking=accept-new")
            .arg("-o").arg("ServerAliveInterval=30")
            .arg("-o").arg("ServerAliveCountMax=3");
        if let Some(identity) = &ssh.identity {
            c.arg("-i").arg(identity);
        }
        if let Some(port) = ssh.port {
            c.arg("-p").arg(port.to_string());
        }
        c.arg(ssh_host)
            .arg(remote_cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn ssh — is it on PATH?")
    } else {
        // Windows installs pi as a .cmd shim, which can only be spawned via cmd.exe.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&cfg.pi_bin);
            c
        } else {
            Command::new(&cfg.pi_bin)
        };
        cmd.arg("--mode")
            .arg("rpc")
            .args(&cfg.pi_args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.spawn().expect("failed to spawn pi — is it on PATH? (override with --pi-bin)")
    }
}

/// Spawns one chat's pi process and its bridge tasks. `key` is the
/// `chat_key` this process is stored under in `running`.
fn spawn_process(state: Arc<AppState>, key: String, entry: Arc<ProjectEntry>, ssh: SshConfig) -> Arc<RunningProcess> {
    let mut child = spawn_child(&state.cfg, &ssh, &entry.path);
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (to_pi, mut to_pi_rx) = mpsc::channel::<String>(64);
    let (from_pi, _) = broadcast::channel::<String>(1024);
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

    // Built up front (rather than at the end) so the watcher task below can
    // compare identity against it — see the Arc::ptr_eq comment there.
    let proc = Arc::new(RunningProcess {
        to_pi: to_pi.clone(),
        from_pi: from_pi.clone(),
        kill_tx,
        clients: AtomicUsize::new(0),
        streaming: AtomicBool::new(false),
        idle_since: std::sync::Mutex::new(Instant::now()),
    });

    // pi stdout -> broadcast to this chat's clients, also peeked for the
    // get_session_stats probe response and the agent_start/agent_settled
    // events that drive the idle sweeper.
    let from_pi_tx = from_pi.clone();
    let entry_for_probe = entry.clone();
    let proc_for_stdout = proc.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                learn_session_dir(&entry_for_probe, &v).await;
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("agent_start") => proc_for_stdout.streaming.store(true, Ordering::Relaxed),
                    Some("agent_settled") => {
                        proc_for_stdout.streaming.store(false, Ordering::Relaxed);
                        *proc_for_stdout.idle_since.lock().unwrap() = Instant::now();
                    }
                    _ => {}
                }
            }
            let _ = from_pi_tx.send(line);
        }
    });

    // pi/ssh stderr -> server console (as before) plus a capped tail kept
    // around so a failing exit can report *why* (version mismatch, bad cwd,
    // crash) instead of just an opaque exit code.
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let id_for_stderr = key.clone();
    let stderr_tail_writer = stderr_tail.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[{id_for_stderr}] {line}");
            let mut tail = stderr_tail_writer.lock().await;
            tail.push(line);
            if tail.len() > 30 {
                tail.remove(0);
            }
        }
    });

    // client messages -> pi stdin
    tokio::spawn(async move {
        while let Some(line) = to_pi_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    // Learn where this project's sessions live without guessing pi's
    // directory-hashing scheme.
    let _ = to_pi.try_send(r#"{"type":"get_session_stats"}"#.to_string());

    // Own the child exclusively: either it exits on its own, or someone
    // asks us to kill it. Either way, drop this chat out of `running` —
    // but only if `running` still points at *this* process. A respawn (e.g.
    // from an SSH config change) inserts the new process under the same key
    // before killing this one, so by the time this task's kill/wait
    // resolves, the map may already hold a newer, unrelated process for
    // `id_for_exit`; removing unconditionally would leak that one.
    let id_for_exit = key.clone();
    let proc_for_exit = proc.clone();
    let from_pi_tx_exit = from_pi.clone();
    tokio::spawn(async move {
        let mut killed = false;
        tokio::select! {
            status = child.wait() => {
                log!("pi exited for chat {id_for_exit}: {status:?}");
                // A clean exit (status 0) is a normal shutdown, not an error worth
                // surfacing — e.g. pi quitting on its own. Anything else (nonzero
                // exit, or the process never even started) gets reported to the
                // browser as a synthetic frame; this is the one place besides the
                // get_session_stats probe where the server injects its own JSON
                // into the otherwise-untouched pi<->browser stream, since there is
                // no other way for a spawn/crash failure to reach the UI.
                let failed = !matches!(&status, Ok(s) if s.success());
                if failed {
                    let tail = stderr_tail.lock().await.join("\n");
                    let message = if tail.is_empty() {
                        "pi process exited unexpectedly (no output on stderr)".to_string()
                    } else {
                        tail
                    };
                    let exit_code = status.ok().and_then(|s| s.code());
                    let ev = serde_json::json!({
                        "type": "pi_web_process_error",
                        "message": message,
                        "exitCode": exit_code,
                    });
                    let _ = from_pi_tx_exit.send(ev.to_string());
                }
            }
            _ = kill_rx.recv() => {
                killed = true;
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        let _ = killed; // intentional kills (respawn/removal) never report an error
        let mut running = state.running.write().await;
        if let Some(current) = running.get(&id_for_exit) {
            if Arc::ptr_eq(current, &proc_for_exit) {
                running.remove(&id_for_exit);
            }
        }
    });

    proc
}

/// Returns the running process for one chat, spawning (or respawning, if
/// it previously died or was reaped) one on demand. `None` only if
/// `project_id` isn't a known project at all.
/// Returns the chat's process plus whether this call had to spawn it fresh
/// ("cold start") vs finding one already warm — `ws_handler` forwards that
/// flag to the browser as a `pi_web_status` frame so the UI can tell "this is
/// slow because a new agent process is booting" apart from "the connection
/// merely hasn't responded yet" instead of leaving the user guessing.
async fn ensure_running(state: &Arc<AppState>, project_id: &str, chat_id: &str) -> Option<(Arc<RunningProcess>, bool)> {
    let key = chat_key(project_id, chat_id);
    if let Some(p) = state.running.read().await.get(&key) {
        return Some((p.clone(), false));
    }
    let entry = state.projects.read().await.get(project_id)?.clone();
    let ssh = state.ssh.read().await.clone();
    let mut running = state.running.write().await;
    if let Some(p) = running.get(&key) {
        return Some((p.clone(), false));
    }
    log!("[{key}] no running process — cold-starting pi (this is what makes the first open of a chat slow)");
    let start = Instant::now();
    let proc = spawn_process(state.clone(), key.clone(), entry, ssh);
    log!("[{key}] spawn_process returned after {:?} (process is spawned but may still be starting up before it responds on stdout)", start.elapsed());
    running.insert(key, proc.clone());
    Some((proc, true))
}

/// Kills and respawns one chat's pi process against the current SSH
/// target, inserting the new process into `running` before signalling the
/// old one to exit — the `Arc::ptr_eq` guard in `spawn_process`'s watcher
/// task is what makes this ordering safe (see its comment).
async fn respawn_key(state: &Arc<AppState>, key: &str) {
    let Some((project_id, _)) = key.split_once('/') else { return };
    let Some(entry) = state.projects.read().await.get(project_id).cloned() else {
        // Project no longer exists; just make sure the process is gone.
        if let Some(p) = state.running.write().await.remove(key) {
            let _ = p.kill_tx.try_send(());
        }
        return;
    };
    let ssh = state.ssh.read().await.clone();
    let old = {
        let mut running = state.running.write().await;
        let old = running.remove(key);
        let new_proc = spawn_process(state.clone(), key.to_string(), entry, ssh);
        running.insert(key.to_string(), new_proc);
        old
    };
    if let Some(old) = old {
        let _ = old.kill_tx.try_send(());
    }
}

/// Respawns every running chat's pi process in place, e.g. after the SSH
/// target changes. Connected clients notice their old bridge die and
/// reconnect onto the fresh process.
async fn respawn_all(state: &Arc<AppState>) {
    let keys: Vec<String> = state.running.read().await.keys().cloned().collect();
    for key in keys {
        respawn_key(state, &key).await;
    }
}

async fn learn_session_dir(entry: &Arc<ProjectEntry>, v: &serde_json::Value) {
    if v.get("command").and_then(|c| c.as_str()) != Some("get_session_stats") {
        return;
    }
    if v.get("success").and_then(|s| s.as_bool()) != Some(true) {
        return;
    }
    let Some(session_file) = v.pointer("/data/sessionFile").and_then(|s| s.as_str()) else { return };
    let Some(dir) = FsPath::new(session_file).parent() else { return };
    let mut guard = entry.session_dir.lock().await;
    if guard.as_deref() != Some(dir) {
        *guard = Some(dir.to_path_buf());
    }
}

// ---- WebSocket bridge --------------------------------------------------

#[derive(Deserialize)]
struct WsQuery {
    /// Opaque client-chosen chat token; each distinct value gets its own pi
    /// process for the project. Absent (old clients, curl) = the project's
    /// default chat.
    chat: Option<String>,
}

async fn ws_handler(
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<WsQuery>,
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let chat = q.chat.unwrap_or_else(|| DEFAULT_CHAT.to_string());
    let start = Instant::now();
    let (proc, cold_start) = ensure_running(&state, &id, &chat).await.ok_or(StatusCode::NOT_FOUND)?;
    log!("ws connect for {id}/{chat}: ensure_running took {:?} (cold_start={cold_start})", start.elapsed());
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, proc, cold_start)))
}

async fn handle_socket(mut socket: WebSocket, proc: Arc<RunningProcess>, cold_start: bool) {
    // Synthetic frame (not part of pi's own RPC protocol, see the "protocol
    // boundary" note in CLAUDE.md — this is the one exception, same spirit as
    // pi_web_process_error below) telling the browser whether it's attaching
    // to an already-warm process or one just spawned for this connection, so
    // the UI can show "starting a new agent…" only when that's actually why
    // things are slow.
    let status = serde_json::json!({ "type": "pi_web_status", "coldStart": cold_start });
    if socket.send(Message::Text(status.to_string().into())).await.is_err() {
        return;
    }
    proc.clients.fetch_add(1, Ordering::Relaxed);
    let mut from_pi = proc.from_pi.subscribe();
    loop {
        tokio::select! {
            line = from_pi.recv() => match line {
                Ok(line) => {
                    if socket.send(Message::Text(line.into())).await.is_err() {
                        break;
                    }
                }
                // Slow client missed messages; it can re-sync via get_messages.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if proc.to_pi.send(text.to_string()).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
    // Restart the idle clock when the last client leaves so the sweeper's
    // grace period counts from disconnect, not from process spawn.
    if proc.clients.fetch_sub(1, Ordering::Relaxed) == 1 {
        *proc.idle_since.lock().unwrap() = Instant::now();
    }
}

// ---- provider connect (login) helper -----------------------------------

/// Resolves an executable name to an absolute path by scanning `$PATH`
/// (honoring `PATHEXT` on Windows). Returns the input unchanged if it's
/// already a path or can't be found.
fn find_in_path(bin: &str) -> PathBuf {
    let p = FsPath::new(bin);
    if p.is_absolute() || bin.contains('/') || bin.contains('\\') {
        return p.to_path_buf();
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    if let Ok(path) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path.split(sep) {
            for ext in &exts {
                let candidate = FsPath::new(dir).join(format!("{bin}{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    p.to_path_buf()
}

/// Given pi's launcher location, derive the bundled `node` executable, the
/// coding-agent package directory, and the `node_modules` root — the login
/// helper imports pi's own ModelRuntime, so it must run against the same
/// install. pi ships as `<dir>/node` running
/// `<dir>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` (see its
/// launcher shim), so everything hangs off the launcher's directory.
fn resolve_pi_node(pi_bin: &str) -> (PathBuf, Option<PathBuf>, Option<PathBuf>) {
    let launcher = find_in_path(pi_bin);
    let basedir = launcher.parent().map(|p| p.to_path_buf());
    let Some(basedir) = basedir else {
        return (PathBuf::from("node"), None, None);
    };
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = basedir.join(node_name);
    let node = if node.is_file() { node } else { PathBuf::from("node") };
    let node_modules = basedir.join("node_modules");
    let pkg = node_modules.join("@earendil-works").join("pi-coding-agent");
    let pkg = if pkg.is_dir() { Some(pkg) } else { None };
    let node_modules = if node_modules.is_dir() { Some(node_modules) } else { None };
    (node, pkg, node_modules)
}

async fn ws_auth_handler(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_auth_socket(socket, state))
}

/// Bridges one WebSocket client to a freshly-spawned login helper process.
/// Unlike the per-project pi bridge this is 1:1 and short-lived: the helper
/// is spawned on connect and killed when the socket closes. Connecting a
/// provider isn't supported in `--ssh` relay mode (the credential would land
/// on this machine, not the remote host that actually runs pi), so we send a
/// single error frame and close instead.
async fn handle_auth_socket(mut socket: WebSocket, state: Arc<AppState>) {
    if state.ssh.read().await.host.is_some() {
        let _ = socket
            .send(Message::Text(
                r#"{"type":"error","message":"Connecting a provider isn't supported in SSH relay mode — run `/login` on the remote host that runs pi."}"#
                    .into(),
            ))
            .await;
        return;
    }

    let (node, pkg, node_modules) = resolve_pi_node(&state.cfg.pi_bin);
    let mut cmd = Command::new(&node);
    cmd.arg(state.cfg.login_helper.as_ref().expect("login_helper resolved in main()"));
    if let Some(pkg) = &pkg {
        cmd.arg(pkg);
    }
    // If the package wasn't found next to the launcher, let Node resolve it
    // by bare name via NODE_PATH (the helper falls back to a bare import).
    if pkg.is_none() {
        if let Some(nm) = &node_modules {
            cmd.env("NODE_PATH", nm);
        }
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!(
                r#"{{"type":"error","message":"failed to start login helper: {}"}}"#,
                e.to_string().replace('"', "'")
            );
            let _ = socket.send(Message::Text(msg.into())).await;
            return;
        }
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();

    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if socket.send(Message::Text(line.into())).await.is_err() {
                        break;
                    }
                }
                _ => break, // helper exited or errored
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if stdin.write_all(text.as_bytes()).await.is_err()
                        || stdin.write_all(b"\n").await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
    let _ = child.start_kill();
}

// ---- projects REST API --------------------------------------------------

#[derive(Serialize)]
struct ProjectView {
    id: String,
    name: String,
    path: String,
}

async fn list_projects(State(state): State<Arc<AppState>>) -> Json<Vec<ProjectView>> {
    let projects = state.projects.read().await;
    let mut views: Vec<ProjectView> = projects
        .iter()
        .map(|(id, e)| ProjectView { id: id.clone(), name: e.name.clone(), path: e.path.display().to_string() })
        .collect();
    views.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Json(views)
}

#[derive(Deserialize)]
struct AddProjectReq {
    name: String,
    path: String,
}

async fn add_project(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AddProjectReq>,
) -> Result<Json<ProjectView>, (StatusCode, String)> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".into()));
    }
    if req.path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "path is required".into()));
    }
    let path = PathBuf::from(req.path.trim());
    // With an SSH target set, `path` lives on the remote host, not this
    // machine, so there's nothing local to validate — trust it and let a
    // bad path surface as a spawn/connect failure for that project instead.
    let path = if state.ssh.read().await.host.is_some() {
        path
    } else {
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|_| (StatusCode::BAD_REQUEST, "path does not exist".into()))?;
        if !meta.is_dir() {
            return Err((StatusCode::BAD_REQUEST, "path is not a directory".into()));
        }
        tokio::fs::canonicalize(&path).await.unwrap_or(path)
    };

    let id = Uuid::new_v4().to_string();
    let entry = Arc::new(ProjectEntry { name: name.clone(), path: path.clone(), session_dir: Mutex::new(None) });
    state.projects.write().await.insert(id.clone(), entry);
    persist_projects(&state).await;
    ensure_running(&state, &id, DEFAULT_CHAT).await;

    Ok(Json(ProjectView { id, name, path: path.display().to_string() }))
}

#[derive(Deserialize)]
struct BrowseDirsQuery {
    #[serde(default)]
    path: String,
}

/// Lists subdirectories for path autocomplete in the "add project" form.
/// Splits the input into an existing directory plus a partial last segment,
/// then returns child directories of that dir whose name starts with the
/// partial segment (case-insensitive) so the frontend can fuzzy-filter and
/// render suggestions as the user types. Works both locally and, via
/// `list_remote_dirs`, against an SSH target — the placeholder in the "add
/// project" form asks for an absolute path, so an empty query starts
/// browsing at `/` (root) on either side rather than some ambiguous "current
/// directory".
async fn browse_dirs(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<BrowseDirsQuery>,
) -> Json<Vec<String>> {
    let ssh = state.ssh.read().await.clone();
    let input = q.path.replace('\\', "/");
    let (dir, prefix) = match input.rfind('/') {
        Some(idx) => (&input[..=idx], &input[idx + 1..]),
        None => ("", input.as_str()),
    };

    let names = if ssh.host.is_some() {
        let remote_dir = if dir.is_empty() { "/" } else { dir };
        match list_remote_dirs(&ssh, remote_dir).await {
            Ok(names) => names,
            Err(_) => return Json(vec![]),
        }
    } else {
        let dir_path = if dir.is_empty() { PathBuf::from(".") } else { PathBuf::from(dir) };
        let mut entries = match tokio::fs::read_dir(&dir_path).await {
            Ok(rd) => rd,
            Err(_) => return Json(vec![]),
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(meta) = entry.metadata().await else { continue };
            if !meta.is_dir() {
                continue;
            }
            names.push(entry.file_name().to_string_lossy().to_string());
        }
        names
    };

    let prefix_lower = prefix.to_lowercase();
    let mut names: Vec<String> =
        names.into_iter().filter(|n| n.to_lowercase().starts_with(&prefix_lower)).collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.truncate(50);
    let full = names.into_iter().map(|n| format!("{dir}{n}")).collect();
    Json(full)
}

/// Lists child directory names of `dir` on the SSH target (bare names, no
/// trailing slash). `ls -1p | grep '/$'` is used instead of a shell glob so
/// an empty directory or one with no subdirectories degrades to no output
/// rather than a literal unglobbed `*` under `sh`'s default (non-nullglob)
/// behavior. `cd` failing (path doesn't exist / not a directory / no
/// permission) short-circuits to no output too, same as local `read_dir`
/// failing.
async fn list_remote_dirs(ssh: &SshConfig, dir: &str) -> Result<Vec<String>, String> {
    let remote_cmd = format!("cd {} 2>/dev/null && ls -1p 2>/dev/null | grep '/$'", shell_quote(dir));
    let ssh_host = ssh.host.as_ref().ok_or_else(|| "no ssh target".to_string())?;

    let mut c = Command::new("ssh");
    c.arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("ConnectTimeout=8");
    if let Some(identity) = &ssh.identity {
        c.arg("-i").arg(identity);
    }
    if let Some(port) = ssh.port {
        c.arg("-p").arg(port.to_string());
    }
    c.arg(ssh_host).arg(remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let out = match tokio::time::timeout(std::time::Duration::from_secs(8), c.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("failed to run ssh: {e}")),
        Err(_) => return Err("ssh command timed out".into()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout
        .lines()
        .filter_map(|l| l.strip_suffix('/'))
        .map(|s| s.to_string())
        .collect())
}

async fn remove_project(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> StatusCode {
    let existed = state.projects.write().await.remove(&id).is_some();
    if !existed {
        return StatusCode::NOT_FOUND;
    }
    // Kill every chat process belonging to this project.
    let prefix = format!("{id}/");
    let doomed: Vec<Arc<RunningProcess>> = {
        let mut running = state.running.write().await;
        let keys: Vec<String> = running.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        keys.into_iter().filter_map(|k| running.remove(&k)).collect()
    };
    for p in doomed {
        let _ = p.kill_tx.try_send(());
    }
    persist_projects(&state).await;
    StatusCode::NO_CONTENT
}

async fn persist_projects(state: &Arc<AppState>) {
    let records: Vec<ProjectRecord> = {
        let projects = state.projects.read().await;
        projects
            .iter()
            .map(|(id, e)| ProjectRecord { id: id.clone(), name: e.name.clone(), path: e.path.clone() })
            .collect()
    };
    let file = state.cfg.data_dir.join("projects.json");
    match serde_json::to_vec_pretty(&records) {
        Ok(json) => {
            if let Err(e) = tokio::fs::write(&file, json).await {
                eprintln!("failed to persist projects: {e}");
            }
        }
        Err(e) => eprintln!("failed to serialize projects: {e}"),
    }
}

async fn load_projects(cfg: &Config) -> Vec<ProjectRecord> {
    let file = cfg.data_dir.join("projects.json");
    match tokio::fs::read(&file).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

// ---- ssh config REST API -------------------------------------------------

async fn persist_ssh_config(state: &Arc<AppState>) {
    let cfg = state.ssh.read().await.clone();
    let file = state.cfg.data_dir.join("ssh.json");
    match serde_json::to_vec_pretty(&cfg) {
        Ok(json) => {
            if let Err(e) = tokio::fs::write(&file, json).await {
                eprintln!("failed to persist ssh config: {e}");
            }
        }
        Err(e) => eprintln!("failed to serialize ssh config: {e}"),
    }
}

/// Loads `<data-dir>/ssh.json` if present, else falls back to whatever the
/// `--ssh`/`--ssh-identity`/`--ssh-port` CLI flags provided (first-run seed
/// only, same treatment as `--cwd` seeding `projects.json`).
async fn load_ssh_config(cfg: &Config) -> SshConfig {
    let file = cfg.data_dir.join("ssh.json");
    match tokio::fs::read(&file).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => SshConfig { host: cfg.ssh_host.clone(), identity: cfg.ssh_identity.clone(), port: cfg.ssh_port },
    }
}

#[derive(Serialize)]
struct SshConfigView {
    host: Option<String>,
    identity: Option<String>,
    port: Option<u16>,
}

impl From<SshConfig> for SshConfigView {
    fn from(cfg: SshConfig) -> Self {
        SshConfigView { host: cfg.host, identity: cfg.identity, port: cfg.port }
    }
}

async fn get_ssh_config(State(state): State<Arc<AppState>>) -> Json<SshConfigView> {
    Json(state.ssh.read().await.clone().into())
}

#[derive(Deserialize)]
struct SshTestReq {
    host: String,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

#[derive(Serialize)]
struct SshTestResp {
    ok: bool,
    message: String,
    #[serde(rename = "piFound")]
    pi_found: Option<bool>,
}

/// Tests a candidate SSH target without persisting it or touching any
/// running project process. Also checks whether `pi_bin` is on the remote
/// `$PATH`, as a soft warning (not a failure — pi may be installed later).
async fn test_ssh_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SshTestReq>,
) -> Json<SshTestResp> {
    let host = req.host.trim().to_string();
    if host.is_empty() {
        return Json(SshTestResp { ok: false, message: "host is required".into(), pi_found: None });
    }
    let identity = req.identity.filter(|s| !s.trim().is_empty());

    let probe = format!(
        "command -v {} >/dev/null 2>&1 && echo PI_WEB_PI_FOUND || echo PI_WEB_PI_MISSING",
        shell_quote(&state.cfg.pi_bin)
    );
    let mut c = Command::new("ssh");
    c.arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("ConnectTimeout=6");
    if let Some(identity) = &identity {
        c.arg("-i").arg(identity);
    }
    if let Some(port) = req.port {
        c.arg("-p").arg(port.to_string());
    }
    c.arg(&host).arg(probe).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    match tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
        Err(_) => Json(SshTestResp { ok: false, message: "connection timed out".into(), pi_found: None }),
        Ok(Err(e)) => Json(SshTestResp { ok: false, message: format!("failed to run ssh: {e}"), pi_found: None }),
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let pi_found = if stdout.contains("PI_WEB_PI_FOUND") {
                Some(true)
            } else if stdout.contains("PI_WEB_PI_MISSING") {
                Some(false)
            } else {
                None
            };
            let message = match pi_found {
                Some(true) => "connected — pi found on remote PATH".to_string(),
                Some(false) => format!("connected — but `{}` not found on remote PATH", state.cfg.pi_bin),
                None => "connected".to_string(),
            };
            Json(SshTestResp { ok: true, message, pi_found })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let message = if stderr.is_empty() { "ssh connection failed".to_string() } else { stderr };
            Json(SshTestResp { ok: false, message, pi_found: None })
        }
    }
}

#[derive(Deserialize)]
struct SshSaveReq {
    host: String,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

/// Persists the new SSH target and respawns every project's pi process
/// against it.
async fn save_ssh_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SshSaveReq>,
) -> Result<Json<SshConfigView>, (StatusCode, String)> {
    let host = req.host.trim().to_string();
    if host.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "host is required".into()));
    }
    let identity = req.identity.filter(|s| !s.trim().is_empty());
    let new_cfg = SshConfig { host: Some(host), identity, port: req.port };
    *state.ssh.write().await = new_cfg.clone();
    persist_ssh_config(&state).await;
    respawn_all(&state).await;
    Ok(Json(new_cfg.into()))
}

/// Clears the SSH target (back to local execution) and respawns every
/// project's pi process locally.
async fn clear_ssh_config(State(state): State<Arc<AppState>>) -> Json<SshConfigView> {
    *state.ssh.write().await = SshConfig::default();
    persist_ssh_config(&state).await;
    respawn_all(&state).await;
    Json(SshConfig::default().into())
}

// ---- git branch REST API -------------------------------------------------
//
// Lets the frontend show/switch the git branch checked out in a project's
// working directory — locally, or on the SSH target if one is set (same
// dual-mode treatment as `spawn_child`). Read-only listing plus a plain
// `git checkout <branch>`; no fetch/pull/create is performed.

/// Runs `git <args>` in `cwd`, locally or over SSH depending on `ssh.host`.
/// Branch names are passed as separate argv entries locally, so there's no
/// local shell involved; over SSH they're individually shell-quoted before
/// being joined into the one command string ssh execs remotely.
async fn run_git(ssh: &SshConfig, cwd: &FsPath, args: &[String]) -> Result<std::process::Output, String> {
    let mut c = if let Some(ssh_host) = &ssh.host {
        let mut remote_cmd = format!("cd {} && git", shell_quote(cwd.to_str().unwrap_or_default()));
        for a in args {
            remote_cmd.push(' ');
            remote_cmd.push_str(&shell_quote(a));
        }
        let mut c = Command::new("ssh");
        c.arg("-o").arg("BatchMode=yes")
            .arg("-o").arg("StrictHostKeyChecking=accept-new")
            .arg("-o").arg("ConnectTimeout=8");
        if let Some(identity) = &ssh.identity {
            c.arg("-i").arg(identity);
        }
        if let Some(port) = ssh.port {
            c.arg("-p").arg(port.to_string());
        }
        c.arg(ssh_host).arg(remote_cmd);
        c
    } else {
        let mut c = Command::new("git");
        c.args(args).current_dir(cwd);
        c
    };
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    match tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(format!("failed to run git: {e}")),
        Err(_) => Err("git command timed out".into()),
    }
}

#[derive(Serialize)]
struct GitBranchesResp {
    current: Option<String>,
    branches: Vec<String>,
    error: Option<String>,
}

/// Lists local branches (`git branch`), most-recently-committed first is not
/// guaranteed — this mirrors plain `git branch` order — with the checked-out
/// one flagged via `current`.
async fn list_git_branches(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<GitBranchesResp>, StatusCode> {
    let entry = state.projects.read().await.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let ssh = state.ssh.read().await.clone();
    let args = vec!["branch".to_string()];
    match run_git(&ssh, &entry.path, &args).await {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut current = None;
            let mut branches = Vec::new();
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let name = if let Some(rest) = line.strip_prefix("* ") {
                    current = Some(rest.trim().to_string());
                    rest.trim()
                } else {
                    line
                };
                branches.push(name.to_string());
            }
            Ok(Json(GitBranchesResp { current, branches, error: None }))
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let error = Some(if stderr.is_empty() { "not a git repository".to_string() } else { stderr });
            Ok(Json(GitBranchesResp { current: None, branches: vec![], error }))
        }
        Err(e) => Ok(Json(GitBranchesResp { current: None, branches: vec![], error: Some(e) })),
    }
}

#[derive(Deserialize)]
struct GitCheckoutReq {
    branch: String,
}

#[derive(Serialize)]
struct GitCheckoutResp {
    ok: bool,
    current: Option<String>,
    error: Option<String>,
}

async fn checkout_git_branch(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<GitCheckoutReq>,
) -> Result<Json<GitCheckoutResp>, StatusCode> {
    let entry = state.projects.read().await.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let branch = req.branch.trim().to_string();
    if branch.is_empty() {
        return Ok(Json(GitCheckoutResp { ok: false, current: None, error: Some("branch is required".into()) }));
    }
    let ssh = state.ssh.read().await.clone();
    let args = vec!["checkout".to_string(), branch.clone()];
    match run_git(&ssh, &entry.path, &args).await {
        Ok(out) if out.status.success() => Ok(Json(GitCheckoutResp { ok: true, current: Some(branch), error: None })),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let error = Some(if stderr.is_empty() { "git checkout failed".to_string() } else { stderr });
            Ok(Json(GitCheckoutResp { ok: false, current: None, error }))
        }
        Err(e) => Ok(Json(GitCheckoutResp { ok: false, current: None, error: Some(e) })),
    }
}

// ---- coder integration REST API -----------------------------------------
//
// A thin wrapper over the local `coder` CLI so the frontend can list the
// user's cloud workspaces and start/stop them. `coder` is expected to be
// installed and already logged in (`coder login`) on the machine running
// this server — we shell out to it exactly as a human would. Independent of
// the pi bridge and of `--ssh` relay mode: these workspaces are Coder's own
// cloud machines, unrelated to where pi runs.

#[derive(Serialize)]
struct CoderWorkspace {
    /// `owner/name` — the reference accepted by `coder start`/`coder stop`.
    id: String,
    name: String,
    owner: String,
    /// Latest build status: running | stopped | starting | stopping |
    /// pending | failed | canceling | canceled | deleting | deleted.
    status: String,
    outdated: bool,
}

#[derive(Serialize)]
struct CoderListResp {
    available: bool,
    error: Option<String>,
    workspaces: Vec<CoderWorkspace>,
}

/// Builds a `coder` command with the given args. `coder` ships as a single
/// executable (`coder.exe` on Windows), so it's spawned directly rather than
/// through a shell shim like pi.
fn coder_command(cfg: &Config, args: &[&str]) -> Command {
    let mut c = Command::new(&cfg.coder_bin);
    c.args(args);
    c
}

async fn list_coder_workspaces(State(state): State<Arc<AppState>>) -> Json<CoderListResp> {
    let mut c = coder_command(&state.cfg, &["list", "--all", "--output", "json"]);
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let out = match tokio::time::timeout(std::time::Duration::from_secs(15), c.output()).await {
        Err(_) => {
            return Json(CoderListResp { available: false, error: Some("coder list timed out".into()), workspaces: vec![] });
        }
        Ok(Err(e)) => {
            // Most commonly: coder isn't installed / not on PATH.
            let msg = format!("coder CLI not available: {e}");
            return Json(CoderListResp { available: false, error: Some(msg), workspaces: vec![] });
        }
        Ok(Ok(out)) => out,
    };

    if !out.status.success() {
        // Typically "not logged in" — coder prints guidance to stderr.
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let message = if stderr.is_empty() { "coder list failed".to_string() } else { stderr };
        return Json(CoderListResp { available: false, error: Some(message), workspaces: vec![] });
    }

    let workspaces = parse_coder_workspaces(&out.stdout);
    Json(CoderListResp { available: true, error: None, workspaces })
}

/// Parses `coder list --output json` into our trimmed view. Tolerant of
/// schema drift: pulls only the handful of fields we need and skips anything
/// malformed rather than failing the whole request.
fn parse_coder_workspaces(stdout: &[u8]) -> Vec<CoderWorkspace> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return vec![];
    };
    let Some(arr) = value.as_array() else { return vec![] };
    let mut out = Vec::new();
    for w in arr {
        let Some(name) = w.get("name").and_then(|n| n.as_str()) else { continue };
        let owner = w.get("owner_name").and_then(|o| o.as_str()).unwrap_or("").to_string();
        let status = w
            .pointer("/latest_build/status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string();
        let outdated = w.get("outdated").and_then(|o| o.as_bool()).unwrap_or(false);
        let id = if owner.is_empty() { name.to_string() } else { format!("{owner}/{name}") };
        out.push(CoderWorkspace { id, name: name.to_string(), owner, status, outdated });
    }
    out.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    out
}

#[derive(Deserialize)]
struct CoderActionReq {
    /// `owner/name` (or bare `name`) as returned in the workspace list.
    workspace: String,
}

/// `coder start <workspace>` / `coder stop <workspace>`. Both builds can take
/// minutes, so we don't wait for completion: the process is spawned, reaped
/// in the background, and the frontend observes the transition ("starting" /
/// "stopping" → "running" / "stopped", or "failed") by polling the list.
/// Only immediate spawn failures (e.g. coder not installed) are reported.
async fn run_coder_transition(state: &Arc<AppState>, verb: &str, workspace: &str) -> Result<(), (StatusCode, String)> {
    let workspace = workspace.trim();
    if workspace.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "workspace is required".into()));
    }
    let mut c = coder_command(&state.cfg, &[verb, workspace, "--yes"]);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
    match c.spawn() {
        Ok(mut child) => {
            // Reap it so it doesn't linger as a zombie; log non-zero exits.
            let verb = verb.to_string();
            let workspace = workspace.to_string();
            tokio::spawn(async move {
                if let Ok(status) = child.wait().await {
                    if !status.success() {
                        eprintln!("coder {verb} {workspace} exited: {status:?}");
                    }
                }
            });
            Ok(())
        }
        Err(e) => Err((StatusCode::BAD_GATEWAY, format!("failed to run coder: {e}"))),
    }
}

async fn start_coder_workspace(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CoderActionReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    run_coder_transition(&state, "start", &req.workspace).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn stop_coder_workspace(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CoderActionReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    run_coder_transition(&state, "stop", &req.workspace).await?;
    Ok(StatusCode::ACCEPTED)
}

// ---- chat history (sessions) REST API -----------------------------------

#[derive(Serialize)]
struct SessionView {
    path: String,
    title: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u128,
}

/// Lists the project's session `.jsonl` files. `session_dir` is learned from
/// the pi process's own `get_session_stats` response, so it points at
/// whatever machine runs pi — this host normally, or the SSH target's host
/// when one is set. The listing is therefore dual-mode (local `read_dir`, or
/// one ssh round-trip), same as the agent-definition file ops. A missing or
/// not-yet-created session dir degrades to an empty list rather than erroring.
async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<SessionView>>, StatusCode> {
    let entry = state.projects.read().await.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let session_dir = entry.session_dir.lock().await.clone();
    let Some(session_dir) = session_dir else {
        return Ok(Json(Vec::new()));
    };
    let ssh = state.ssh.read().await.clone();

    let start = Instant::now();
    let mut sessions = if ssh.host.is_some() {
        list_sessions_remote(&ssh, &session_dir).await
    } else {
        list_sessions_local(&session_dir).await
    };
    sessions.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    log!(
        "list_sessions for {id}: {} sessions in {:?} ({})",
        sessions.len(),
        start.elapsed(),
        if ssh.host.is_some() { "ssh" } else { "local" }
    );
    Ok(Json(sessions))
}

/// Local branch of `list_sessions`: read the session dir off this host's
/// filesystem, one file at a time.
async fn list_sessions_local(session_dir: &FsPath) -> Vec<SessionView> {
    let Ok(mut dir_entries) = tokio::fs::read_dir(session_dir).await else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    while let Ok(Some(dir_entry)) = dir_entries.next_entry().await {
        let path = dir_entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime_ms = dir_entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let title = session_title(&path)
            .await
            .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or("session").to_string());
        sessions.push(SessionView { path: path.display().to_string(), title, mtime_ms });
    }
    sessions
}

/// SSH branch of `list_sessions`: one round-trip lists every `*.jsonl` in the
/// remote session dir and, per file, emits NUL-framed
/// `(fileName, mtimeSeconds, head)` triples — `head` being the first 50 lines,
/// enough for `session_title_from_lines` without shipping whole session files
/// over the wire. `stat -c %Y` (GNU) falls back to `stat -f %m` (BSD/macOS)
/// so mtime works regardless of the remote OS; the returned `path` is the
/// absolute remote path pi's `switch_session` expects. Any failure (bad
/// target, missing dir) degrades to an empty list, same as the local branch.
async fn list_sessions_remote(ssh: &SshConfig, session_dir: &FsPath) -> Vec<SessionView> {
    let dir_remote = session_dir.to_string_lossy();
    let dir_quoted = shell_quote(dir_remote.as_ref());
    let remote_cmd = format!(
        "cd {dir_quoted} 2>/dev/null && for f in *.jsonl; do [ -f \"$f\" ] || continue; \
         printf '%s\\0' \"$f\"; \
         printf '%s\\0' \"$(stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\" 2>/dev/null)\"; \
         head -n 50 \"$f\"; printf '\\0'; done"
    );
    let mut c = ssh_command(ssh, 8);
    c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = match tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    let mut parts = out.stdout.split(|b| *b == 0);
    let mut sessions = Vec::new();
    while let (Some(name), Some(mtime), Some(head)) = (parts.next(), parts.next(), parts.next()) {
        let (Ok(name), Ok(mtime), Ok(head)) =
            (std::str::from_utf8(name), std::str::from_utf8(mtime), std::str::from_utf8(head))
        else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let mtime_ms = mtime.trim().parse::<u128>().map(|s| s * 1000).unwrap_or(0);
        let title = session_title_from_lines(head.lines())
            .unwrap_or_else(|| name.strip_suffix(".jsonl").unwrap_or(name).to_string());
        let path = format!("{}/{name}", dir_remote.trim_end_matches('/'));
        sessions.push(SessionView { path, title, mtime_ms });
    }
    sessions
}

// ---- content search REST API --------------------------------------------
//
// Cross-chat search scoped to one project, modeled closely on `list_sessions`
// above (same `session_dir` lookup, same local/remote split, same
// empty-list-on-anything-missing degradation). Unlike `list_sessions` this
// reads message *content*, not just the first 50 lines, so the local/remote
// branches each bound their own work — capped file count, capped bytes read
// per file, capped total results — so a large session history can't stall
// the server. Per the protocol-boundary rule, this never parses pi's message
// schema: it's a raw case-insensitive substring scan over each JSONL line's
// text, which is enough to find a match and build a readable snippet without
// knowing pi's content-block shape.

/// Query string for `GET /api/projects/{id}/search`; `q` defaults to empty
/// (rather than rejecting a missing param) so a short/absent query just
/// yields an empty result list like a too-short one does.
#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
}

/// One matching session file. `snippet` is a short, human-readable excerpt
/// around the first match (JSON escape sequences stripped, whitespace
/// collapsed); `match_count` is how many times `q` occurs in the file
/// (case-insensitive), not just in the snippet's line.
#[derive(Serialize)]
struct SearchResultView {
    path: String,
    title: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u128,
    snippet: String,
    #[serde(rename = "matchCount")]
    match_count: usize,
}

/// Queries shorter than this are ignored (empty result) rather than scanning
/// every session file for a near-useless match.
const SEARCH_MIN_QUERY_LEN: usize = 2;
/// At most this many of the newest session files are scanned at all; older
/// history is never searched. Bounds worst-case work independent of how long
/// a project's history is.
const SEARCH_MAX_FILES_SCANNED: usize = 300;
/// At most this many bytes are read from any single session file while
/// scanning for matches — long-running chats can have very large session
/// files, and a match (or the title) is almost always near the start anyway.
const SEARCH_MAX_BYTES_PER_FILE: u64 = 2_000_000;
/// Final result cap returned to the client, applied after newest-first sort.
const SEARCH_MAX_RESULTS: usize = 30;

/// Lists sessions in the current project whose content (not just title)
/// contains `q`, newest-first. See the section comment above for the
/// bounding strategy and the protocol-boundary rationale for a raw substring
/// scan instead of parsing pi's message schema.
async fn search_sessions(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<SearchQuery>,
) -> Result<Json<Vec<SearchResultView>>, StatusCode> {
    let entry = state.projects.read().await.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let query = q.q.trim().to_string();
    if query.chars().count() < SEARCH_MIN_QUERY_LEN {
        return Ok(Json(Vec::new()));
    }
    let session_dir = entry.session_dir.lock().await.clone();
    let Some(session_dir) = session_dir else {
        return Ok(Json(Vec::new()));
    };
    let ssh = state.ssh.read().await.clone();

    let mut results = if ssh.host.is_some() {
        search_sessions_remote(&ssh, &session_dir, &query).await
    } else {
        search_sessions_local(&session_dir, &query).await
    };
    results.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    results.truncate(SEARCH_MAX_RESULTS);
    Ok(Json(results))
}

/// Local branch of `search_sessions`: sorts session files newest-first, keeps
/// only the newest `SEARCH_MAX_FILES_SCANNED`, then reads each (up to
/// `SEARCH_MAX_BYTES_PER_FILE`) line by line looking for a case-insensitive
/// substring match. The same head lines used to look for a match are reused
/// for `session_title_from_lines` (matching `list_sessions_local`'s title
/// derivation) rather than re-reading the file.
async fn search_sessions_local(session_dir: &FsPath, query: &str) -> Vec<SearchResultView> {
    let Ok(mut dir_entries) = tokio::fs::read_dir(session_dir).await else {
        return Vec::new();
    };
    let mut files: Vec<(PathBuf, u128)> = Vec::new();
    while let Ok(Some(dir_entry)) = dir_entries.next_entry().await {
        let path = dir_entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime_ms = dir_entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        files.push((path, mtime_ms));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(SEARCH_MAX_FILES_SCANNED);

    let query_lower = query.to_ascii_lowercase();
    let mut results = Vec::new();
    for (path, mtime_ms) in files {
        let Ok(file) = tokio::fs::File::open(&path).await else { continue };
        let mut lines = BufReader::new(file).lines();
        let mut head: Vec<String> = Vec::new();
        let mut match_count = 0usize;
        let mut snippet: Option<String> = None;
        let mut bytes_read: u64 = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            bytes_read += line.len() as u64 + 1;
            if head.len() < 50 {
                head.push(line.clone());
            }
            // Skip pathologically long lines (e.g. an embedded base64 image
            // block) rather than scanning megabytes of non-prose text.
            if line.len() <= 200_000 {
                let lower = line.to_ascii_lowercase();
                let mut start = 0;
                while let Some(idx) = lower[start..].find(&query_lower) {
                    let abs = start + idx;
                    match_count += 1;
                    if snippet.is_none() {
                        snippet = Some(make_snippet(&line, abs, query.len()));
                    }
                    start = abs + query_lower.len().max(1);
                }
            }
            if bytes_read >= SEARCH_MAX_BYTES_PER_FILE {
                break;
            }
        }
        let Some(snippet) = snippet else { continue };
        let title = session_title_from_lines(head.iter().map(String::as_str))
            .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or("session").to_string());
        results.push(SearchResultView { path: path.display().to_string(), title, mtime_ms, snippet, match_count });
    }
    results
}

/// SSH branch of `search_sessions`: greps every project session file on the
/// remote host in one round-trip, same NUL-framed-fields shape as
/// `list_sessions_remote`. Candidate files are pre-sorted newest-first via
/// `ls -1t` and capped at `SEARCH_MAX_FILES_SCANNED` *before* grepping, so the
/// remote side has the same bound as the local branch. `grep -icF` (fixed
/// string, case-insensitive, count-only) decides whether a file matches at
/// all and how many times; `grep -im1 -F` pulls just the first matching line,
/// which is all that's needed to build the snippet locally with the same
/// `make_snippet` helper the local branch uses. The same 50-line head
/// `list_sessions_remote` fetches for the title is reused here too. Any
/// failure (bad target, missing dir, no grep) degrades to an empty list.
async fn search_sessions_remote(ssh: &SshConfig, session_dir: &FsPath, query: &str) -> Vec<SearchResultView> {
    let dir_remote = session_dir.to_string_lossy();
    let dir_quoted = shell_quote(dir_remote.as_ref());
    let query_quoted = shell_quote(query);
    let remote_cmd = format!(
        "cd {dir_quoted} 2>/dev/null && ls -1t *.jsonl 2>/dev/null | head -n {SEARCH_MAX_FILES_SCANNED} | \
         while IFS= read -r f; do \
         cnt=$(grep -icF -- {query_quoted} \"$f\" 2>/dev/null); \
         [ \"$cnt\" -gt 0 ] 2>/dev/null || continue; \
         printf '%s\\0' \"$f\"; \
         printf '%s\\0' \"$(stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\" 2>/dev/null)\"; \
         printf '%s\\0' \"$cnt\"; \
         grep -im1 -F -- {query_quoted} \"$f\" 2>/dev/null; printf '\\0'; \
         head -n 50 \"$f\"; printf '\\0'; \
         done"
    );
    let mut c = ssh_command(ssh, 8);
    c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = match tokio::time::timeout(std::time::Duration::from_secs(15), c.output()).await {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    let query_lower = query.to_ascii_lowercase();
    let mut parts = out.stdout.split(|b| *b == 0);
    let mut results = Vec::new();
    while let (Some(name), Some(mtime), Some(cnt), Some(first_line), Some(head)) =
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
    {
        let (Ok(name), Ok(mtime), Ok(cnt), Ok(first_line), Ok(head)) = (
            std::str::from_utf8(name),
            std::str::from_utf8(mtime),
            std::str::from_utf8(cnt),
            std::str::from_utf8(first_line),
            std::str::from_utf8(head),
        ) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let mtime_ms = mtime.trim().parse::<u128>().map(|s| s * 1000).unwrap_or(0);
        let match_count: usize = cnt.trim().parse().unwrap_or(1);
        let first_line = first_line.trim_end_matches('\n');
        // grep already confirmed a match exists in this file; if the
        // first-match line itself doesn't parse back to an index (shouldn't
        // happen, but grep and our own lowercasing could disagree on some
        // multi-byte edge case) fall back to a snippet-less skip rather than
        // panicking on the slice below.
        let Some(match_idx) = first_line.to_ascii_lowercase().find(&query_lower) else { continue };
        let snippet = make_snippet(first_line, match_idx, query.len());
        let title = session_title_from_lines(head.lines())
            .unwrap_or_else(|| name.strip_suffix(".jsonl").unwrap_or(name).to_string());
        let path = format!("{}/{name}", dir_remote.trim_end_matches('/'));
        results.push(SearchResultView { path, title, mtime_ms, snippet, match_count });
    }
    results
}

/// Builds a ~140-char human-readable excerpt around a substring match found
/// at byte offset `match_idx` in a raw JSONL line. Since pi's session lines
/// are JSON, matched text is almost always inside a `"..."` string value with
/// JSON escaping still in place (`\n`, `\"`, `\\`); this strips the common
/// escape sequences and collapses whitespace runs so the excerpt reads like
/// plain prose instead of raw JSON. Indices are snapped to UTF-8 char
/// boundaries since `match_idx` comes from an ASCII-lowercased search over a
/// string that may contain multi-byte characters outside the match itself.
fn make_snippet(line: &str, match_idx: usize, query_len: usize) -> String {
    const RADIUS: usize = 90;
    let raw_start = match_idx.saturating_sub(RADIUS);
    let raw_end = (match_idx + query_len + RADIUS).min(line.len());
    let start = (0..=raw_start).rev().find(|&i| line.is_char_boundary(i)).unwrap_or(0);
    let end = (raw_end..=line.len()).find(|&i| line.is_char_boundary(i)).unwrap_or(line.len());
    let window = &line[start..end];
    let unescaped =
        window.replace("\\n", " ").replace("\\t", " ").replace("\\r", " ").replace("\\\"", "\"").replace("\\\\", "\\");
    let collapsed = unescaped.split_whitespace().collect::<Vec<_>>().join(" ");
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < line.len() { "…" } else { "" };
    format!("{prefix}{collapsed}{suffix}")
}

/// Best-effort chat title: the first user message's text, truncated. Falls
/// back to the filename (via the caller) if the file is empty, unreadable,
/// or doesn't look like a pi session in the expected shape. Only the first
/// 50 lines are read — enough to find the opening user message without
/// slurping a large session file.
async fn session_title(path: &FsPath) -> Option<String> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut lines = BufReader::new(file).lines();
    let mut head: Vec<String> = Vec::new();
    while head.len() < 50 {
        let Ok(Some(line)) = lines.next_line().await else { break };
        head.push(line);
    }
    session_title_from_lines(head.iter().map(String::as_str))
}

/// Shared title extraction over the first lines of a session `.jsonl`, used by
/// both the local (`session_title`) and SSH (`list_sessions`) code paths.
///
/// Each line is a session-manager entry, not a bare chat message — pi wraps
/// messages as `{"type":"message","message":{"role":...,"content":[...]}}`
/// (see `SessionManager.appendMessage`), so a top-level `role` field never
/// matches. An explicit display name set via `set_session_name` is its own
/// entry, `{"type":"session_info","name":...}` (`appendSessionInfo`), and
/// takes priority — it's what shows in the chat header, so the sidebar
/// should show the same thing rather than falling back to message text. A
/// rename later in a long session (past our bounded read window) won't be
/// picked up here, but a rename within the scanned prefix should win even if
/// it comes after the first user message, so both entry kinds are scanned
/// together and the last name seen is preferred over the first user text.
fn session_title_from_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut first_user_text: Option<String> = None;
    let mut display_name: Option<String> = None;
    for line in lines.take(50) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_info") => {
                // An empty name explicitly clears the title (matches
                // SessionManager.getSessionName's own semantics), so this
                // still overwrites any earlier name in the scanned window.
                let name = v.get("name").and_then(|n| n.as_str()).map(str::trim).filter(|n| !n.is_empty());
                display_name = name.map(str::to_string);
            }
            Some("message") if first_user_text.is_none() => {
                let msg = v.get("message");
                if msg.and_then(|m| m.get("role")).and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                let text = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
                    .and_then(|b| b.get("text"))
                    .and_then(|t| t.as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty());
                first_user_text = text.map(str::to_string);
            }
            _ => {}
        }
    }
    let raw = display_name.or(first_user_text)?;
    let truncated: String = raw.chars().take(60).collect();
    Some(if raw.chars().count() > 60 { format!("{truncated}…") } else { truncated })
}

// ---- agent definitions REST API -----------------------------------------
//
// pi-mono's `subagent` extension reads per-agent markdown files with a small
// YAML-ish frontmatter (name/description/tools/model, all single-line
// scalars) from two locations: a user scope (`~/.pi/agent/agents/*.md`) and
// a per-project scope (`<projectPath>/.pi/agents/*.md`). Both are directories
// on whatever machine actually runs pi — this machine normally, or the SSH
// target's machine when one is set — so every filesystem op here has the
// same local/remote duality as `spawn_child`/`run_git`/`list_remote_dirs`
// above. There's deliberately no yaml crate involved: the frontmatter shape
// is fixed and tiny enough that a hand-rolled parser/serializer round-trips
// it (including lines it doesn't understand) more predictably than pulling
// in a general YAML parser would.

/// One agent-definition file as parsed for the frontend. `raw` is always the
/// full file contents verbatim (used both to show a "view source" toggle and
/// as the write-back payload for files whose frontmatter didn't parse);
/// `name`/`description`/`tools`/`model`/`parseError` are best-effort and any
/// of them can be absent, e.g. for a file missing its closing `---`.
#[derive(Serialize)]
struct AgentView {
    scope: String,
    #[serde(rename = "fileName")]
    file_name: String,
    name: Option<String>,
    description: Option<String>,
    tools: Option<String>,
    model: Option<String>,
    #[serde(rename = "systemPrompt")]
    system_prompt: String,
    raw: String,
    #[serde(rename = "parseError")]
    parse_error: Option<String>,
}

impl AgentView {
    fn new(scope: &str, file_name: String, raw: String, parsed: ParsedAgent) -> Self {
        AgentView {
            scope: scope.to_string(),
            file_name,
            name: parsed.name,
            description: parsed.description,
            tools: parsed.tools,
            model: parsed.model,
            system_prompt: parsed.system_prompt,
            raw,
            parse_error: parsed.parse_error,
        }
    }
}

#[derive(Serialize)]
struct AgentsResp {
    agents: Vec<AgentView>,
}

/// The directory holding agent-definition files for one scope, in both
/// local and SSH-remote-embeddable form — mirrors the `local`/remote-string
/// split callers already do inline for `spawn_child`'s `cwd` and
/// `run_git`'s `cwd`, just bundled into one value since the agent-file
/// helpers below need it repeatedly. `remote_expr` is a value that's already
/// safe to splice directly into a remote shell command: for user scope it's
/// the literal, deliberately *unquoted* string `~/.pi/agent/agents` (quoting
/// it would defeat sh's tilde-expansion); for project scope it's the
/// project's path with `.pi/agents` appended, `shell_quote`d as a whole
/// since project paths can contain spaces.
struct AgentsDir {
    local: PathBuf,
    remote_expr: String,
}

/// Resolves the agents directory for `scope` ("user" or "project"). For
/// project scope, `project_id` must name a known project — 404 otherwise,
/// matching how every other per-project endpoint in this file reports an
/// unknown id. `list_agents` intentionally does *not* use this for its own
/// project-scope lookup (an unknown `projectId` there just means "skip
/// project scope", not a request error) — this is for `save_agent`/
/// `delete_agent`, where the caller is acting on a specific scope and an
/// unresolvable one really is an error.
async fn resolve_agents_dir(
    state: &Arc<AppState>,
    scope: &str,
    project_id: Option<&str>,
) -> Result<AgentsDir, (StatusCode, String)> {
    match scope {
        "user" => Ok(AgentsDir {
            local: home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".pi/agent/agents"),
            remote_expr: "~/.pi/agent/agents".to_string(),
        }),
        "project" => {
            let id = project_id
                .filter(|s| !s.is_empty())
                .ok_or((StatusCode::NOT_FOUND, "projectId is required for project scope".to_string()))?;
            let entry = state
                .projects
                .read()
                .await
                .get(id)
                .cloned()
                .ok_or((StatusCode::NOT_FOUND, "unknown project".to_string()))?;
            let local = entry.path.join(".pi").join("agents");
            let remote_path = format!("{}/.pi/agents", entry.path.to_string_lossy());
            Ok(AgentsDir { local, remote_expr: shell_quote(&remote_path) })
        }
        other => Err((StatusCode::BAD_REQUEST, format!("invalid scope: {other} (expected \"user\" or \"project\")"))),
    }
}

/// Builds `ssh <opts> <host>`, ready for the caller to append the remote
/// command and set stdio — the option list `run_git`/`list_remote_dirs`
/// above also use, factored out here since the agent-file helpers below need
/// several independent round-trips (list, exists, write, delete) instead of
/// just one.
fn ssh_command(ssh: &SshConfig, connect_timeout_secs: u64) -> Command {
    let ssh_host = ssh.host.as_deref().expect("caller only invokes this when ssh.host is Some");
    let mut c = Command::new("ssh");
    c.arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg(format!("ConnectTimeout={connect_timeout_secs}"));
    if let Some(identity) = &ssh.identity {
        c.arg("-i").arg(identity);
    }
    if let Some(port) = ssh.port {
        c.arg("-p").arg(port.to_string());
    }
    c.arg(ssh_host);
    c
}

/// Builds a single shell "word" for `dir/file_name` on the remote host, by
/// concatenating `dir_remote` (either the unquoted `~/...` literal or an
/// already-`shell_quote`d path, per `AgentsDir::remote_expr`) with a
/// separately quoted file name. sh concatenates adjacent quoted/unquoted
/// segments that have no whitespace between them into one word, so both
/// `~/.pi/agent/agents/'my agent.md'` and `'/path with space'/'a.md'` expand
/// to the intended single path.
fn remote_file_expr(dir_remote: &str, file_name: &str) -> String {
    format!("{dir_remote}/{}", shell_quote(file_name))
}

/// Reads every `*.md` file in an agents directory — locally, or over SSH —
/// as `(fileName, contents)` pairs. A missing/unreadable directory degrades
/// to an empty list rather than an error, same as `list_sessions` treats a
/// project's (possibly not-yet-existing) session directory: an empty scope
/// isn't a failure.
async fn read_agent_files(ssh: &SshConfig, dir_local: &FsPath, dir_remote: &str) -> Result<Vec<(String, String)>, String> {
    if ssh.host.is_some() {
        // One ssh round-trip lists and reads every file, emitting NUL-framed
        // (fileName, contents) pairs so neither filenames nor file contents
        // containing newlines can be mistaken for record boundaries. The
        // `[ -f "$f" ]` guard skips the unglobbed literal `*.md` that `for`
        // iterates over when the directory has no matches (sh's default
        // non-nullglob behavior); a `cd` failure short-circuits to no output
        // at all, same as local `read_dir` failing below.
        let remote_cmd = format!(
            "cd {dir_remote} 2>/dev/null && for f in *.md; do [ -f \"$f\" ] || continue; printf '%s\\0' \"$f\"; cat \"$f\"; printf '\\0'; done"
        );
        let mut c = ssh_command(ssh, 8);
        c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let out = match tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(format!("failed to run ssh: {e}")),
            Err(_) => return Err("ssh command timed out".to_string()),
        };
        Ok(split_nul_pairs(&out.stdout))
    } else {
        let mut entries = match tokio::fs::read_dir(dir_local).await {
            Ok(rd) => rd,
            Err(_) => return Ok(Vec::new()),
        };
        let mut files = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(meta) = entry.metadata().await else { continue };
            if !meta.is_file() {
                continue;
            }
            let Some(file_name) = entry.file_name().to_str().map(|s| s.to_string()) else { continue };
            // Skip files that aren't valid UTF-8 rather than failing the
            // whole listing over one bad file.
            if let Ok(contents) = tokio::fs::read_to_string(entry.path()).await {
                files.push((file_name, contents));
            }
        }
        Ok(files)
    }
}

/// Splits the NUL-framed `(fileName, contents)` stream `read_agent_files`'s
/// remote branch produces back into pairs. The final NUL leaves a trailing
/// empty split artifact, which naturally falls out (the `contents` half of
/// that pair is absent, so the pattern match below stops the loop) rather
/// than needing special-casing.
fn split_nul_pairs(bytes: &[u8]) -> Vec<(String, String)> {
    let mut parts = bytes.split(|b| *b == 0);
    let mut out = Vec::new();
    while let (Some(name), Some(contents)) = (parts.next(), parts.next()) {
        if let (Ok(name), Ok(contents)) = (std::str::from_utf8(name), std::str::from_utf8(contents)) {
            out.push((name.to_string(), contents.to_string()));
        }
    }
    out
}

/// Whether `dir/file_name` exists — used for the create-vs-409 check in
/// `save_agent` and the 404-vs-success check in `delete_agent`.
async fn agent_file_exists(ssh: &SshConfig, dir_local: &FsPath, dir_remote: &str, file_name: &str) -> bool {
    if ssh.host.is_some() {
        let remote_cmd = format!("test -f {}", remote_file_expr(dir_remote, file_name));
        let mut c = ssh_command(ssh, 8);
        c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        matches!(
            tokio::time::timeout(std::time::Duration::from_secs(10), c.status()).await,
            Ok(Ok(status)) if status.success()
        )
    } else {
        tokio::fs::try_exists(dir_local.join(file_name)).await.unwrap_or(false)
    }
}

/// Reads one agent file's raw contents, if it exists and is readable —
/// `None` on any failure (missing, unreadable, not valid UTF-8, ssh error).
/// Used by `save_agent` to fetch the *previous* contents of a file being
/// updated, so a structured-mode edit can carry forward frontmatter lines
/// this codec doesn't otherwise understand (see `ParsedAgent::extra`)
/// instead of silently dropping them.
async fn read_agent_file(ssh: &SshConfig, dir_local: &FsPath, dir_remote: &str, file_name: &str) -> Option<String> {
    if ssh.host.is_some() {
        let remote_cmd = format!("cat {}", remote_file_expr(dir_remote, file_name));
        let mut c = ssh_command(ssh, 8);
        c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let out = tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout).ok()
    } else {
        tokio::fs::read_to_string(dir_local.join(file_name)).await.ok()
    }
}

/// Writes `contents` to `dir/file_name`, creating the directory first
/// (`mkdir -p` semantics both locally and remotely) — callers decide
/// create-vs-overwrite via `agent_file_exists` before calling this, it
/// always just writes.
async fn write_agent_file(ssh: &SshConfig, dir_local: &FsPath, dir_remote: &str, file_name: &str, contents: &str) -> Result<(), String> {
    if ssh.host.is_some() {
        let remote_cmd = format!("mkdir -p {dir_remote} && cat > {}", remote_file_expr(dir_remote, file_name));
        let mut c = ssh_command(ssh, 8);
        c.arg(&remote_cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = c.spawn().map_err(|e| format!("failed to run ssh: {e}"))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let write_res = stdin.write_all(contents.as_bytes()).await;
        drop(stdin);
        if let Err(e) = write_res {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(format!("failed to write to ssh stdin: {e}"));
        }
        let out = match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(format!("failed to run ssh: {e}")),
            Err(_) => return Err("ssh command timed out".to_string()),
        };
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if stderr.is_empty() { "failed to write agent file".to_string() } else { stderr })
        }
    } else {
        tokio::fs::create_dir_all(dir_local).await.map_err(|e| format!("failed to create directory: {e}"))?;
        tokio::fs::write(dir_local.join(file_name), contents).await.map_err(|e| format!("failed to write file: {e}"))
    }
}

/// Deletes `dir/file_name`. `Ok(false)` (not an error) means it didn't exist
/// to begin with, so callers can turn that into a 404 without a separate
/// existence check.
async fn delete_agent_file(ssh: &SshConfig, dir_local: &FsPath, dir_remote: &str, file_name: &str) -> Result<bool, String> {
    if ssh.host.is_some() {
        let expr = remote_file_expr(dir_remote, file_name);
        // Exit code 3 is our own sentinel for "wasn't there" — chosen since
        // `rm`'s own failure exit (1) shouldn't be conflated with it.
        let remote_cmd = format!("if [ -f {expr} ]; then rm -- {expr}; else exit 3; fi");
        let mut c = ssh_command(ssh, 8);
        c.arg(&remote_cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let out = match tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(format!("failed to run ssh: {e}")),
            Err(_) => return Err("ssh command timed out".to_string()),
        };
        if out.status.success() {
            Ok(true)
        } else if out.status.code() == Some(3) {
            Ok(false)
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if stderr.is_empty() { "failed to delete agent file".to_string() } else { stderr })
        }
    } else {
        match tokio::fs::remove_file(dir_local.join(file_name)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("failed to delete file: {e}")),
        }
    }
}

/// A bare file/agent-name component: non-empty, drawn only from
/// `[A-Za-z0-9._-]`, and not containing `..` — the character class already
/// excludes `/` (so there's no directory to traverse into in the first
/// place), the `..` check is belt-and-suspenders on top of that.
fn valid_agent_file_component(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !s.contains("..")
}

/// Frontmatter scalars are constrained to one line (see `serialize_agent_md`
/// — they're always emitted as a single quoted line); reject values that
/// would break that before they ever reach the codec.
fn has_line_break(s: &str) -> bool {
    s.contains('\n') || s.contains('\r')
}

// ---- agent-definition frontmatter codec ---------------------------------
//
// Hand-rolled rather than pulled from a yaml crate: the shape is fixed to
// four known single-line scalar keys plus an opaque body, small enough that
// a dedicated parser/serializer round-trips it (including lines it doesn't
// understand, preserved verbatim) more predictably than a general YAML
// parser would, and keeps the "no new crates" footprint of this change to
// zero.

/// The result of parsing one agent-definition markdown file. `extra` holds
/// unknown frontmatter lines verbatim, in their original order, so
/// `serialize_agent_md` can round-trip a file's untouched fields even though
/// this codec only understands four of them. `parse_error` is set whenever
/// the frontmatter block itself is malformed (missing opening/closing `---`)
/// — the four known fields and `extra` are still filled in on a best-effort
/// basis where possible; `system_prompt` falls back to the whole raw input
/// when even the frontmatter's start can't be located.
struct ParsedAgent {
    name: Option<String>,
    description: Option<String>,
    tools: Option<String>,
    model: Option<String>,
    extra: Vec<String>,
    system_prompt: String,
    parse_error: Option<String>,
}

/// Strips one layer of matching surrounding quotes from a frontmatter value,
/// unescaping as it goes: `\"` and `\\` inside double quotes, `''` (doubled
/// single quote) inside single quotes. Values that aren't quoted (or whose
/// quotes don't match) are returned unchanged — pi's own frontmatter writer
/// always double-quotes, but hand-edited files may use single quotes or none
/// at all, so all three are accepted on read.
fn unquote_frontmatter_value(v: &str) -> String {
    let bytes = v.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        let inner = &v[1..v.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.peek() {
                    Some('"') => {
                        out.push('"');
                        chars.next();
                    }
                    Some('\\') => {
                        out.push('\\');
                        chars.next();
                    }
                    _ => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if bytes.len() >= 2 && bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'' {
        let inner = &v[1..v.len() - 1];
        return inner.replace("''", "'");
    }
    v.to_string()
}

/// Double-quotes a frontmatter value for output, escaping `\` and `"` — the
/// inverse of the double-quote branch of `unquote_frontmatter_value`.
/// `serialize_agent_md` always uses this (never single-quote or bare
/// output), so every file this server writes is unambiguous to re-parse.
fn quote_frontmatter_value(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Parses one agent-definition markdown file's contents.
fn parse_agent_md(raw: &str) -> ParsedAgent {
    let empty = || ParsedAgent {
        name: None,
        description: None,
        tools: None,
        model: None,
        extra: Vec::new(),
        system_prompt: String::new(),
        parse_error: None,
    };

    let all_lines: Vec<&str> = raw.lines().collect();
    if all_lines.first() != Some(&"---") {
        return ParsedAgent {
            // Nothing usable was located, so fall back to showing the whole
            // file as the "body" — the raw editor is still viable even when
            // structured parsing fails outright.
            system_prompt: raw.to_string(),
            parse_error: Some("missing frontmatter: file must start with a '---' line".to_string()),
            ..empty()
        };
    }

    let mut name = None;
    let mut description = None;
    let mut tools = None;
    let mut model = None;
    let mut extra = Vec::new();
    let mut closed = false;
    let mut consumed = 1; // the opening "---" line

    for line in &all_lines[1..] {
        consumed += 1;
        if *line == "---" {
            closed = true;
            break;
        }
        match line.split_once(':') {
            Some((key, value)) => {
                let key = key.trim();
                let value = unquote_frontmatter_value(value.trim());
                match key {
                    "name" => name = Some(value),
                    "description" => description = Some(value),
                    "tools" => tools = Some(value),
                    "model" => model = Some(value),
                    _ => extra.push((*line).to_string()),
                }
            }
            None => extra.push((*line).to_string()),
        }
    }

    if !closed {
        return ParsedAgent {
            name,
            description,
            tools,
            model,
            extra,
            system_prompt: String::new(),
            parse_error: Some("missing closing '---' frontmatter delimiter".to_string()),
        };
    }

    let mut body_lines = all_lines[consumed..].to_vec();
    if body_lines.first() == Some(&"") {
        body_lines.remove(0);
    }
    let mut system_prompt = body_lines.join("\n");
    if !body_lines.is_empty() {
        system_prompt.push('\n');
    }

    ParsedAgent { name, description, tools, model, extra, system_prompt, parse_error: None }
}

/// Serializes an agent definition back to markdown-with-frontmatter.
/// `name`/`description` are always emitted (double-quoted); `tools`/`model`
/// only when `Some` and non-empty; `extra` lines verbatim, preserving
/// whatever order `parse_agent_md` collected them in — this is what makes
/// round-tripping an existing file (parse then re-serialize) lossless for
/// fields this codec doesn't otherwise understand.
fn serialize_agent_md(
    name: &str,
    description: &str,
    tools: Option<&str>,
    model: Option<&str>,
    extra: &[String],
    system_prompt: &str,
) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", quote_frontmatter_value(name)));
    out.push_str(&format!("description: {}\n", quote_frontmatter_value(description)));
    if let Some(tools) = tools.filter(|s| !s.is_empty()) {
        out.push_str(&format!("tools: {}\n", quote_frontmatter_value(tools)));
    }
    if let Some(model) = model.filter(|s| !s.is_empty()) {
        out.push_str(&format!("model: {}\n", quote_frontmatter_value(model)));
    }
    for line in extra {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("---\n\n");
    out.push_str(system_prompt);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[derive(Deserialize)]
struct ListAgentsQuery {
    #[serde(default, rename = "projectId")]
    project_id: Option<String>,
}

/// Lists agent-definition files for the user scope, plus the project scope
/// when `projectId` is given *and* known. An unknown `projectId` is not an
/// error here (unlike `save_agent`/`delete_agent`): the caller is just
/// listing what's available, and "no project scope" is a perfectly good
/// answer for e.g. a project that was removed out from under an open tab.
async fn list_agents(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<ListAgentsQuery>,
) -> Json<AgentsResp> {
    let ssh = state.ssh.read().await.clone();
    let mut agents = Vec::new();

    if let Ok(user_dir) = resolve_agents_dir(&state, "user", None).await {
        agents.extend(list_agent_views(&ssh, &user_dir, "user").await);
    }

    if let Some(project_id) = q.project_id.as_deref().filter(|s| !s.is_empty()) {
        if state.projects.read().await.contains_key(project_id) {
            if let Ok(project_dir) = resolve_agents_dir(&state, "project", Some(project_id)).await {
                agents.extend(list_agent_views(&ssh, &project_dir, "project").await);
            }
        }
    }

    agents.sort_by(|a, b| {
        let rank = |s: &str| if s == "user" { 0u8 } else { 1u8 };
        rank(&a.scope).cmp(&rank(&b.scope)).then_with(|| a.file_name.cmp(&b.file_name))
    });

    Json(AgentsResp { agents })
}

async fn list_agent_views(ssh: &SshConfig, dir: &AgentsDir, scope: &str) -> Vec<AgentView> {
    read_agent_files(ssh, &dir.local, &dir.remote_expr)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(file_name, raw)| {
            let parsed = parse_agent_md(&raw);
            AgentView::new(scope, file_name, raw, parsed)
        })
        .collect()
}

#[derive(Deserialize)]
struct SaveAgentReq {
    scope: String,
    #[serde(default, rename = "projectId")]
    project_id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tools: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, rename = "systemPrompt")]
    system_prompt: String,
    /// Present when this save is renaming/overwriting a file that already
    /// exists under a different (or the same) name — see `save_agent`.
    #[serde(default, rename = "originalFileName")]
    original_file_name: Option<String>,
    /// When `Some`, write-verbatim mode: used by the frontend's raw editor,
    /// primarily for round-tripping a file whose frontmatter didn't parse
    /// (so there's no sane structured form to edit).
    #[serde(default)]
    raw: Option<String>,
    #[serde(default, rename = "fileName")]
    file_name: Option<String>,
}

/// Creates, updates, or renames one agent-definition file.
///
/// Two modes, chosen by whether `raw` is present:
/// - Verbatim (`raw: Some`): writes `raw` byte-for-byte to `fileName`. Always
///   an overwrite-or-create; there's no 409 in this mode since it's meant for
///   editing a file that (by definition, since the UI fell back to raw mode)
///   already exists.
/// - Structured (`raw: None`): serializes `name`/`description`/`tools`/
///   `model`/`systemPrompt` via `serialize_agent_md` and writes to
///   `<name>.md`. `originalFileName` absent means "create" (409 if
///   `<name>.md` already exists); present means "update/rename" — the new
///   file is written *before* the old one (if renamed) is deleted, so a
///   mid-operation failure can't lose the original.
async fn save_agent(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveAgentReq>,
) -> Result<Json<AgentView>, (StatusCode, String)> {
    if let Some(orig) = &req.original_file_name {
        if !valid_agent_file_component(orig) {
            return Err((StatusCode::BAD_REQUEST, "invalid originalFileName".to_string()));
        }
    }

    let dir = resolve_agents_dir(&state, &req.scope, req.project_id.as_deref()).await?;
    let ssh = state.ssh.read().await.clone();

    if let Some(raw) = &req.raw {
        let file_name = req
            .file_name
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or((StatusCode::BAD_REQUEST, "fileName is required when raw is set".to_string()))?;
        if !valid_agent_file_component(&file_name) {
            return Err((StatusCode::BAD_REQUEST, "invalid fileName".to_string()));
        }

        write_agent_file(&ssh, &dir.local, &dir.remote_expr, &file_name, raw)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        if let Some(orig) = &req.original_file_name {
            if orig != &file_name {
                let _ = delete_agent_file(&ssh, &dir.local, &dir.remote_expr, orig).await;
            }
        }

        let parsed = parse_agent_md(raw);
        return Ok(Json(AgentView::new(&req.scope, file_name, raw.clone(), parsed)));
    }

    let name = req.name.trim().to_string();
    let description = req.description.trim().to_string();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".to_string()));
    }
    if description.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "description is required".to_string()));
    }
    if !valid_agent_file_component(&name) {
        return Err((StatusCode::BAD_REQUEST, "name must match ^[A-Za-z0-9._-]+$ and not contain '..'".to_string()));
    }
    let tools = req.tools.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let model = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if has_line_break(&name)
        || has_line_break(&description)
        || tools.as_deref().is_some_and(has_line_break)
        || model.as_deref().is_some_and(has_line_break)
    {
        return Err((StatusCode::BAD_REQUEST, "name/description/tools/model must not contain a newline".to_string()));
    }

    let file_name = format!("{name}.md");
    if req.original_file_name.is_none() && agent_file_exists(&ssh, &dir.local, &dir.remote_expr, &file_name).await {
        return Err((StatusCode::CONFLICT, "an agent named this already exists".to_string()));
    }

    // An update (as opposed to a create) carries forward whatever unknown
    // frontmatter lines the previous version of this file had, so editing
    // name/description/tools/model through the structured form doesn't
    // silently drop fields this codec doesn't know about. A create, or an
    // original file this server can't read/parse, has nothing to carry
    // forward.
    let mut extra = Vec::new();
    if let Some(orig) = &req.original_file_name {
        if let Some(old_raw) = read_agent_file(&ssh, &dir.local, &dir.remote_expr, orig).await {
            let old_parsed = parse_agent_md(&old_raw);
            if old_parsed.parse_error.is_none() {
                extra = old_parsed.extra;
            }
        }
    }

    let raw = serialize_agent_md(&name, &description, tools.as_deref(), model.as_deref(), &extra, &req.system_prompt);
    write_agent_file(&ssh, &dir.local, &dir.remote_expr, &file_name, &raw)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if let Some(orig) = &req.original_file_name {
        if orig != &file_name {
            let _ = delete_agent_file(&ssh, &dir.local, &dir.remote_expr, orig).await;
        }
    }

    let parsed = parse_agent_md(&raw);
    Ok(Json(AgentView::new(&req.scope, file_name, raw, parsed)))
}

#[derive(Deserialize)]
struct DeleteAgentQuery {
    scope: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(default, rename = "projectId")]
    project_id: Option<String>,
}

async fn delete_agent(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<DeleteAgentQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !valid_agent_file_component(&q.file_name) {
        return Err((StatusCode::BAD_REQUEST, "invalid fileName".to_string()));
    }
    let dir = resolve_agents_dir(&state, &q.scope, q.project_id.as_deref()).await?;
    let ssh = state.ssh.read().await.clone();

    let existed = delete_agent_file(&ssh, &dir.local, &dir.remote_expr, &q.file_name)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if existed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "agent file not found".to_string()))
    }
}

#[cfg(test)]
mod agent_md_tests {
    use super::*;

    #[test]
    fn parse_basic() {
        let raw = "---\nname: scout\ndescription: Fast codebase recon\ntools: read, grep, find, ls, bash\nmodel: claude-haiku-4-5\n---\n\nYou are a scout.\n";
        let p = parse_agent_md(raw);
        assert!(p.parse_error.is_none());
        assert_eq!(p.name.as_deref(), Some("scout"));
        assert_eq!(p.description.as_deref(), Some("Fast codebase recon"));
        assert_eq!(p.tools.as_deref(), Some("read, grep, find, ls, bash"));
        assert_eq!(p.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(p.system_prompt, "You are a scout.\n");
        assert!(p.extra.is_empty());
    }

    #[test]
    fn parse_quoted_values_with_embedded_colons() {
        let raw = "---\nname: \"scout: v2\"\ndescription: 'Recon: fast and light'\n---\n\nBody.\n";
        let p = parse_agent_md(raw);
        assert!(p.parse_error.is_none());
        assert_eq!(p.name.as_deref(), Some("scout: v2"));
        assert_eq!(p.description.as_deref(), Some("Recon: fast and light"));
    }

    #[test]
    fn parse_missing_closing_delimiter_is_reported() {
        let raw = "---\nname: scout\ndescription: no closing delimiter here\n";
        let p = parse_agent_md(raw);
        assert!(p.parse_error.is_some());
        assert_eq!(p.name.as_deref(), Some("scout"));
    }

    #[test]
    fn parse_missing_opening_delimiter_is_reported() {
        let raw = "just a plain markdown file\nwith no frontmatter\n";
        let p = parse_agent_md(raw);
        assert!(p.parse_error.is_some());
        assert_eq!(p.name, None);
        assert_eq!(p.system_prompt, raw);
    }

    #[test]
    fn round_trip_preserves_unknown_lines_and_body() {
        let raw = "---\nname: scout\ndescription: Recon\ncustomField: hello world\n---\n\nSystem prompt body.\nSecond line.\n";
        let p = parse_agent_md(raw);
        assert_eq!(p.extra, vec!["customField: hello world".to_string()]);

        let out = serialize_agent_md(
            p.name.as_deref().unwrap(),
            p.description.as_deref().unwrap(),
            p.tools.as_deref(),
            p.model.as_deref(),
            &p.extra,
            &p.system_prompt,
        );
        let reparsed = parse_agent_md(&out);
        assert!(reparsed.parse_error.is_none());
        assert_eq!(reparsed.extra, p.extra);
        assert_eq!(reparsed.system_prompt, p.system_prompt);
        assert_eq!(reparsed.name.as_deref(), Some("scout"));
    }

    #[test]
    fn serialize_omits_empty_optional_fields() {
        let out = serialize_agent_md("scout", "desc", None, Some(""), &[], "body\n");
        assert!(!out.contains("tools:"));
        assert!(!out.contains("model:"));
    }
}
