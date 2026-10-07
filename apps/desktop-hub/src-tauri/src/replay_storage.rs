// Selected macOS app-private filesystem profile. Linux uses the same syscalls but is unqualified.
// Owner-controlled storage is not an OS sandbox. Whole-index/file backup rollback has no external floor.
// Native wall time is retention time; Replay101 source timestamps never establish that authority.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod native {
use std::{
    cell::Cell,
    collections::BTreeSet,
    ffi::{CStr, CString},
    fs::{self, File, Metadata},
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::{signaling::{validate_identifier, ApiError, ApiResult}, storage::{AppPaths, StoredReplay}};

const PROFILE: &str = "desktop-local-replay-retention/1";
const RETENTION: u64 = 604_800_000;
const AUDIT_RETENTION: u64 = 2_592_000_000;
const AREA_LIMIT: u64 = 50 * 1024 * 1024;
const REPLAY_LIMIT: usize = 16 * 1024 * 1024;
const INDEX_LIMIT: usize = 64 * 1024;
const INDEX_NAME: &str = ".replay-index.json";
const STAGE_NAME: &str = ".replay-index.stage";
const LOCK_NAME: &str = ".replay-owner.lock";
const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn invalid() -> ApiError { ApiError::bad_request("Replay storage is unavailable; review or retry locally") }
fn quota() -> ApiError { ApiError::bad_request("Replay storage limit reached; delete a replay before saving") }
fn native<T>(result: std::io::Result<T>) -> ApiResult<T> { result.map_err(|_| invalid()) }
fn name(value: &str) -> ApiResult<CString> {
    if value.is_empty() || value.len() > 128 || value == "." || value == ".."
        || !value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')) { return Err(invalid()); }
    CString::new(value).map_err(|_| invalid())
}
fn checked_now() -> ApiResult<u64> {
    let value = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| invalid())?.as_millis();
    if value == 0 || value > MAX_SAFE as u128 - AUDIT_RETENTION as u128 { return Err(invalid()); }
    Ok(value as u64)
}
fn opened(fd: libc::c_int) -> ApiResult<File> {
    if fd < 0 { return Err(invalid()); }
    // The descriptor is freshly returned by open/openat and ownership transfers exactly once.
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn open_directory(path: &Path) -> ApiResult<File> {
    if !path.is_absolute() || path.as_os_str().as_bytes().len() > 4096 || path.components().count() > 64 { return Err(invalid()); }
    let slash = CString::new("/").map_err(|_| invalid())?;
    let mut directory = opened(unsafe { libc::open(slash.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) })?;
    for component in path.components() {
        match component {
            Component::RootDir => {},
            Component::Normal(part) => {
                let part = CString::new(part.as_bytes()).map_err(|_| invalid())?;
                directory = opened(unsafe { libc::openat(directory.as_raw_fd(), part.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
            },
            _ => return Err(invalid()),
        }
    }
    Ok(directory)
}
struct Directory { path: PathBuf, handle: File, device: u64, inode: u64, _lock: File }
impl Directory {
    fn open(path: &Path) -> ApiResult<Self> {
        let handle = open_directory(path)?;
        let metadata = native(handle.metadata())?;
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } { return Err(invalid()); }
        if unsafe { libc::fchmod(handle.as_raw_fd(), 0o700) } != 0 { return Err(invalid()); }
        let leaf = name(LOCK_NAME)?;
        let lock = opened(unsafe { libc::openat(handle.as_raw_fd(), leaf.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) })?;
        let lock_metadata = Self::file_metadata(&lock, 0)?;
        if lock_metadata.mode() & 0o777 != 0o600 { return Err(invalid()); }
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(ApiError::bad_request("Replay storage is busy")); }
        let result = Self { path: path.into(), device: metadata.dev(), inode: metadata.ino(), handle, _lock: lock };
        result.current()?;
        Ok(result)
    }
    fn current(&self) -> ApiResult<()> {
        let current = open_directory(&self.path)?;
        let meta = native(current.metadata())?;
        if meta.dev() != self.device || meta.ino() != self.inode || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o777 != 0o700 { return Err(invalid()); }
        let captured_lock = Self::file_metadata(&self._lock, 0)?;
        let leaf = name(LOCK_NAME)?;
        let current_lock = opened(unsafe { libc::openat(self.handle.as_raw_fd(), leaf.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) })?;
        let lock = Self::file_metadata(&current_lock, 0)?;
        if captured_lock.dev() != lock.dev() || captured_lock.ino() != lock.ino() || lock.mode() & 0o777 != 0o600 { return Err(invalid()); }
        Ok(())
    }
    fn file_metadata(file: &File, limit: u64) -> ApiResult<Metadata> {
        let meta = native(file.metadata())?;
        if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.nlink() != 1 || meta.len() > limit { return Err(invalid()); }
        Ok(meta)
    }
    fn file(&self, leaf: &str, limit: u64) -> ApiResult<File> {
        self.current()?; let leaf = name(leaf)?;
        let file = opened(unsafe { libc::openat(self.handle.as_raw_fd(), leaf.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) })?;
        Self::file_metadata(&file, limit)?;
        self.current()?; Ok(file)
    }
    fn metadata(&self, leaf: &str) -> ApiResult<Metadata> { Self::file_metadata(&self.file(leaf, AREA_LIMIT)?, AREA_LIMIT) }
    fn names(&self) -> ApiResult<Vec<String>> {
        self.current()?;
        let dot = CString::new(".").map_err(|_| invalid())?;
        let handle = opened(unsafe { libc::openat(self.handle.as_raw_fd(), dot.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
        let fd = unsafe { libc::dup(handle.as_raw_fd()) };
        if fd < 0 { return Err(invalid()); }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() { unsafe { libc::close(fd); } return Err(invalid()); }
        struct Stream(*mut libc::DIR);
        impl Drop for Stream { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
        let stream = Stream(stream); let mut output = Vec::new();
        loop {
            #[cfg(target_os = "macos")] let errno = unsafe { libc::__error() };
            #[cfg(not(target_os = "macos"))] let errno = unsafe { libc::__errno_location() };
            unsafe { *errno = 0; }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() { if unsafe { *errno } != 0 { return Err(invalid()); } break; }
            let raw = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let leaf = raw.to_str().map_err(|_| invalid())?;
            if leaf == "." || leaf == ".." { continue; }
            name(leaf)?;
            if output.len() == 64 { return Err(quota()); }
            self.metadata(leaf)?; output.push(leaf.to_owned());
        }
        self.current()?; output.sort(); Ok(output)
    }
    fn total(&self) -> ApiResult<u64> {
        let mut total = 0u64;
        for leaf in self.names()? { total = total.checked_add(self.metadata(&leaf)?.len()).ok_or_else(quota)?; }
        if total > AREA_LIMIT { return Err(quota()); } Ok(total)
    }
    fn admission(&self, bytes: usize) -> ApiResult<()> {
        if self.total()?.checked_add(bytes as u64).filter(|n| *n <= AREA_LIMIT).is_none() { return Err(quota()); } Ok(())
    }
    fn read(&self, leaf: &str, limit: usize) -> ApiResult<Vec<u8>> {
        let file = self.file(leaf, limit as u64)?;
        let before = native(file.metadata())?;
        let mut bytes = Vec::with_capacity((before.len() as usize).min(limit));
        native((&file).take(limit as u64 + 1).read_to_end(&mut bytes))?;
        let after = Self::file_metadata(&file, limit as u64)?;
        if bytes.len() > limit || before.len() != after.len() || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec() || bytes.len() as u64 != after.len() { return Err(invalid()); }
        self.current()?; Ok(bytes)
    }
    fn create(&self, leaf: &str, bytes: &[u8]) -> ApiResult<()> {
        self.current()?; self.admission(bytes.len())?; let leaf = name(leaf)?;
        let mut file = opened(unsafe { libc::openat(self.handle.as_raw_fd(), leaf.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) })?;
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 { return Err(invalid()); }
        native(file.write_all(bytes))?; native(file.sync_all())?; self.sync()?; self.current()
    }
    fn replace(&self, leaf: &str, bytes: &[u8]) -> ApiResult<()> {
        if bytes.len() > INDEX_LIMIT { return Err(quota()); }
        let target = name(leaf)?; self.create(STAGE_NAME, bytes)?;
        let stage = name(STAGE_NAME)?;
        if unsafe { libc::renameat(self.handle.as_raw_fd(), stage.as_ptr(), self.handle.as_raw_fd(), target.as_ptr()) } != 0 { return Err(invalid()); }
        self.sync()?; self.current()
    }
    fn unlink(&self, leaf: &str) -> ApiResult<()> {
        self.current()?; self.metadata(leaf)?; let leaf = name(leaf)?;
        if unsafe { libc::unlinkat(self.handle.as_raw_fd(), leaf.as_ptr(), 0) } != 0 { return Err(invalid()); }
        self.sync()?; self.current()
    }
    fn sync(&self) -> ApiResult<()> { native(self.handle.sync_all()) }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry { record: StoredReplay, file: String, device: u64, inode: u64, modified: i64, modified_nanos: i64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cleanup { file: String, action: String, count: u64, bytes: u64, at: u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Audit { day: u64, action: String, count: u64, bytes: u64, expires_at: u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index { version: u8, profile: String, revision: u64, last_now: u64, entries: Vec<Entry>, pending: Vec<Cleanup>, audit: Vec<Audit> }
impl Index { fn empty(now: u64) -> Self { Self { version: 1, profile: PROFILE.into(), revision: 0, last_now: now, entries: Vec::new(), pending: Vec::new(), audit: Vec::new() } } }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayLimits { retention_ms: u64, per_replay_bytes: usize, aggregate_bytes: u64, live_replays: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCatalog { pub profile: &'static str, pub revision: u64, pub limits: ReplayLimits, pub total_bytes: u64, pub records: Vec<StoredReplay>, pub state: String, pub pending_cleanup: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeletion { pub state: String, pub removed_count: u64, pub removed_bytes: u64 }
fn outcome(state: &str, count: u64, bytes: u64) -> ReplayDeletion { ReplayDeletion { state: state.into(), removed_count: count, removed_bytes: bytes } }

struct LimitedBytes { bytes: Vec<u8>, limit: usize }
impl Write for LimitedBytes {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if input.len() > self.limit.saturating_sub(self.bytes.len()) { return Err(std::io::Error::other("bounded serialization")); }
        self.bytes.extend_from_slice(input); Ok(input.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
fn encoded<T: Serialize>(value: &T, limit: usize) -> ApiResult<Vec<u8>> {
    let mut output = LimitedBytes { bytes: Vec::new(), limit };
    serde_json::to_writer(&mut output, value).map_err(|_| quota())?; Ok(output.bytes)
}
fn finite(value: &Value) -> bool { value.as_f64().is_some_and(|n| n.is_finite()) }
fn text(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= limit && !s.chars().any(char::is_control))
}
fn fields(value: &Value, required: &[&str], optional: &[&str]) -> ApiResult<()> {
    let object = value.as_object().ok_or_else(invalid)?;
    if required.iter().any(|key| !object.contains_key(*key)) || object.keys().any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str())) { return Err(invalid()); } Ok(())
}
fn numbers(value: &Value, boolean: bool) -> ApiResult<()> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() > 64 || object.iter().any(|(key, value)| key.is_empty() || key.len() > 64 || key.chars().any(char::is_control) || !(finite(value) || boolean && value.is_boolean())) { return Err(invalid()); } Ok(())
}
fn validate_replay(value: &Value) -> ApiResult<()> {
    fields(value, &["schema", "gameId", "gameVersion", "seed", "startedAt", "frames", "events"], &[])?;
    if value["schema"].as_u64() != Some(1) || !text(&value["gameId"], 64) || !text(&value["gameVersion"], 64) || !text(&value["seed"], 256) || !finite(&value["startedAt"]) { return Err(invalid()); }
    validate_identifier(value["gameId"].as_str().ok_or_else(invalid)?, 64)?;
    let frames = value["frames"].as_array().ok_or_else(invalid)?;
    let events = value["events"].as_array().ok_or_else(invalid)?;
    if frames.len() > 20_000 || events.len() > 20_000 { return Err(quota()); }
    for frame in frames {
        fields(frame, &["deviceId", "playerId", "sequence", "timestamp", "source", "actions"], &["receivedAt", "axes", "vectors", "poses"])?;
        if !text(&frame["deviceId"], 96) || !text(&frame["playerId"], 96) || frame["sequence"].as_u64().filter(|n| *n <= MAX_SAFE).is_none()
            || !finite(&frame["timestamp"]) || frame.get("receivedAt").is_some_and(|v| !finite(v)) { return Err(invalid()); }
        if !matches!(frame["source"].as_str(), Some("keyboard" | "mouse" | "touch" | "gamepad" | "phone-motion" | "watch-motion" | "camera-hand" | "camera-pose" | "camera-face" | "hid" | "bluetooth" | "serial" | "custom")) { return Err(invalid()); }
        numbers(&frame["actions"], true)?;
        if let Some(axes) = frame.get("axes") { numbers(axes, false)?; }
        if let Some(vectors) = frame.get("vectors") {
            let vectors = vectors.as_object().ok_or_else(invalid)?;
            if vectors.len() > 64 { return Err(quota()); }
            for (key, vector) in vectors {
                if key.is_empty() || key.len() > 64 || key.chars().any(char::is_control) { return Err(invalid()); }
                fields(vector, &["x", "y"], &["z"])?;
                if !finite(&vector["x"]) || !finite(&vector["y"]) || vector.get("z").is_some_and(|v| !finite(v)) { return Err(invalid()); }
            }
        }
        if let Some(poses) = frame.get("poses") {
            let poses = poses.as_object().ok_or_else(invalid)?;
            if poses.len() > 16 { return Err(quota()); }
            for (key, pose) in poses {
                let values = pose.as_array().ok_or_else(invalid)?;
                if key.is_empty() || key.len() > 64 || key.chars().any(char::is_control) || values.len() > 4096 || values.iter().any(|v| !finite(v)) { return Err(invalid()); }
            }
        }
    }
    for event in events { fields(event, &["timestamp", "type"], &["data"])?; if !finite(&event["timestamp"]) || !text(&event["type"], 128) { return Err(invalid()); } }
    let mut pending = vec![(value, 0usize)]; let mut count = 0usize;
    while let Some((next, depth)) = pending.pop() {
        count += 1; if count > 200_000 || depth > 64 { return Err(quota()); }
        match next { Value::Array(values) => { for v in values { pending.push((v, depth + 1)); } }, Value::Object(values) => { for v in values.values() { pending.push((v, depth + 1)); } }, Value::Number(_) if !finite(next) => return Err(invalid()), _ => {} }
        if pending.len() > 200_000 { return Err(quota()); }
    }
    Ok(())
}
fn record(id: &str, value: &Value, saved_at: u64, bytes: usize, generation: String) -> ApiResult<StoredReplay> {
    validate_identifier(id, 96)?; validate_replay(value)?;
    Ok(StoredReplay { id: id.into(), game_id: value["gameId"].as_str().ok_or_else(invalid)?.into(), game_version: value["gameVersion"].as_str().ok_or_else(invalid)?.into(), seed: value["seed"].as_str().ok_or_else(invalid)?.into(), saved_at, expires_at: saved_at.checked_add(RETENTION).filter(|n| *n <= MAX_SAFE).ok_or_else(invalid)?, generation, bytes: bytes as u64 })
}
fn generation(value: &str) -> bool { uuid::Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value) }
fn physical(value: &str) -> bool {
    value.strip_prefix(".replay-").and_then(|v| v.strip_suffix(".json")).is_some_and(generation)
        || value.strip_suffix(".json").is_some_and(|v| validate_identifier(v, 96).is_ok()) && !value.starts_with('.')
}

pub struct ReplayStore { dir: Directory, quarantined: bool, last_seen: Cell<u64> }
impl ReplayStore {
    pub fn open(paths: &AppPaths) -> ApiResult<Self> { Ok(Self { dir: Directory::open(&paths.replays)?, quarantined: false, last_seen: Cell::new(0) }) }
    pub fn save(&mut self, id: &str, value: Value) -> ApiResult<StoredReplay> { self.save_at(id, value, checked_now()?) }
    pub fn catalog(&mut self) -> ApiResult<ReplayCatalog> { self.catalog_at(checked_now()?) }
    pub fn read(&mut self, id: &str) -> ApiResult<Value> { self.read_at(id, checked_now()?) }
    pub fn delete(&mut self, id: &str, selected_generation: &str) -> ApiResult<ReplayDeletion> { self.delete_at(id, selected_generation, checked_now()?) }
    pub fn adopt(&mut self) -> ApiResult<ReplayCatalog> { self.adopt_at(checked_now()?) }
    fn phase(&self, index: &Index, initial: u64, expiry: Option<u64>) -> ApiResult<u64> {
        if self.quarantined { return Err(invalid()); } self.dir.current()?;
        #[cfg(test)] let now = initial;
        #[cfg(not(test))] let now = checked_now()?;
        if now == 0 || now < initial || now < index.last_now || now < self.last_seen.get() || now > MAX_SAFE - AUDIT_RETENTION || expiry.is_some_and(|until| now >= until) { return Err(invalid()); } self.last_seen.set(now); Ok(now)
    }
    fn commit(&mut self, index: &mut Index, initial: u64) -> ApiResult<()> {
        index.last_now = self.phase(index, initial, None)?;
        index.audit.retain(|row| row.expires_at > index.last_now);
        index.revision = index.revision.checked_add(1).filter(|n| *n <= MAX_SAFE).ok_or_else(invalid)?;
        let bytes = encoded(index, INDEX_LIMIT)?;
        if let Err(error) = self.dir.replace(INDEX_NAME, &bytes) { self.quarantined = true; return Err(error); }
        self.phase(index, initial, None)?; Ok(())
    }
    fn load(&mut self, now: u64) -> ApiResult<Option<Index>> {
        if self.quarantined || now == 0 || now > MAX_SAFE - AUDIT_RETENTION { return Err(invalid()); }
        let mut names = self.dir.names()?;
        if names.iter().any(|name| name == STAGE_NAME) { self.dir.unlink(STAGE_NAME)?; names.retain(|name| name != STAGE_NAME); }
        if !names.iter().any(|name| name == INDEX_NAME) {
            if names.iter().any(|name| name != LOCK_NAME && (!physical(name) || name.starts_with('.'))) { return Err(invalid()); }
            if names.iter().any(|name| name != LOCK_NAME) { return Ok(None); }
            let mut fresh = Index::empty(now); self.commit(&mut fresh, now)?; return Ok(Some(fresh));
        }
        if self.dir.metadata(INDEX_NAME)?.mode() & 0o777 != 0o600 { return Err(invalid()); }
        let mut index: Index = serde_json::from_slice(&self.dir.read(INDEX_NAME, INDEX_LIMIT)?).map_err(|_| invalid())?;
        self.validate_index(&index, now)?;
        let accepted: BTreeSet<&str> = index.entries.iter().map(|entry| entry.file.as_str()).chain(index.pending.iter().map(|entry| entry.file.as_str())).collect();
        if names.iter().any(|name| name != INDEX_NAME && name != LOCK_NAME && !accepted.contains(name.as_str())) { return Err(invalid()); }
        self.finish_cleanup(&mut index, now)?;
        loop {
            let Some(position) = index.entries.iter().position(|entry| now >= entry.record.expires_at) else { break; };
            let expired = index.entries.remove(position);
            index.pending.push(Cleanup { file: expired.file, action: "expired".into(), count: 1, bytes: expired.record.bytes, at: now });
            self.commit(&mut index, now)?; self.finish_cleanup(&mut index, now)?;
        }
        if self.phase(&index, now, None)? > index.last_now { self.commit(&mut index, now)?; } Ok(Some(index))
    }
    fn validate_index(&self, index: &Index, now: u64) -> ApiResult<()> {
        if index.version != 1 || index.profile != PROFILE || index.revision > MAX_SAFE || index.last_now == 0 || index.last_now > now || index.entries.len() > 32 || index.pending.len() > 1 || index.audit.len() > 128 { return Err(invalid()); }
        let mut ids = BTreeSet::new(); let mut files = BTreeSet::new();
        for entry in &index.entries {
            let r = &entry.record;
            validate_identifier(&r.id, 96)?; validate_identifier(&r.game_id, 64)?;
            if !ids.insert(&r.id) || !files.insert(&entry.file) || !physical(&entry.file) || !generation(&r.generation)
                || r.saved_at == 0 || r.saved_at > index.last_now || r.expires_at != r.saved_at.checked_add(RETENTION).ok_or_else(invalid)?
                || r.expires_at > MAX_SAFE || r.bytes == 0 || r.bytes > REPLAY_LIMIT as u64 || r.game_version.is_empty() || r.game_version.len() > 64
                || r.seed.is_empty() || r.seed.len() > 256 || r.game_version.chars().any(char::is_control) || r.seed.chars().any(char::is_control) { return Err(invalid()); }
        }
        for pending in &index.pending {
            if !physical(&pending.file) || !files.insert(&pending.file) || !matches!(pending.action.as_str(), "unaccepted" | "deleted" | "expired" | "replaced")
                || pending.count > 1 || pending.bytes > REPLAY_LIMIT as u64 || pending.at == 0 || pending.at > index.last_now { return Err(invalid()); }
        }
        let mut audit_keys = BTreeSet::new();
        for audit in &index.audit {
            if !matches!(audit.action.as_str(), "deleted" | "expired" | "replaced") || audit.day % 86_400_000 != 0 || audit.expires_at != audit.day.checked_add(AUDIT_RETENTION).ok_or_else(invalid)?
                || audit.day > index.last_now || audit.count == 0 || audit.count > MAX_SAFE || audit.bytes > MAX_SAFE || !audit_keys.insert((audit.day, &audit.action)) { return Err(invalid()); }
        }
        self.dir.total()?; Ok(())
    }
    fn finish_cleanup(&mut self, index: &mut Index, now: u64) -> ApiResult<()> {
        let Some(pending) = index.pending.first().cloned() else { return Ok(()); };
        self.phase(index, now, None)?;
        if self.dir.names()?.iter().any(|name| *name == pending.file) { self.dir.unlink(&pending.file)?; }
        self.phase(index, now, None)?;
        if pending.count != 0 {
            let day = pending.at / 86_400_000 * 86_400_000;
            if let Some(audit) = index.audit.iter_mut().find(|row| row.day == day && row.action == pending.action) {
                audit.count = audit.count.checked_add(pending.count).filter(|n| *n <= MAX_SAFE).ok_or_else(invalid)?;
                audit.bytes = audit.bytes.checked_add(pending.bytes).filter(|n| *n <= MAX_SAFE).ok_or_else(invalid)?;
            } else {
                if index.audit.len() >= 128 { return Err(quota()); }
                index.audit.push(Audit { day, action: pending.action, count: pending.count, bytes: pending.bytes, expires_at: day + AUDIT_RETENTION });
            }
        }
        index.pending.clear(); self.commit(index, now)
    }
    fn verify_entry(&self, entry: &Entry) -> ApiResult<()> {
        let meta = self.dir.metadata(&entry.file)?;
        if meta.dev() != entry.device || meta.ino() != entry.inode || meta.len() != entry.record.bytes || meta.mtime() != entry.modified || meta.mtime_nsec() != entry.modified_nanos || meta.mode() & 0o777 != 0o600 { return Err(invalid()); } Ok(())
    }
    fn catalog_from(&self, index: &Index, now: u64) -> ApiResult<ReplayCatalog> {
        for entry in &index.entries { self.verify_entry(entry)?; self.phase(index, now, Some(entry.record.expires_at))?; }
        let mut records: Vec<StoredReplay> = index.entries.iter().map(|entry| entry.record.clone()).collect();
        records.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then(a.id.cmp(&b.id)));
        let result = ReplayCatalog { profile: PROFILE, revision: index.revision, limits: ReplayLimits { retention_ms: RETENTION, per_replay_bytes: REPLAY_LIMIT, aggregate_bytes: AREA_LIMIT, live_replays: 32 }, total_bytes: self.dir.total()?, records, state: "ready".into(), pending_cleanup: index.pending.len() };
        self.phase(index, now, result.records.iter().map(|r| r.expires_at).min())?; Ok(result)
    }
    fn catalog_at(&mut self, now: u64) -> ApiResult<ReplayCatalog> {
        match self.load(now)? { Some(index) => self.catalog_from(&index, now), None => Ok(ReplayCatalog { profile: PROFILE, revision: 0, limits: ReplayLimits { retention_ms: RETENTION, per_replay_bytes: REPLAY_LIMIT, aggregate_bytes: AREA_LIMIT, live_replays: 32 }, total_bytes: self.dir.total()?, records: Vec::new(), state: "legacy-review".into(), pending_cleanup: 0 }) }
    }
    fn save_at(&mut self, id: &str, value: Value, now: u64) -> ApiResult<StoredReplay> {
        validate_identifier(id, 96)?; validate_replay(&value)?;
        let bytes = encoded(&value, REPLAY_LIMIT)?;
        let mut index = self.load(now)?.ok_or_else(|| ApiError::bad_request("Review existing replay retention before saving"))?;
        let previous = index.entries.iter().find(|entry| entry.record.id == id).cloned();
        if previous.is_none() && index.entries.len() >= 32 { return Err(quota()); }
        self.dir.admission(bytes.len().checked_add(2 * INDEX_LIMIT).ok_or_else(quota)?)?;
        let token = uuid::Uuid::new_v4().to_string(); let file = format!(".replay-{token}.json");
        let saved_at = previous.as_ref().map(|old| old.record.saved_at).unwrap_or(now);
        let stored = record(id, &value, saved_at, bytes.len(), token)?;
        self.phase(&index, now, Some(stored.expires_at))?;
        index.pending.push(Cleanup { file: file.clone(), action: "unaccepted".into(), count: 0, bytes: 0, at: now });
        self.commit(&mut index, now)?;
        self.dir.create(&file, &bytes)?;
        self.phase(&index, now, Some(stored.expires_at))?;
        let meta = self.dir.metadata(&file)?;
        let entry = Entry { record: stored.clone(), file, device: meta.dev(), inode: meta.ino(), modified: meta.mtime(), modified_nanos: meta.mtime_nsec() };
        index.entries.retain(|entry| entry.record.id != id); index.entries.push(entry); index.pending.clear();
        if let Some(old) = previous { index.pending.push(Cleanup { file: old.file, action: "replaced".into(), count: 1, bytes: old.record.bytes, at: now }); }
        self.phase(&index, now, Some(stored.expires_at))?; self.commit(&mut index, now)?;
        self.finish_cleanup(&mut index, now)?; self.phase(&index, now, Some(stored.expires_at))?; Ok(stored)
    }
    fn read_at(&mut self, id: &str, now: u64) -> ApiResult<Value> {
        validate_identifier(id, 96)?;
        let index = self.load(now)?.ok_or_else(|| ApiError::bad_request("Review existing replay retention before opening data"))?;
        let entry = index.entries.iter().find(|entry| entry.record.id == id).ok_or_else(|| ApiError::bad_request("Replay is unavailable or expired"))?;
        self.verify_entry(entry)?; self.phase(&index, now, Some(entry.record.expires_at))?;
        let value: Value = serde_json::from_slice(&self.dir.read(&entry.file, REPLAY_LIMIT)?).map_err(|_| invalid())?;
        validate_replay(&value)?; self.verify_entry(entry)?;
        if value["gameId"].as_str() != Some(entry.record.game_id.as_str()) || value["gameVersion"].as_str() != Some(entry.record.game_version.as_str()) || value["seed"].as_str() != Some(entry.record.seed.as_str()) { return Err(invalid()); }
        self.phase(&index, now, Some(entry.record.expires_at))?; Ok(value)
    }
    fn delete_at(&mut self, id: &str, selected_generation: &str, now: u64) -> ApiResult<ReplayDeletion> {
        validate_identifier(id, 96)?; if !generation(selected_generation) { return Err(invalid()); }
        let mut index = self.load(now)?.ok_or_else(invalid)?;
        let Some(position) = index.entries.iter().position(|entry| entry.record.id == id) else { return Ok(outcome("not-found", 0, 0)); };
        if index.entries[position].record.generation != selected_generation { return Ok(outcome("conflict", 0, 0)); }
        self.verify_entry(&index.entries[position])?; self.phase(&index, now, Some(index.entries[position].record.expires_at))?;
        let entry = index.entries.remove(position); let bytes = entry.record.bytes;
        index.pending.push(Cleanup { file: entry.file, action: "deleted".into(), count: 1, bytes, at: now }); self.commit(&mut index, now)?;
        if self.finish_cleanup(&mut index, now).is_err() { return Ok(outcome("cleanup-pending", 0, 0)); }
        self.phase(&index, now, None)?; Ok(outcome("deleted", 1, bytes))
    }
    fn adopt_at(&mut self, now: u64) -> ApiResult<ReplayCatalog> {
        if let Some(index) = self.load(now)? { return self.catalog_from(&index, now); }
        let mut index = Index::empty(now);
        for file in self.dir.names()? {
            if file == LOCK_NAME { continue; }
            let id = file.strip_suffix(".json").ok_or_else(invalid)?; validate_identifier(id, 96)?;
            let meta = self.dir.metadata(&file)?;
            let accepted_at = u64::try_from(meta.mtime()).map_err(|_| invalid())?.checked_mul(1000).and_then(|n| n.checked_add(u64::try_from(meta.mtime_nsec()).ok()? / 1_000_000)).ok_or_else(invalid)?;
            if accepted_at == 0 || accepted_at > now || index.entries.len() >= 32 { return Err(invalid()); }
            let bytes = self.dir.read(&file, REPLAY_LIMIT)?; let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            let stored = record(id, &value, accepted_at, bytes.len(), uuid::Uuid::new_v4().to_string())?;
            index.entries.push(Entry { record: stored, file, device: meta.dev(), inode: meta.ino(), modified: meta.mtime(), modified_nanos: meta.mtime_nsec() });
        }
        self.phase(&index, now, None)?; self.dir.admission(2 * INDEX_LIMIT)?;
        // Only explicit adoption changes permissions of reviewed, regular single-link local replay files.
        for entry in &index.entries {
            let file = self.dir.file(&entry.file, REPLAY_LIMIT as u64)?;
            if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 { return Err(invalid()); }
        }
        self.phase(&index, now, None)?; self.commit(&mut index, now)?;
        let current = self.load(now)?.ok_or_else(invalid)?; self.catalog_from(&current, now)
    }
}

// Tests are authored before the controller. Execution is owned by the integration controller.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::AppPaths;
    use serde_json::json;
    use std::os::unix::fs::symlink;

    fn replay() -> Value {
        json!({"schema":1,"gameId":"fixture-game","gameVersion":"1.0.0","seed":"fixed",
            "startedAt":1000,"frames":[{"deviceId":"keyboard-1","playerId":"player-1",
                "sequence":1,"timestamp":2,"receivedAt":3,"source":"keyboard",
                "actions":{"activate":true,"pressure":0.5},"axes":{"horizontal":0.25},
                "vectors":{"aim":{"x":0.1,"y":0.2,"z":0.3}},"poses":{"hand":[1,2,3]}}],
            "events":[{"timestamp":4,"type":"fixture","data":{"privateOpaque":"never-in-audit"}}]})
    }

    #[test]
    fn original_ingest_deadline_survives_replacement_and_expiry_removes_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap();
        let first = store.save_at("run-1", replay(), 1000).unwrap();
        let second = store.save_at("run-1", replay(), 2000).unwrap();
        assert_ne!(first.generation, second.generation);
        assert_eq!(second.expires_at, 604801000);
        assert!(store.read_at("run-1", 604801000).is_err());
        assert!(store.catalog_at(604801000).unwrap().records.is_empty());
        assert!(!store.dir.names().unwrap().iter().any(|name| name.strip_prefix(".replay-").and_then(|v| v.strip_suffix(".json")).is_some_and(generation)));
    }

    #[test]
    fn stale_generation_cannot_delete_a_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap();
        let first = store.save_at("run-1", replay(), 1000).unwrap();
        let second = store.save_at("run-1", replay(), 2000).unwrap();
        assert_eq!(store.delete_at("run-1", &first.generation, 2000).unwrap().state, "conflict");
        assert_eq!(store.read_at("run-1", 2000).unwrap(), replay());
        assert_eq!(store.delete_at("run-1", &second.generation, 2000).unwrap().state, "deleted");
        assert!(store.read_at("run-1", 2000).is_err());
        let audit = store.dir.read(INDEX_NAME, INDEX_LIMIT).unwrap();
        assert!(!String::from_utf8(audit).unwrap().contains("never-in-audit"));
    }

    #[test]
    fn real_count_quota_preserves_all_incumbents() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap();
        for n in 0..32 { store.save_at(&format!("run-{n}"), replay(), 1000).unwrap(); }
        assert!(store.save_at("overflow", replay(), 1000).is_err());
        assert_eq!(store.catalog_at(1000).unwrap().records.len(), 32);
        assert_eq!(store.read_at("run-0", 1000).unwrap(), replay());
    }

    #[test]
    fn native_replacement_staging_is_charged_before_write() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap();
        let fixture = std::env::var_os("REPLAY_PRODUCER_LARGE_FIXTURE").expect("genuine large ReplayRecorder fixture is required");
        let large: Value = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        for n in 0..3 { store.save_at(&format!("run-{n}"), large.clone(), 1000).unwrap(); }
        let before = store.dir.names().unwrap();
        assert!(store.save_at("run-0", large.clone(), 1000).is_err());
        assert_eq!(store.dir.names().unwrap(), before);
        assert_eq!(store.read_at("run-0", 1000).unwrap(), large);
    }

    #[test]
    fn native_symlinks_and_hardlinks_never_read_or_erase_outside_data() {
        let temp = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        fs::write(outside.path().join("sentinel"), b"outside-private").unwrap();
        symlink(outside.path().join("sentinel"), paths.replays.join("borrowed.json")).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap();
        assert!(store.catalog_at(1000).is_err());
        fs::remove_file(paths.replays.join("borrowed.json")).unwrap();
        fs::hard_link(outside.path().join("sentinel"), paths.replays.join("borrowed.json")).unwrap();
        assert!(store.catalog_at(1000).is_err());
        assert_eq!(fs::read(outside.path().join("sentinel")).unwrap(), b"outside-private");
    }

    #[test]
    fn actual_directory_replacement_retires_the_captured_root() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); store.save_at("run-1", replay(), 1000).unwrap();
        fs::rename(&paths.replays, temp.path().join("old-replays")).unwrap();
        fs::create_dir(&paths.replays).unwrap();
        assert!(store.read_at("run-1", 1000).is_err());
        assert!(!paths.replays.join(INDEX_NAME).exists());
    }

    #[test]
    fn reopened_native_store_keeps_deleted_raw_file_inaccessible() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); let saved = store.save_at("run-1", replay(), 1000).unwrap();
        let name = format!(".replay-{}.json", saved.generation); let bytes = store.dir.read(&name, REPLAY_LIMIT).unwrap();
        store.delete_at("run-1", &saved.generation, 1000).unwrap(); drop(store);
        fs::write(paths.replays.join(&name), bytes).unwrap();
        let mut fresh = ReplayStore::open(&paths).unwrap();
        assert!(fresh.read_at("run-1", 1000).is_err());
    }

    #[test]
    fn corrupt_missing_and_unknown_index_do_not_initialize_over_existing_data() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); store.save_at("run-1", replay(), 1000).unwrap();
        store.dir.replace(INDEX_NAME, b"{\"version\":99}").unwrap();
        assert!(store.read_at("run-1", 1000).is_err());
        store.dir.unlink(INDEX_NAME).unwrap(); assert!(store.catalog_at(1000).is_err());
    }

    #[test]
    fn legacy_adoption_is_explicit_and_does_not_use_source_time() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut value = replay(); value["startedAt"] = json!(9_000_000_000_000u64);
        fs::write(paths.replays.join("run-1.json"), serde_json::to_vec(&value).unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap();
        let now = checked_now().unwrap(); let catalog = store.catalog_at(now).unwrap();
        assert_eq!(catalog.state, "legacy-review"); assert!(store.read_at("run-1", now).is_err());
        store.adopt_at(now).unwrap(); let record = store.catalog_at(now).unwrap().records.remove(0);
        assert!(record.expires_at <= now + 604800000); assert_ne!(record.saved_at, 9_000_000_000_000u64);
        assert_eq!(store.read_at("run-1", now).unwrap(), value);
    }

    #[test]
    fn durable_unaccepted_body_intent_recovers_without_replacing_old_data() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); store.save_at("run-1", replay(), 1000).unwrap();
        let token = uuid::Uuid::new_v4().to_string(); let file = format!(".replay-{token}.json");
        let mut index = store.load(1000).unwrap().unwrap();
        index.pending.push(Cleanup { file: file.clone(), action: "unaccepted".into(), count: 0, bytes: 0, at: 1000 });
        store.commit(&mut index, 1000).unwrap(); store.dir.create(&file, b"partial").unwrap(); drop(store);
        let mut fresh = ReplayStore::open(&paths).unwrap();
        assert_eq!(fresh.read_at("run-1", 1000).unwrap(), replay());
        assert!(!fresh.dir.names().unwrap().contains(&file));
    }

    #[test]
    fn durable_delete_intent_resumes_actual_cleanup_and_count_only_audit() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); let saved = store.save_at("run-1", replay(), 1000).unwrap();
        let mut index = store.load(1000).unwrap().unwrap(); let entry = index.entries.remove(0);
        index.pending.push(Cleanup { file: entry.file.clone(), action: "deleted".into(), count: 1, bytes: saved.bytes, at: 1000 });
        store.commit(&mut index, 1000).unwrap(); assert!(store.dir.names().unwrap().contains(&entry.file)); drop(store);
        let mut fresh = ReplayStore::open(&paths).unwrap(); assert!(fresh.read_at("run-1", 1000).is_err());
        let index = fresh.load(1000).unwrap().unwrap(); assert_eq!(index.audit.len(), 1);
        assert_eq!(index.audit[0].count, 1); assert_eq!(index.audit[0].bytes, saved.bytes);
        assert!(!fresh.dir.names().unwrap().contains(&entry.file));
    }

    #[test]
    fn native_owner_lock_is_retained_until_actual_store_drop() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let store = ReplayStore::open(&paths).unwrap(); assert!(ReplayStore::open(&paths).is_err());
        drop(store); assert!(ReplayStore::open(&paths).is_ok());
    }

    #[test]
    fn backward_and_invalid_clocks_refuse_without_changing_current_body() {
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); store.save_at("run-1", replay(), 1000).unwrap();
        assert_eq!(store.read_at("run-1", 2000).unwrap(), replay());
        assert!(store.read_at("run-1", 1999).is_err()); assert!(store.read_at("run-1", 0).is_err());
        assert_eq!(store.read_at("run-1", 2000).unwrap(), replay());
    }

    #[test]
    fn original_producer_snapshot_round_trips_through_actual_native_store() {
        let path = std::env::var_os("REPLAY_PRODUCER_FIXTURE").expect("genuine ReplayRecorder fixture is required; missing fixture is not qualification");
        let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let temp = tempfile::tempdir().unwrap(); let paths = AppPaths::new(temp.path().canonicalize().unwrap()).unwrap();
        let mut store = ReplayStore::open(&paths).unwrap(); let now = checked_now().unwrap();
        let saved = store.save_at("producer-run", value.clone(), now).unwrap();
        assert_eq!(store.read_at("producer-run", now).unwrap(), value);
        assert_eq!(store.delete_at("producer-run", &saved.generation, now).unwrap().state, "deleted");
        assert!(store.read_at("producer-run", now).is_err());
    }
}

}
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use native::{ReplayCatalog, ReplayDeletion, ReplayStore};

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod unsupported {
    use crate::{signaling::{ApiError, ApiResult}, storage::{AppPaths, StoredReplay}};
    use serde::Serialize;
    use serde_json::Value;
    #[derive(Serialize)]
    pub struct ReplayCatalog { pub records: Vec<StoredReplay> }
    #[derive(Serialize)]
    pub struct ReplayDeletion { pub state: String }
    pub struct ReplayStore;
    fn unsupported<T>() -> ApiResult<T> { Err(ApiError::bad_request("Replay retention is unavailable on this target")) }
    impl ReplayStore {
        pub fn open(_: &AppPaths) -> ApiResult<Self> { unsupported() }
        pub fn save(&mut self, _: &str, _: Value) -> ApiResult<StoredReplay> { unsupported() }
        pub fn catalog(&mut self) -> ApiResult<ReplayCatalog> { unsupported() }
        pub fn read(&mut self, _: &str) -> ApiResult<Value> { unsupported() }
        pub fn delete(&mut self, _: &str, _: &str) -> ApiResult<ReplayDeletion> { unsupported() }
        pub fn adopt(&mut self) -> ApiResult<ReplayCatalog> { unsupported() }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub use unsupported::{ReplayCatalog, ReplayDeletion, ReplayStore};
