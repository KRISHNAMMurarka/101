use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkdir::WalkDir;

use crate::signaling::{validate_identifier, ApiError, ApiResult};

const MAX_GAME_BYTES: u64 = 250 * 1024 * 1024;
const MAX_GAME_FILES: usize = 20_000;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub settings: PathBuf,
    pub replays: PathBuf,
    pub games: PathBuf,
}

impl AppPaths {
    pub fn new(root: PathBuf) -> ApiResult<Self> {
        let paths = Self {
            settings: root.join("settings.json"),
            replays: root.join("replays"),
            games: root.join("games"),
            root,
        };
        fs::create_dir_all(&paths.replays).map_err(io_error)?;
        fs::create_dir_all(&paths.games).map_err(io_error)?;
        Ok(paths)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HubSettings {
    pub port: u16,
    pub advertise_mdns: bool,
    pub launcher_url: String,
    pub host_name: String,
}

impl Default for HubSettings {
    fn default() -> Self {
        Self {
            port: 10101,
            advertise_mdns: true,
            launcher_url: "http://127.0.0.1:3000".into(),
            host_name: default_host_name(),
        }
    }
}

pub fn load_settings(paths: &AppPaths) -> ApiResult<HubSettings> {
    if !paths.settings.exists() {
        return Ok(HubSettings::default());
    }
    let bytes = fs::read(&paths.settings).map_err(io_error)?;
    if bytes.len() > 64 * 1024 {
        return Err(ApiError::bad_request("Hub settings file is too large"));
    }
    let settings: HubSettings = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("Hub settings are malformed"))?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_settings(paths: &AppPaths, settings: &HubSettings) -> ApiResult<()> {
    validate_settings(settings)?;
    atomic_write(
        &paths.settings,
        &serde_json::to_vec_pretty(settings).map_err(json_error)?,
    )
}

pub fn validate_settings(settings: &HubSettings) -> ApiResult<()> {
    if settings.port < 1024 {
        return Err(ApiError::bad_request(
            "Hub port must be between 1024 and 65535",
        ));
    }
    let launcher = url::Url::parse(&settings.launcher_url)
        .map_err(|_| ApiError::bad_request("Launcher URL is invalid"))?;
    if !matches!(launcher.scheme(), "http" | "https")
        || launcher.host_str().is_none()
        || launcher.fragment().is_some()
    {
        return Err(ApiError::bad_request("Launcher URL must be HTTP or HTTPS"));
    }
    if settings.host_name.trim().is_empty() || settings.host_name.len() > 64 {
        return Err(ApiError::bad_request(
            "Computer name must be 1-64 characters",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredReplay {
    pub id: String,
    pub game_id: String,
    pub game_version: String,
    pub seed: String,
    pub saved_at: u64,
    pub expires_at: u64,
    pub generation: String,
    pub bytes: u64,
}

// Compatibility helpers own one temporary native store. Product commands retain one manager store.
pub fn save_replay_at(paths: &AppPaths, id: &str, replay: Value) -> ApiResult<StoredReplay> {
    crate::replay_storage::ReplayStore::open(paths)?.save(id, replay)
}
pub fn list_replays_at(paths: &AppPaths) -> ApiResult<Vec<StoredReplay>> {
    Ok(crate::replay_storage::ReplayStore::open(paths)?.catalog()?.records)
}
pub fn read_replay_at(paths: &AppPaths, id: &str) -> ApiResult<Value> {
    crate::replay_storage::ReplayStore::open(paths)?.read(id)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledGame {
    pub id: String,
    pub name: String,
    pub version: String,
    pub renderer: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
struct GameManifest {
    id: String,
    name: String,
    version: String,
    renderer: String,
    engine: Value,
    players: Value,
    inputs: Vec<String>,
    offline: bool,
    procedural: bool,
}

pub fn register_game_package_at(paths: &AppPaths, source: &Path) -> ApiResult<InstalledGame> {
    let source = source
        .canonicalize()
        .map_err(|_| ApiError::bad_request("Game package folder does not exist"))?;
    if !source.is_dir() {
        return Err(ApiError::bad_request("Game package must be a folder"));
    }
    let manifest = read_manifest(&source)?;
    validate_manifest(&manifest)?;
    let destination = paths.games.join(&manifest.id);
    if destination.exists() {
        return Err(ApiError::bad_request(
            "That game version is already installed; remove it explicitly before replacing files",
        ));
    }
    let staging = paths
        .games
        .join(format!(".install-{}", uuid::Uuid::new_v4()));
    let result = copy_package(&source, &staging)
        .and_then(|_| fs::rename(&staging, &destination).map_err(io_error));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;
    installed(&destination, manifest)
}

pub fn list_game_packages_at(paths: &AppPaths) -> ApiResult<Vec<InstalledGame>> {
    let mut games = Vec::new();
    for entry in fs::read_dir(&paths.games).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if !entry.path().is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(manifest) = read_manifest(&entry.path()) else {
            continue;
        };
        if validate_manifest(&manifest).is_ok() {
            games.push(installed(&entry.path(), manifest)?);
        }
    }
    games.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(games)
}

fn read_manifest(root: &Path) -> ApiResult<GameManifest> {
    let path = root.join("manifest.json");
    let bytes =
        fs::read(path).map_err(|_| ApiError::bad_request("Game package requires manifest.json"))?;
    if bytes.len() > 64 * 1024 {
        return Err(ApiError::bad_request("Game manifest is too large"));
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("Game manifest is malformed"))
}

fn validate_manifest(manifest: &GameManifest) -> ApiResult<()> {
    validate_identifier(&manifest.id, 64)?;
    if manifest.name.trim().is_empty()
        || manifest.name.len() > 128
        || manifest.version.is_empty()
        || manifest.version.len() > 64
    {
        return Err(ApiError::bad_request("Invalid game manifest identity"));
    }
    if !matches!(manifest.renderer.as_str(), "2d" | "3d" | "dom" | "hybrid") {
        return Err(ApiError::bad_request("Invalid game renderer"));
    }
    if manifest.engine.is_null()
        || !manifest.players.is_object()
        || manifest.inputs.is_empty()
        || !manifest.offline
        || !manifest.procedural
    {
        return Err(ApiError::bad_request(
            "Game package does not satisfy the 101 offline/procedural contract",
        ));
    }
    Ok(())
}

fn installed(path: &Path, manifest: GameManifest) -> ApiResult<InstalledGame> {
    Ok(InstalledGame {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        renderer: manifest.renderer,
        path: path.to_string_lossy().into_owned(),
    })
}

fn copy_package(source: &Path, destination: &Path) -> ApiResult<()> {
    fs::create_dir_all(destination).map_err(io_error)?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|_| ApiError::bad_request("Unable to read game package"))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| ApiError::bad_request("Invalid package path"))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(ApiError::bad_request(
                "Game packages cannot contain symbolic links",
            ));
        }
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(io_error)?;
            continue;
        }
        files += 1;
        bytes = bytes.saturating_add(
            entry
                .metadata()
                .map_err(|_| ApiError::bad_request("Unable to inspect game package"))?
                .len(),
        );
        if files > MAX_GAME_FILES || bytes > MAX_GAME_BYTES {
            return Err(ApiError::bad_request(
                "Game package exceeds local safety limits",
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::copy(entry.path(), target).map_err(io_error)?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> ApiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut file = fs::File::create(&temporary).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    if path.exists() {
        fs::remove_file(path).map_err(io_error)?;
    }
    fs::rename(temporary, path).map_err(io_error)
}

fn default_host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "101 Hub".into())
        .chars()
        .take(64)
        .collect()
}
fn io_error(_: std::io::Error) -> ApiError {
    ApiError::internal("Local storage operation failed")
}
fn json_error(_: serde_json::Error) -> ApiError {
    ApiError::bad_request("Unable to serialize local data")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_replays_round_trip_inside_app_data() {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(directory.path().canonicalize().unwrap()).unwrap();
        let settings = HubSettings {
            host_name: "Test Station".into(),
            ..HubSettings::default()
        };
        save_settings(&paths, &settings).unwrap();
        assert_eq!(load_settings(&paths).unwrap(), settings);
        save_replay_at(&paths, "run-1", serde_json::json!({ "schema": 1, "gameId": "slashstorm", "gameVersion": "1.0.0", "seed": "daily-7", "startedAt": 1000, "frames": [], "events": [] })).unwrap();
        assert_eq!(list_replays_at(&paths).unwrap()[0].seed, "daily-7");
        assert!(read_replay_at(&paths, "run-1")
            .unwrap()
            .get("frames")
            .is_some());
    }

    #[test]
    fn package_import_rejects_symlinks_and_accepts_valid_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id": "developer-game", "name": "Developer Game", "version": "1.0.0", "engine": "^1", "renderer": "2d",
            "players": { "min": 1, "max": 4 }, "inputs": ["keyboard"], "offline": true, "procedural": true
        })).unwrap()).unwrap();
        fs::write(source.path().join("index.js"), "export default {};").unwrap();
        let paths = AppPaths::new(directory.path().into()).unwrap();
        let installed = register_game_package_at(&paths, source.path()).unwrap();
        assert_eq!(installed.id, "developer-game");
        assert!(paths.games.join("developer-game/index.js").is_file());
    }
}
