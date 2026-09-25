//! Agentic desktop shell (docs/architecture.md §13). One window on the
//! configured Agentic server, a tray, and nothing else: the web app runs
//! unchanged on its own origin.

mod deeplink;
mod machine;
mod notify;
mod server;
mod tray;
mod updater;

use server::Navigation;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
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

#[derive(serde::Serialize)]
struct ServerInfo {
    server: Option<String>,
    suggested: Option<String>,
    /// Where to go once connected: a deep link's path, handed over once. `None` is the server's root.
    path: Option<String>,
}

#[tauri::command]
fn get_server(state: State<'_, Server>) -> ServerInfo {
    ServerInfo {
        server: state.get(),
        suggested: server::build_default(),
        path: state.pending.lock().unwrap().take(),
    }
}

/// Stores a new server and returns its normalized origin; the connect page
/// then navigates there.
#[tauri::command]
fn set_server(app: AppHandle, state: State<'_, Server>, url: String) -> Result<String, String> {
    let origin = server::normalize_server(&url)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    server::save(
        &dir,
        &server::Settings {
            server: Some(origin.clone()),
        },
    )
    .map_err(|e| e.to_string())?;
    *state.origin.lock().unwrap() = Some(origin.clone());
    let granted = state.granted.lock().unwrap().clone();
    match granted {
        Some(ref g) if *g == origin => {}
        Some(_) => app.request_restart(),
        None => grant(&app, &state, &origin)?,
    }
    Ok(origin)
}

/// The commands the server's pages may call (architecture §13).
const REMOTE_PERMISSIONS: &[&str] = &["allow-notify", "allow-set-badge", "allow-local-machine"];

fn grant(app: &AppHandle, state: &Server, origin: &str) -> Result<(), String> {
    let mut capability = tauri::ipc::CapabilityBuilder::new("server")
        .remote(server::remote_pattern(origin))
        .local(false)
        .window(MAIN);
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

fn build_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    features: Option<NewWindowFeatures>,
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
                    match build_window(&new_app, &label, target, Some(features)) {
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
    match features {
        Some(features) => builder.window_features(features),
        None => builder.inner_size(1280.0, 820.0).min_inner_size(400.0, 560.0),
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
        .invoke_handler(tauri::generate_handler![
            get_server,
            set_server,
            notify::notify,
            notify::set_badge,
            machine::local_machine
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Server>().inner().clone();
            let settings = server::load(&app.path().app_config_dir()?);
            if let Some(origin) = settings.server {
                *state.origin.lock().unwrap() = Some(origin.clone());
                grant(&handle, &state, &origin)?;
            }
            build_window(&handle, MAIN, WebviewUrl::App("index.html".into()), None)?;
            tray::build(&handle)?;
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
        .on_window_event(|window, event| {
            // Closing the main window hides it: the page's live connection
            // keeps running in the tray. Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("error while building the Agentic desktop app")
        .run(|_app, _event| {
            // macOS: clicking the dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
