//! The local agentic node (#991): the app runs `agentic start` itself, so it
//! works with no server anywhere. The sidecar `agentic-node` is a Node
//! single-executable build (`scripts/sidecar.mjs`) that loads the node's files
//! from the app's resources (`<resources>/node/launch.cjs`, handed over as
//! `AGENTIC_NODE_APP`). The node keeps its data where `agentic start` does
//! (`$AGENTIC_HOME`, default `~/.agentic`), so the CLI and the app are the
//! same node.
//!
//! The app learns the node's origin and its claim link from the lines
//! `agentic start` prints. Quitting closes the node's stdin, which
//! `launch.cjs` turns into the node's own SIGTERM shutdown: the daemon stops,
//! the host drains, the database closes. A crash of the app closes the pipe
//! too, so the node never outlives it.

use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::Url;

/// The sidecar's name beside the app's executable (Tauri strips the target triple when it bundles it).
pub const SIDECAR: &str = "agentic-node";
/// The node's files under the app's resource directory.
pub const RESOURCES: &str = "node";
/// What the sidecar runs from `RESOURCES`.
pub const LAUNCHER: &str = "launch.cjs";
/// The node itself waits up to 10 s for the daemon and 20 s for in-flight turns.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(40);

pub fn sidecar_file() -> String {
    format!("{SIDECAR}{}", std::env::consts::EXE_SUFFIX)
}

/// A bundled node: the sidecar and its files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bundle {
    pub exe: PathBuf,
    pub app: PathBuf,
}

/// The bundled node, when this build carries one (a plain `cargo build` does not).
pub fn find(exe_dir: &Path, resource_dir: &Path) -> Option<Bundle> {
    let exe = plain(&exe_dir.join(sidecar_file()));
    let app = plain(&resource_dir.join(RESOURCES));
    (exe.is_file() && app.join(LAUNCHER).is_file()).then_some(Bundle { exe, app })
}

/// Drops Windows' verbatim prefix (`\\?\C:\…` → `C:\…`), which the resource dir comes with: Node's
/// module resolution can't walk it (`EISDIR: lstat 'C:'`). UNC (`\\?\UNC\…`) paths are left alone.
pub fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// What a line of `agentic start`'s output says (apps/node/src/start.ts).
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// `[node] agentic on <origin> — data in <dir>`: listening.
    Origin(String),
    /// `[node] claim this node (once, within 24 h): <link>`: nobody owns it yet.
    Claim(String),
    /// `[node] sign in: <link>`: it is claimed.
    SignIn,
}

pub fn parse_line(line: &str) -> Option<Line> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("[node] agentic on ") {
        let origin = rest.split_whitespace().next()?;
        return crate::server::normalize_server(origin).ok().map(Line::Origin);
    }
    if line.starts_with("[node] claim this node") {
        let (_, link) = line.split_once("): ")?;
        return Some(Line::Claim(link.trim().to_string()));
    }
    line.starts_with("[node] sign in: ").then_some(Line::SignIn)
}

/// Follows the output until the node is ready: its origin, and the claim link when it has one on that origin.
#[derive(Default)]
pub struct Tracker {
    origin: Option<String>,
}

impl Tracker {
    pub fn feed(&mut self, line: &str) -> Option<(String, Option<String>)> {
        match parse_line(line)? {
            Line::Origin(origin) => {
                self.origin = Some(origin);
                None
            }
            Line::Claim(link) => {
                let origin = self.origin.clone()?;
                let same = Url::parse(&link).is_ok_and(|u| u.origin().ascii_serialization() == origin);
                Some((origin, same.then_some(link)))
            }
            Line::SignIn => self.origin.clone().map(|origin| (origin, None)),
        }
    }
}

/// Where the local node is, for the connect page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Status {
    /// Not started (no bundled node, or a remote server is configured).
    Off,
    Starting,
    Ready {
        origin: String,
    },
    Failed {
        error: String,
    },
}

#[derive(Default)]
struct Inner {
    status: Option<Status>,
    claim: Option<String>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    output: Output,
}

/// What the node printed that explains a failed start: its first error line, else its last line.
#[derive(Default)]
pub struct Output {
    error: Option<String>,
    last: Option<String>,
}

