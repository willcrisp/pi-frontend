//! Bridge between one or more `pi --mode rpc` child processes (one per
//! "project" working directory) and browser clients.
//!
//! pi speaks newline-delimited JSON on stdin/stdout. For each project this
//! server pipes those lines verbatim to/from WebSocket clients at
//! `/ws/{projectId}` — it does not parse the protocol, so it stays
//! compatible as pi evolves. The one deliberate exception: right after
//! spawning a project's pi process, it sends a `get_session_stats` probe
//! and peeks at the `sessionFile` field of the response to learn where pi
//! is writing that project's session history, so it can list past chats
//! without needing to know pi's session-directory naming scheme.
//!
//! Projects run concurrently: each one keeps its own pi process alive in
//! the background (added/removed via the `/api/projects` REST endpoints)
//! so work continues even while a different project is in view. The list
//! is persisted to `<data-dir>/projects.json`.
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
    sync::Arc,
    time::UNIX_EPOCH,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc, Mutex, RwLock},
};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

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

/// A live pi process for a project.
struct RunningProcess {
    to_pi: mpsc::Sender<String>,
    from_pi: broadcast::Sender<String>,
    kill_tx: mpsc::Sender<()>,
}

struct Config {
    port: u16,
    cwd: PathBuf,
    pi_bin: String,
    web_dir: PathBuf,
    data_dir: PathBuf,
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
    running: RwLock<HashMap<String, Arc<RunningProcess>>>,
    ssh: RwLock<SshConfig>,
}

fn default_data_dir() -> PathBuf {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    match std::env::var(home_var) {
        Ok(home) => PathBuf::from(home).join(".pi-web"),
        Err(_) => PathBuf::from(".pi-web"),
    }
}

fn parse_args() -> Config {
    let mut cfg = Config {
        port: 3210,
        cwd: PathBuf::from("."),
        pi_bin: "pi".into(),
        web_dir: PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist")),
        data_dir: default_data_dir(),
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
            "--web-dir" => cfg.web_dir = args.next().expect("--web-dir needs a value").into(),
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
                    "usage: pi-web-server [--port N] [--cwd DIR] [--pi-bin PATH] [--web-dir DIR] [--data-dir DIR] \
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
    let cfg = parse_args();
    let _ = tokio::fs::create_dir_all(&cfg.data_dir).await;

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

    // Projects run concurrently: bring every known project's pi process up
    // at startup rather than waiting for a client to connect.
    let ids: Vec<String> = state.projects.read().await.keys().cloned().collect();
    for id in ids {
        ensure_running(&state, &id).await;
    }

    let port = state.cfg.port;
    let web_dir = state.cfg.web_dir.clone();
    let index = web_dir.join("index.html");

    let app = Router::new()
        .route("/api/projects", get(list_projects).post(add_project))
        .route("/api/projects/{id}", delete(remove_project))
        .route("/api/projects/{id}/sessions", get(list_sessions))
        .route("/api/browse-dirs", get(browse_dirs))
        .route("/api/ssh", get(get_ssh_config).put(save_ssh_config).delete(clear_ssh_config))
        .route("/api/ssh/test", post(test_ssh_config))
        .route("/ws/{id}", get(ws_handler))
        .fallback_service(ServeDir::new(&web_dir).fallback(ServeFile::new(index)))
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind failed");
    eprintln!("pi-web listening on http://{addr}");
    axum::serve(listener, app).await.unwrap();
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
        let mut remote_cmd = format!(
            "cd {} && exec {} --mode rpc",
            shell_quote(cwd.to_str().expect("project path must be valid UTF-8")),
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
            .stderr(Stdio::inherit())
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
            .stderr(Stdio::inherit());
        cmd.spawn().expect("failed to spawn pi — is it on PATH? (override with --pi-bin)")
    }
}

fn spawn_process(state: Arc<AppState>, id: String, entry: Arc<ProjectEntry>, ssh: SshConfig) -> Arc<RunningProcess> {
    let mut child = spawn_child(&state.cfg, &ssh, &entry.path);
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");

    let (to_pi, mut to_pi_rx) = mpsc::channel::<String>(64);
    let (from_pi, _) = broadcast::channel::<String>(1024);
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

    // Built up front (rather than at the end) so the watcher task below can
    // compare identity against it — see the Arc::ptr_eq comment there.
    let proc = Arc::new(RunningProcess { to_pi: to_pi.clone(), from_pi: from_pi.clone(), kill_tx });

    // pi stdout -> broadcast to this project's clients, also peeked for
    // the get_session_stats probe response.
    let from_pi_tx = from_pi.clone();
    let entry_for_probe = entry.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            learn_session_dir(&entry_for_probe, &line).await;
            let _ = from_pi_tx.send(line);
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
    // asks us to kill it. Either way, drop this project out of `running` —
    // but only if `running` still points at *this* process. A respawn (e.g.
    // from an SSH config change) inserts the new process under the same id
    // before killing this one, so by the time this task's kill/wait
    // resolves, the map may already hold a newer, unrelated process for
    // `id_for_exit`; removing unconditionally would leak that one.
    let id_for_exit = id.clone();
    let proc_for_exit = proc.clone();
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                eprintln!("pi exited for project {id_for_exit}: {status:?}");
            }
            _ = kill_rx.recv() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        let mut running = state.running.write().await;
        if let Some(current) = running.get(&id_for_exit) {
            if Arc::ptr_eq(current, &proc_for_exit) {
                running.remove(&id_for_exit);
            }
        }
    });

    proc
}

