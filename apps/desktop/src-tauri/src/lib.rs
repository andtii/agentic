//! Agentic desktop shell (docs/architecture.md §13). One window on the
//! configured Agentic server, a tray, and nothing else: the web app runs
//! unchanged on its own origin. The server is the node the app runs itself
//! (`node.rs`, #991) unless a remote server is configured.

mod deeplink;
mod machine;
mod node;
mod notify;
mod quick;
mod server;
mod tray;
mod updater;

use server::Navigation;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

pub const MAIN: &str = "main";

/// The configured server, shared with the navigation handlers.
#[derive(Clone, Default)]
pub struct Server {
    origin: Arc<Mutex<Option<String>>>,
    /// The origin the remote capability was granted to. Capabilities can be
    /// added at runtime but not removed, so changing the server afterwards
    /// restarts the app instead of leaving the old origin granted.
    granted: Arc<Mutex<Option<String>>>,
    /// An `agentic://` link's path waiting for the connect page to open it (#847).
    pending: Arc<Mutex<Option<String>>>,
}

impl Server {
    pub fn get(&self) -> Option<String> {
        self.origin.lock().unwrap().clone()
    }
}

/// The node this build carries, if any (#991).
struct Bundled(Option<node::Bundle>);

#[derive(serde::Serialize)]
struct LocalInfo {
    #[serde(flatten)]
    status: node::Status,
    /// The claim link while nobody owns the node, handed over once.
    claim: Option<String>,
}

#[derive(serde::Serialize)]
struct ServerInfo {
    server: Option<String>,
    suggested: Option<String>,
    /// Where to go once connected: a deep link's path, handed over once. `None` is the server's root.
    path: Option<String>,
    /// The app's own node, while it runs (or failed to): the connect page waits for it instead of `server`.
    local: Option<LocalInfo>,
    /// Whether this build carries a node, so the setup form can offer it.
    bundled: bool,
}

#[tauri::command]
fn get_server(state: State<'_, Server>, local: State<'_, node::LocalNode>, bundled: State<'_, Bundled>) -> ServerInfo {
    let status = local.status();
    let local = (status != node::Status::Off).then(|| LocalInfo {
        claim: matches!(status, node::Status::Ready { .. })
            .then(|| local.take_claim())
            .flatten(),
        status,
    });
    ServerInfo {
        server: state.get(),
        suggested: server::build_default(),
        path: state.pending.lock().unwrap().take(),
        local,
        bundled: bundled.0.is_some(),
    }
}

/// Switches to the app's own node: starts it now, or restarts the app when another server's capability is granted.
#[tauri::command]
fn use_local(app: AppHandle, state: State<'_, Server>, bundled: State<'_, Bundled>) -> Result<(), String> {
    if bundled.0.is_none() {
        return Err("This build of the app has no local node.".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut settings = server::load(&dir);
    settings.local = true;
    settings.server = None;
    server::save(&dir, &settings).map_err(|e| e.to_string())?;
    if state.granted.lock().unwrap().is_some() && app.state::<node::LocalNode>().status() == node::Status::Off {
        app.request_restart();
    } else {
        start_local(&app);
    }
    Ok(())
}

/// Starts the bundled node; once it listens, its origin is the server and gets the capability.
fn start_local(app: &AppHandle) {
    let Some(bundle) = app.state::<Bundled>().0.clone() else {
        return;
    };
    let log = app.path().app_log_dir().ok().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir.join("node.log"))
    });
    let ready_app = app.clone();
    app.state::<node::LocalNode>().start(&bundle, log, move |origin| {
        let state = ready_app.state::<Server>().inner().clone();
        *state.origin.lock().unwrap() = Some(origin.to_string());
        let granted = state.granted.lock().unwrap().clone();
        if granted.is_none() {
            if let Err(e) = grant(&ready_app, &state, origin) {
                eprintln!("[agentic-desktop] could not grant the local node: {e}");
            }
        }
    });
}

/// Stores a new server and returns its normalized origin; the connect page
/// then navigates there.
#[tauri::command]
fn set_server(app: AppHandle, state: State<'_, Server>, url: String) -> Result<String, String> {
    let origin = server::normalize_server(&url)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut settings = server::load(&dir);
    settings.server = Some(origin.clone());
    settings.local = false;
    server::save(&dir, &settings).map_err(|e| e.to_string())?;
    *state.origin.lock().unwrap() = Some(origin.clone());
    // The app's own node stops with a restart, which comes back on the new server.
    if app.state::<node::LocalNode>().status() != node::Status::Off {
        app.request_restart();
        return Ok(origin);
    }
    let granted = state.granted.lock().unwrap().clone();
    match granted {
        Some(ref g) if *g == origin => {}
        Some(_) => app.request_restart(),
        None => grant(&app, &state, &origin)?,
    }
    Ok(origin)
}

/// The commands the server's pages may call (architecture §13).
const REMOTE_PERMISSIONS: &[&str] = &[
    "allow-notify",
    "allow-set-badge",
    "allow-local-machine",
    "allow-open-main",
    "allow-hide-quick",
];

fn grant(app: &AppHandle, state: &Server, origin: &str) -> Result<(), String> {
    let mut capability = tauri::ipc::CapabilityBuilder::new("server")
        .remote(server::remote_pattern(origin))
        .local(false)
        .windows([MAIN, quick::QUICK]);
    for permission in REMOTE_PERMISSIONS {
        capability = capability.permission(*permission);
    }
    app.add_capability(capability).map_err(|e| e.to_string())?;
    *state.granted.lock().unwrap() = Some(origin.to_string());
    Ok(())
}