impl Output {
    pub fn push(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if self.error.is_none() && (line.starts_with("Error") || line.contains("Error:") || line.starts_with("error")) {
            self.error = Some(line.to_string());
        }
        self.last = Some(line.to_string());
    }

    /// Why the node ended before it was ready.
    pub fn failure(&self) -> String {
        self.error
            .clone()
            .or_else(|| self.last.clone())
            .unwrap_or_else(|| "The local node stopped.".into())
    }
}

/// The running node, shared with the commands and the exit handler.
#[derive(Clone, Default)]
pub struct LocalNode {
    inner: Arc<Mutex<Inner>>,
}

fn remember(inner: &Mutex<Inner>, log: &Mutex<Option<File>>, line: &str) {
    if let Some(file) = log.lock().unwrap().as_mut() {
        let _ = writeln!(file, "{line}");
    }
    inner.lock().unwrap().output.push(line);
}

impl LocalNode {
    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone().unwrap_or(Status::Off)
    }

    /// The claim link, handed to the connect page once.
    pub fn take_claim(&self) -> Option<String> {
        self.inner.lock().unwrap().claim.take()
    }

    /// Starts the node unless it runs already. `ready` gets its origin once it listens.
    pub fn start<F>(&self, bundle: &Bundle, log: Option<PathBuf>, ready: F)
    where
        F: FnOnce(&str) + Send + 'static,
    {
        let mut inner = self.inner.lock().unwrap();
        if matches!(inner.status, Some(Status::Starting | Status::Ready { .. })) {
            return;
        }
        let mut command = Command::new(&bundle.exe);
        command
            .args(["start", "--no-open"])
            .env("AGENTIC_NODE_APP", &bundle.app)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                inner.status = Some(Status::Failed {
                    error: format!("The local node did not start: {e}"),
                });
                return;
            }
        };
        let log = Arc::new(Mutex::new(log.and_then(|path| File::create(path).ok())));
        inner.stdin = child.stdin.take();
        inner.status = Some(Status::Starting);
        inner.claim = None;
        inner.output = Output::default();
        if let Some(stderr) = child.stderr.take() {
            let (state, log) = (self.inner.clone(), log.clone());
            std::thread::spawn(move || {
                for line in lines(stderr) {
                    remember(&state, &log, &line);
                }
            });
        }
        if let Some(stdout) = child.stdout.take() {
            let state = self.inner.clone();
            std::thread::spawn(move || {
                let mut tracker = Tracker::default();
                let mut ready = Some(ready);
                for line in lines(stdout) {
                    remember(&state, &log, &line);
                    if let Some((origin, claim)) = tracker.feed(&line) {
                        if let Some(ready) = ready.take() {
                            {
                                let mut inner = state.lock().unwrap();
                                inner.claim = claim;
                                inner.status = Some(Status::Ready { origin: origin.clone() });
                            }
                            ready(&origin);
                        }
                    }
                }
                // The output ended: the node exited (or is exiting).
                let mut inner = state.lock().unwrap();
                let error = match inner.status {
                    Some(Status::Starting) => inner.output.failure(),
                    _ => "The local node stopped.".into(),
                };
                inner.status = Some(Status::Failed { error });
            });
        }
        inner.child = Some(child);
    }

    /// Asks the node to drain and waits for it, then kills what is left after `timeout`.
    pub fn stop(&self, timeout: Duration) {
        let child = {
            let mut inner = self.inner.lock().unwrap();
            // Closing stdin is the stop signal (launch.cjs).
            inner.stdin.take();
            inner.child.take()
        };
        let Some(mut child) = child else { return };
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    }
}