/// Returns the running process for a project, spawning (or respawning, if
/// it previously died) one on demand. `None` only if `id` isn't a known
/// project at all.
async fn ensure_running(state: &Arc<AppState>, id: &str) -> Option<Arc<RunningProcess>> {
    if let Some(p) = state.running.read().await.get(id) {
        return Some(p.clone());
    }
    let entry = state.projects.read().await.get(id)?.clone();
    let ssh = state.ssh.read().await.clone();
    let mut running = state.running.write().await;
    if let Some(p) = running.get(id) {
        return Some(p.clone());
    }
    let proc = spawn_process(state.clone(), id.to_string(), entry, ssh);
    running.insert(id.to_string(), proc.clone());
    Some(proc)
}

/// Kills and respawns one project's pi process against the current SSH
/// target, inserting the new process into `running` before signalling the
/// old one to exit — the `Arc::ptr_eq` guard in `spawn_process`'s watcher
/// task is what makes this ordering safe (see its comment).
async fn respawn_project(state: &Arc<AppState>, id: &str) {
    let Some(entry) = state.projects.read().await.get(id).cloned() else { return };
    let ssh = state.ssh.read().await.clone();
    let old = {
        let mut running = state.running.write().await;
        let old = running.remove(id);
        let new_proc = spawn_process(state.clone(), id.to_string(), entry, ssh);
        running.insert(id.to_string(), new_proc);
        old
    };
    if let Some(old) = old {
        let _ = old.kill_tx.send(()).await;
    }
}

/// Respawns every known project's pi process, e.g. after the SSH target
/// changes.
async fn respawn_all(state: &Arc<AppState>) {
    let ids: Vec<String> = state.projects.read().await.keys().cloned().collect();
    for id in ids {
        respawn_project(state, &id).await;
    }
}

async fn learn_session_dir(entry: &Arc<ProjectEntry>, line: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
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

async fn ws_handler(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let proc = ensure_running(&state, &id).await.ok_or(StatusCode::NOT_FOUND)?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, proc)))
}

async fn handle_socket(mut socket: WebSocket, proc: Arc<RunningProcess>) {
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
    ensure_running(&state, &id).await;

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
/// render suggestions as the user types.
async fn browse_dirs(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<BrowseDirsQuery>,
) -> Json<Vec<String>> {
    if state.ssh.read().await.host.is_some() {
        return Json(vec![]);
    }
    let input = q.path.replace('\\', "/");
    let (dir, prefix) = match input.rfind('/') {
        Some(idx) => (&input[..=idx], &input[idx + 1..]),
        None => ("", input.as_str()),
    };
    let dir_path = if dir.is_empty() { PathBuf::from(".") } else { PathBuf::from(dir) };

    let mut entries = match tokio::fs::read_dir(&dir_path).await {
        Ok(rd) => rd,
        Err(_) => return Json(vec![]),
    };
    let prefix_lower = prefix.to_lowercase();
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(meta) = entry.metadata().await else { continue };
        if !meta.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.to_lowercase().starts_with(&prefix_lower) {
            names.push(name);
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    names.truncate(50);
    let full = names
        .into_iter()
        .map(|n| format!("{dir}{n}"))
        .collect();
    Json(full)
}

async fn remove_project(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> StatusCode {
    let existed = state.projects.write().await.remove(&id).is_some();
    if !existed {
        return StatusCode::NOT_FOUND;
    }
    if let Some(p) = state.running.write().await.remove(&id) {
        let _ = p.kill_tx.send(()).await;
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

// ---- chat history (sessions) REST API -----------------------------------

#[derive(Serialize)]
struct SessionView {
    path: String,
    title: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u128,
}

/// Lists `session_dir` on this machine's filesystem. In `--ssh` mode
/// `session_dir` is learned from the remote pi process's own
/// `get_session_stats` response, so it's a path on the *remote* host —
/// `read_dir` on it here will simply fail and this degrades to an empty
/// list rather than erroring. Browsing chat history isn't supported over
/// SSH relay yet.
async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<SessionView>>, StatusCode> {
    let entry = state.projects.read().await.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let session_dir = entry.session_dir.lock().await.clone();
    let Some(session_dir) = session_dir else {
        return Ok(Json(Vec::new()));
    };

    let Ok(mut dir_entries) = tokio::fs::read_dir(&session_dir).await else {
        return Ok(Json(Vec::new()));
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
    sessions.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(Json(sessions))
}

/// Best-effort chat title: the first user message's text, truncated. Falls
/// back to the filename (via the caller) if the file is empty, unreadable,
/// or doesn't look like a pi session in the expected shape.
async fn session_title(path: &FsPath) -> Option<String> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut lines = BufReader::new(file).lines();
    let mut scanned = 0;
    while scanned < 50 {
        let Ok(Some(line)) = lines.next_line().await else { break };
        scanned += 1;
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
            .and_then(|b| b.get("text"))
            .and_then(|t| t.as_str());
        let Some(text) = text else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let truncated: String = trimmed.chars().take(60).collect();
        return Some(if trimmed.chars().count() > 60 { format!("{truncated}…") } else { truncated });
    }
    None
}