/// The app's own connect page (`ui/index.html`), at the scheme this platform
/// serves local assets from.
pub fn local_url(query: &str) -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    let mut url = Url::parse(base).expect("local url");
    if !query.is_empty() {
        url.set_query(Some(query));
    }
    url
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Goes back through the connect page, which probes the server first, so an
/// unreachable server shows the app's offline page instead of a webview error.
pub fn reconnect(app: &AppHandle, query: &str) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.navigate(local_url(query));
    }
    show_main(app);
}

fn open_external(app: &AppHandle, url: &Url) {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

static WINDOWS: AtomicUsize = AtomicUsize::new(0);

/// What a window is: the main one, a page the server opened with `window.open`, or the quick-ask window (#849).
pub enum WindowKind {
    Main,
    Popup(NewWindowFeatures),
    Quick,
}

pub fn build_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    kind: WindowKind,
) -> tauri::Result<tauri::WebviewWindow> {
    let state = app.state::<Server>().inner().clone();
    let nav_app = app.clone();
    let nav_state = state.clone();
    let new_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title("Agentic")
        .on_navigation(move |url| {
            let decision = server::navigation(url, nav_state.get().as_deref());
            #[cfg(debug_assertions)]
            eprintln!("[agentic-desktop] navigate {url} -> {decision:?}");
            match decision {
                Navigation::Stay => true,
                Navigation::External => {
                    open_external(&nav_app, url);
                    false
                }
                Navigation::Block => false,
            }
        })
        .on_new_window(
            move |url, features| match server::new_window(&url, state.get().as_deref()) {
                Navigation::Stay => {
                    let label = format!("page-{}", WINDOWS.fetch_add(1, Ordering::Relaxed));
                    let target = WebviewUrl::External("about:blank".parse().unwrap());
                    match build_window(&new_app, &label, target, WindowKind::Popup(features)) {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(_) => NewWindowResponse::Deny,
                    }
                }
                Navigation::External => {
                    open_external(&new_app, &url);
                    NewWindowResponse::Deny
                }
                Navigation::Block => NewWindowResponse::Deny,
            },
        );
    match kind {
        WindowKind::Popup(features) => builder.window_features(features),
        WindowKind::Main => builder.inner_size(1280.0, 820.0).min_inner_size(400.0, 560.0),
        WindowKind::Quick => builder
            .inner_size(640.0, 300.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center(),
    }
    .build()
}

pub fn run() {
    let context = tauri::generate_context!();
    let updates = updater::configured(context.config());
    let mut builder = tauri::Builder::default();
    if updates {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    quick::toggle(app);
                }
            })
            .build(),
    );
    builder
        // First, so a second launch exits before it builds anything.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .manage(Server::default())
        .manage(node::LocalNode::default())
        .invoke_handler(tauri::generate_handler![
            get_server,
            set_server,
            use_local,
            notify::notify,
            notify::set_badge,
            machine::local_machine,
            quick::open_main,
            quick::hide_quick
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Server>().inner().clone();
            let config_dir = app.path().app_config_dir()?;
            let mut settings = server::load(&config_dir);
            let quick_ask = settings.quick_ask.clone();
            let exe_dir = std::env::current_exe()?.parent().map(std::path::Path::to_path_buf);
            let resource_dir = app.path().resource_dir().ok();
            let bundled = exe_dir.zip(resource_dir).and_then(|(exe, res)| node::find(&exe, &res));
            // First run of a build with a node: that node is the server (#991).
            if bundled.is_some() && settings.server.is_none() && !settings.local {
                settings.local = true;
                let _ = server::save(&config_dir, &settings);
            }
            let local = bundled.is_some() && settings.local;
            app.manage(Bundled(bundled));
            if local {
                start_local(&handle);
            } else if let Some(origin) = settings.server {
                *state.origin.lock().unwrap() = Some(origin.clone());
                grant(&handle, &state, &origin)?;
            }
            build_window(&handle, MAIN, WebviewUrl::App("index.html".into()), WindowKind::Main)?;
            // The tray shows the hotkey as on only when it actually registered (another app may hold it).
            let active = quick_ask.filter(|shortcut| quick::apply(&handle, Some(shortcut)));
            tray::build(&handle, active.as_deref())?;
            updater::start(&handle);
            // `agentic://` links (#847): the one that started the app, then each one while it runs
            // (a second launch hands its link over through single-instance).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installers register the scheme; this also covers an AppImage or a dev build.
                #[cfg(any(windows, target_os = "linux"))]
                let _ = handle.deep_link().register_all();
                if let Ok(Some(links)) = handle.deep_link().get_current() {
                    if let Some(path) = links.iter().find_map(deeplink::route) {
                        *state.pending.lock().unwrap() = Some(path);
                    }
                }
                let links_app = handle.clone();
                handle.deep_link().on_open_url(move |event| {
                    if let Some(link) = event.urls().first() {
                        deeplink::open(&links_app, link);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window hides it: the page's live connection
            // keeps running in the tray. Quit is in the tray menu. The
            // quick-ask window hides too, and whenever it loses the focus.
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN || window.label() == quick::QUICK => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(false) if window.label() == quick::QUICK => {
                let _ = window.hide();
            }
            _ => {}
        })
        .build(context)
        .expect("error while building the Agentic desktop app")
        .run(|app, event| match event {
            // Quit (or a restart): the node drains before the app goes (#991).
            RunEvent::Exit => {
                for window in app.webview_windows().values() {
                    let _ = window.hide();
                }
                app.state::<node::LocalNode>().stop(node::STOP_TIMEOUT);
            }
            // macOS: clicking the dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
