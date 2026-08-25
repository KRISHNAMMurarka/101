mod signaling;
mod storage;

use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};

use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Serialize;
use serde_json::Value;
use signaling::{ip_strings, router, ApiError, HttpState, SignalingBroker};
use storage::{
    list_game_packages_at, list_replays_at, load_settings, read_replay_at,
    register_game_package_at, save_replay_at, save_settings, validate_settings, AppPaths,
    HubSettings, InstalledGame, StoredReplay,
};
use tauri::async_runtime::JoinHandle;
use tauri::{Manager, State};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex as AsyncMutex},
};

struct RunningHub {
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
    mdns: Option<ServiceDaemon>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct HubStatus {
    running: bool,
    endpoint: String,
    addresses: Vec<String>,
    mdns: bool,
    session_count: usize,
    peer_count: usize,
    data_directory: String,
    launcher_url: String,
}

struct HubManager {
    broker: Arc<Mutex<SignalingBroker>>,
    settings: RwLock<HubSettings>,
    paths: AppPaths,
    status: RwLock<HubStatus>,
    running: AsyncMutex<Option<RunningHub>>,
}

impl HubManager {
    fn new(paths: AppPaths) -> Result<Self, String> {
        let settings = load_settings(&paths).map_err(display_error)?;
        Ok(Self {
            broker: Arc::new(Mutex::new(SignalingBroker::default())),
            status: RwLock::new(HubStatus {
                data_directory: paths.root.to_string_lossy().into_owned(),
                launcher_url: settings.launcher_url.clone(),
                ..HubStatus::default()
            }),
            settings: RwLock::new(settings),
            paths,
            running: AsyncMutex::new(None),
        })
    }

    async fn start(&self) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        let settings = self
            .settings
            .read()
            .map_err(|_| "Hub settings lock failed")?
            .clone();
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, settings.port))
            .await
            .map_err(|error| format!("Unable to bind 101 Hub port {}: {error}", settings.port))?;
        let addresses = local_addresses();
        let endpoint = format!("http://127.0.0.1:{}", settings.port);
        let mdns = if settings.advertise_mdns {
            match advertise(&settings, &addresses) {
                Ok(daemon) => Some(daemon),
                Err(error) => {
                    eprintln!("101 Hub mDNS advertisement unavailable: {error}");
                    None
                }
            }
        } else {
            None
        };
        let mdns_active = mdns.is_some();
        let state = HttpState {
            broker: Arc::clone(&self.broker),
            endpoint: endpoint.clone(),
            addresses: addresses.clone(),
            mdns: mdns_active,
            paths: self.paths.clone(),
        };
        let (shutdown, receiver) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router(state))
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
            {
                eprintln!("101 Hub listener stopped: {error}");
            }
        });
        *self.status.write().map_err(|_| "Hub status lock failed")? = HubStatus {
            running: true,
            endpoint,
            addresses,
            mdns: mdns_active,
            session_count: 0,
            peer_count: 0,
            data_directory: self.paths.root.to_string_lossy().into_owned(),
            launcher_url: settings.launcher_url,
        };
        *running = Some(RunningHub {
            shutdown,
            task,
            mdns,
        });
        Ok(())
    }

    async fn stop(&self) {
        let Some(running) = self.running.lock().await.take() else {
            return;
        };
        let _ = running.shutdown.send(());
        let _ = running.task.await;
        if let Some(mdns) = running.mdns {
            let _ = mdns.shutdown();
        }
        if let Ok(mut status) = self.status.write() {
            status.running = false;
            status.mdns = false;
        }
    }

    async fn restart(&self) -> Result<(), String> {
        self.stop().await;
        self.start().await
    }

    fn status(&self) -> Result<HubStatus, String> {
        let mut status = self
            .status
            .read()
            .map_err(|_| "Hub status lock failed")?
            .clone();
        let (sessions, peers) = self
            .broker
            .lock()
            .map_err(|_| "Hub state lock failed")?
            .counts();
        status.session_count = sessions;
        status.peer_count = peers;
        Ok(status)
    }
}

#[tauri::command]
fn hub_status(manager: State<'_, Arc<HubManager>>) -> Result<HubStatus, String> {
    manager.status()
}

#[tauri::command]
fn get_settings(manager: State<'_, Arc<HubManager>>) -> Result<HubSettings, String> {
    manager
        .settings
        .read()
        .map(|value| value.clone())
        .map_err(|_| "Hub settings lock failed".into())
}

