//! Minimal bridge between a `pi --mode rpc` child process and browser clients.
//!
//! pi speaks newline-delimited JSON on stdin/stdout. This server pipes those
//! lines verbatim to/from WebSocket clients at /ws and serves the built
//! frontend from web/dist. It does not parse the protocol at all — the
//! browser speaks pi RPC directly.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use std::{path::PathBuf, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc},
};
use tower_http::services::{ServeDir, ServeFile};

struct AppState {
    to_pi: mpsc::Sender<String>,
    from_pi: broadcast::Sender<String>,
}

struct Config {
    port: u16,
    cwd: PathBuf,
    pi_bin: String,
    web_dir: PathBuf,
    pi_args: Vec<String>,
}

fn parse_args() -> Config {
    let mut cfg = Config {
        port: 3210,
        cwd: PathBuf::from("."),
        pi_bin: "pi".into(),
        web_dir: PathBuf::from("web/dist"),
        pi_args: Vec::new(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => cfg.port = args.next().expect("--port needs a value").parse().expect("invalid port"),
            "--cwd" => cfg.cwd = args.next().expect("--cwd needs a value").into(),
            "--pi-bin" => cfg.pi_bin = args.next().expect("--pi-bin needs a value"),
            "--web-dir" => cfg.web_dir = args.next().expect("--web-dir needs a value").into(),
            "--" => {
                cfg.pi_args = args.collect();
                break;
            }
            other => {
                eprintln!("unknown argument: {other}");
                eprintln!("usage: pi-web-server [--port N] [--cwd DIR] [--pi-bin PATH] [--web-dir DIR] [-- <extra pi args>]");
                std::process::exit(2);
            }
        }
    }
    cfg
}

#[tokio::main]
async fn main() {
    let cfg = parse_args();

    // Windows installs pi as a .cmd shim, which can only be spawned via cmd.exe.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&cfg.pi_bin);
        c
    } else {
        Command::new(&cfg.pi_bin)
    };
    let mut child = cmd
        .arg("--mode")
        .arg("rpc")
        .args(&cfg.pi_args)
        .current_dir(&cfg.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn pi — is it on PATH? (override with --pi-bin)");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    let (to_pi, mut to_pi_rx) = mpsc::channel::<String>(64);
    let (from_pi, _) = broadcast::channel::<String>(1024);

    // pi stdout -> broadcast to all connected clients
    let from_pi_tx = from_pi.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
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

    // if pi dies, there is nothing left to serve
    tokio::spawn(async move {
        let status = child.wait().await;
        eprintln!("pi exited: {status:?}");
        std::process::exit(1);
    });

    let state = Arc::new(AppState { to_pi, from_pi });
    let index = cfg.web_dir.join("index.html");
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&cfg.web_dir).fallback(ServeFile::new(index)))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind failed");
    eprintln!("pi-web listening on http://{addr}");
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut from_pi = state.from_pi.subscribe();
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
                    if state.to_pi.send(text.to_string()).await.is_err() {
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