/// Lines of a pipe, lossy UTF-8, until it closes.
fn lines(pipe: impl Read) -> impl Iterator<Item = String> {
    let mut reader = BufReader::new(pipe);
    std::iter::from_fn(move || {
        let mut buf = Vec::new();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(String::from_utf8_lossy(&buf).trim_end().to_string()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_agentic_start_prints() {
        assert_eq!(
            parse_line("[node] agentic on http://localhost:8787 — data in C:\\Users\\a\\.agentic"),
            Some(Line::Origin("http://localhost:8787".into()))
        );
        assert_eq!(
            parse_line("[node] claim this node (once, within 24 h): http://localhost:8787/auth/claim?t=a%2Bb"),
            Some(Line::Claim("http://localhost:8787/auth/claim?t=a%2Bb".into()))
        );
        assert_eq!(
            parse_line("[node] sign in: http://localhost:8787/auth/local-login"),
            Some(Line::SignIn)
        );
        assert_eq!(parse_line("[node] generated SESSION_SECRET in /x/.env"), None);
        assert_eq!(parse_line("something else"), None);
        // An origin the app would never load: plain http off loopback.
        assert_eq!(parse_line("[node] agentic on http://a.example — data in /x"), None);
    }

    #[test]
    fn ready_once_the_origin_and_the_owner_line_are_in() {
        let mut t = Tracker::default();
        assert_eq!(
            t.feed("[node] claim this node (once, within 24 h): http://localhost:8787/c"),
            None
        );
        assert_eq!(t.feed("[node] agentic on http://localhost:8787 — data in /x"), None);
        assert_eq!(
            t.feed("[node] claim this node (once, within 24 h): http://localhost:8787/auth/claim?t=1"),
            Some((
                "http://localhost:8787".into(),
                Some("http://localhost:8787/auth/claim?t=1".into())
            ))
        );

        let mut t = Tracker::default();
        t.feed("[node] agentic on http://localhost:9000 — data in /x");
        assert_eq!(
            t.feed("[node] sign in: http://localhost:9000/auth/local-login"),
            Some(("http://localhost:9000".into(), None))
        );
    }

    #[test]
    fn a_claim_link_elsewhere_is_dropped() {
        let mut t = Tracker::default();
        t.feed("[node] agentic on http://localhost:8787 — data in /x");
        assert_eq!(
            t.feed("[node] claim this node (once, within 24 h): https://evil.example/auth/claim?t=1"),
            Some(("http://localhost:8787".into(), None))
        );
    }

    #[test]
    fn a_failure_names_the_error() {
        let mut output = Output::default();
        for line in [
            "[node] generated SESSION_SECRET in /x/.env",
            "Error: listen EADDRINUSE: address already in use :::8787",
            "    at Server.setupListenHandle",
            "  code: 'EADDRINUSE',",
            "Node.js v22.22.0",
        ] {
            output.push(line);
        }
        assert_eq!(
            output.failure(),
            "Error: listen EADDRINUSE: address already in use :::8787"
        );
        let mut output = Output::default();
        output.push("[node] something");
        output.push("");
        assert_eq!(output.failure(), "[node] something");
        assert_eq!(Output::default().failure(), "The local node stopped.");
    }

    #[test]
    fn finds_a_bundled_node_only() {
        let dir = std::env::temp_dir().join(format!("agentic-node-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(RESOURCES)).unwrap();
        assert_eq!(find(&dir, &dir), None);
        std::fs::write(dir.join(sidecar_file()), b"").unwrap();
        assert_eq!(find(&dir, &dir), None);
        std::fs::write(dir.join(RESOURCES).join(LAUNCHER), b"").unwrap();
        assert_eq!(
            find(&dir, &dir),
            Some(Bundle {
                exe: dir.join(sidecar_file()),
                app: dir.join(RESOURCES)
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verbatim_windows_paths_become_plain() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\Program Files\Agentic\node")),
            PathBuf::from(r"C:\Program Files\Agentic\node")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\host\share\node")),
            PathBuf::from(r"\\?\UNC\host\share\node")
        );
        assert_eq!(
            plain(Path::new("/opt/agentic/node")),
            PathBuf::from("/opt/agentic/node")
        );
    }

    #[test]
    fn status_serializes_for_the_page() {
        assert_eq!(serde_json::to_string(&Status::Off).unwrap(), r#"{"status":"off"}"#);
        assert_eq!(
            serde_json::to_string(&Status::Ready {
                origin: "http://localhost:8787".into()
            })
            .unwrap(),
            r#"{"status":"ready","origin":"http://localhost:8787"}"#
        );
    }

    #[test]
    fn stopping_nothing_returns() {
        LocalNode::default().stop(Duration::from_millis(10));
        assert_eq!(LocalNode::default().status(), Status::Off);
    }
}