#[tauri::command]
async fn update_settings(
    settings: HubSettings,
    manager: State<'_, Arc<HubManager>>,
) -> Result<(), String> {
    validate_settings(&settings).map_err(display_error)?;
    let previous = manager
        .settings
        .read()
        .map_err(|_| "Hub settings lock failed")?
        .clone();
    save_settings(&manager.paths, &settings).map_err(display_error)?;
    *manager
        .settings
        .write()
        .map_err(|_| "Hub settings lock failed")? = settings;
    if let Err(error) = manager.restart().await {
        save_settings(&manager.paths, &previous).map_err(display_error)?;
        *manager
            .settings
            .write()
            .map_err(|_| "Hub settings lock failed")? = previous;
        manager.start().await.map_err(|rollback| {
            format!("{error}; restoring the previous Hub listener also failed: {rollback}")
        })?;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn open_launcher(
    session_id: Option<String>,
    host_token: Option<String>,
    manager: State<'_, Arc<HubManager>>,
) -> Result<(), String> {
    let settings = manager
        .settings
        .read()
        .map_err(|_| "Hub settings lock failed")?;
    validate_settings(&settings).map_err(display_error)?;
    let launcher = launcher_url(&settings, session_id.as_deref(), host_token.as_deref())?;
    open::that(launcher.as_str()).map_err(|error| format!("Unable to open launcher: {error}"))
}

fn launcher_url(
    settings: &HubSettings,
    session_id: Option<&str>,
    host_token: Option<&str>,
) -> Result<url::Url, String> {
    let mut launcher = url::Url::parse(&settings.launcher_url)
        .map_err(|_| "Launcher URL is invalid".to_owned())?;
    match (session_id, host_token) {
        (None, None) => Ok(launcher),
        (Some(session_id), Some(host_token)) => {
            if session_id.len() < 4
                || session_id.len() > 128
                || !session_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("Invalid launcher session id".into());
            }
            if host_token.len() < 32
                || host_token.len() > 256
                || !host_token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Err("Invalid launcher session authority".into());
            }
            let endpoint = format!("http://127.0.0.1:{}", settings.port);
            launcher
                .query_pairs_mut()
                .append_pair("session", session_id)
                .append_pair("hub", &endpoint);
            let fragment = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("101-host-session", session_id)
                .append_pair("101-host-token", host_token)
                .append_pair("101-host-hub", &endpoint)
                .finish();
            launcher.set_fragment(Some(&fragment));
            Ok(launcher)
        }
        _ => Err("Launcher session and authority must be provided together".into()),
    }
}

#[tauri::command]
fn list_replays(manager: State<'_, Arc<HubManager>>) -> Result<Vec<StoredReplay>, String> {
    list_replays_at(&manager.paths).map_err(display_error)
}

#[tauri::command]
fn save_replay(
    id: String,
    replay: Value,
    manager: State<'_, Arc<HubManager>>,
) -> Result<StoredReplay, String> {
    save_replay_at(&manager.paths, &id, replay).map_err(display_error)
}

#[tauri::command]
fn read_replay(id: String, manager: State<'_, Arc<HubManager>>) -> Result<Value, String> {
    read_replay_at(&manager.paths, &id).map_err(display_error)
}

#[tauri::command]
fn list_game_packages(manager: State<'_, Arc<HubManager>>) -> Result<Vec<InstalledGame>, String> {
    list_game_packages_at(&manager.paths).map_err(display_error)
}

#[tauri::command]
fn register_game_package(
    path: String,
    manager: State<'_, Arc<HubManager>>,
) -> Result<InstalledGame, String> {
    register_game_package_at(&manager.paths, &PathBuf::from(path)).map_err(display_error)
}

fn local_addresses() -> Vec<String> {
    let addresses: Vec<IpAddr> = if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .filter(|interface| !interface.is_loopback())
                .map(|interface| interface.ip())
                .filter(|address| address.is_ipv4())
                .collect()
        })
        .unwrap_or_default();
    let mut values = ip_strings(&addresses);
    values.sort();
    values.dedup();
    values
}

fn advertise(settings: &HubSettings, addresses: &[String]) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
    let ips: Vec<IpAddr> = addresses
        .iter()
        .filter_map(|value| value.parse().ok())
        .collect();
    if ips.is_empty() {
        return Err("No LAN interface is available".into());
    }
    let host = format!("{}.local.", sanitize_dns_label(&settings.host_name));
    let properties = [
        ("protocol", "2"),
        ("privacy", "local"),
        ("path", "/v1/health"),
    ];
    let service = ServiceInfo::new(
        "_oneohone._tcp.local.",
        &settings.host_name,
        &host,
        &ips[..],
        settings.port,
        &properties[..],
    )
    .map_err(|error| error.to_string())?
    .enable_addr_auto();
    daemon
        .register(service)
        .map_err(|error| error.to_string())?;
    Ok(daemon)
}

fn sanitize_dns_label(value: &str) -> String {
    let value: String = value
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    value
        .trim_matches('-')
        .chars()
        .take(48)
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
        .pipe(|value| {
            if value.is_empty() {
                "101-hub".into()
            } else {
                value
            }
        })
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

fn display_error(error: ApiError) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_session_authority_is_fragment_only_and_bound_to_its_session() {
        let settings = HubSettings::default();
        let token = "h".repeat(43);
        let launcher = launcher_url(&settings, Some("PLAY101"), Some(&token)).unwrap();
        let query = launcher.query().unwrap();
        assert!(query.contains("session=PLAY101"));
        assert!(query.contains("hub=http%3A%2F%2F127.0.0.1%3A10101"));
        assert!(!query.contains(&token));
        let fragment = launcher.fragment().unwrap();
        assert!(fragment.contains("101-host-session=PLAY101"));
        assert!(fragment.contains(&format!("101-host-token={token}")));
        assert!(fragment.contains("101-host-hub=http%3A%2F%2F127.0.0.1%3A10101"));
        assert!(!settings.launcher_url.contains(&token));

        assert!(launcher_url(&settings, Some("PLAY101"), None).is_err());
        assert!(launcher_url(&settings, Some("OTHER101"), Some("short")).is_err());
        assert!(launcher_url(&settings, Some("../PLAY101"), Some(&token)).is_err());
    }
}

pub fn run() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let paths = AppPaths::new(root).map_err(display_error)?;
            let manager = Arc::new(HubManager::new(paths)?);
            tauri::async_runtime::block_on(manager.start())?;
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hub_status,
            get_settings,
            update_settings,
            open_launcher,
            list_replays,
            save_replay,
            read_replay,
            list_game_packages,
            register_game_package,
        ])
        .build(tauri::generate_context!())
        .expect("error while building 101 Hub");

    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let manager = app.state::<Arc<HubManager>>();
            tauri::async_runtime::block_on(manager.stop());
        }
    });
}
