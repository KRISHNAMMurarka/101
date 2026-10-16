//! Local, cooperative native input boundary. The host must issue `Approval` only after
//! a user has selected one visible application window. No object in this module is
//! serializable as an input capability. Same-process Rust code remains trusted.

use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    fn valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.x.abs() <= 131072.0
            && self.y.abs() <= 131072.0
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width >= 2.0
            && self.height >= 2.0
            && self.width <= 16384.0
            && self.height <= 16384.0
    }
    fn contains(self, other: Rect) -> bool {
        self.valid()
            && other.valid()
            && other.x >= self.x
            && other.y >= self.y
            && other.x + other.width <= self.x + self.width
            && other.y + other.height <= self.y + self.height
    }
    fn point(self, x: f64, y: f64) -> Result<(f64, f64), InputError> {
        if !x.is_finite()
            || !y.is_finite()
            || !(0.0..=1.0).contains(&x)
            || !(0.0..=1.0).contains(&y)
        {
            return Err(InputError::InvalidCoordinate);
        }
        Ok((
            self.x + x * (self.width - 1.0),
            self.y + y * (self.height - 1.0),
        ))
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub id: u32,
    pub bounds: Rect,
    pub scale: f64,
    pub rotation: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surface {
    pub pid: i32,
    pub process_identity: ProcessIdentity,
    pub window_id: u32,
    pub display_id: u32,
    pub bounds: Rect,
    pub display_bounds: Rect,
    pub scale: f64,
    pub rotation: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub start_seconds: u64,
    pub start_microseconds: u32,
    pub uid: u32,
}
impl ProcessIdentity {
    fn valid(self) -> bool {
        self.start_seconds > 0 && self.start_microseconds < 1_000_000
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessTarget {
    pub pid: i32,
    pub identity: ProcessIdentity,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WindowCandidate {
    pub pid: i32,
    pub window_id: u32,
    pub bounds: Rect,
}
fn near_ax(a: Rect, b: Rect) -> bool {
    a.valid()
        && b.valid()
        && (a.x - b.x).abs() <= 1.0
        && (a.y - b.y).abs() <= 1.0
        && (a.width - b.width).abs() <= 1.0
        && (a.height - b.height).abs() <= 1.0
}
/// The first normal-layer window must be the unique match for the AX focus.
pub(crate) fn select_unique_frontmost(
    pid: i32,
    ax: Rect,
    windows: &[WindowCandidate],
) -> Option<WindowCandidate> {
    let first = *windows.first()?;
    if first.pid != pid || first.window_id == 0 || !near_ax(first.bounds, ax) {
        return None;
    }
    if windows
        .iter()
        .skip(1)
        .any(|w| w.pid == pid && near_ax(w.bounds, ax))
    {
        return None;
    }
    Some(first)
}
impl Surface {
    fn valid(self) -> bool {
        self.pid > 0
            && self.process_identity.valid()
            && self.window_id > 0
            && self.display_id > 0
            && self.display_bounds.contains(self.bounds)
            && self.scale.is_finite()
            && (0.5..=8.0).contains(&self.scale)
            && self.rotation.is_finite()
            && [0.0, 90.0, 180.0, 270.0].contains(&self.rotation)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub accessibility_trusted: bool,
    pub frontmost: Option<Surface>,
    pub target_label: Option<TargetLabel>,
    pub displays: Vec<Display>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetLabel {
    pub application: String,
    pub window: String,
}
impl View {
    fn admits(&self, target: Surface) -> Result<(), InputError> {
        if !self.accessibility_trusted {
            return Err(InputError::PermissionDenied);
        }
        if self.frontmost != Some(target) {
            return Err(InputError::FocusLost);
        }
        if !self.displays.iter().any(|d| {
            d.id == target.display_id
                && d.bounds == target.display_bounds
                && d.scale == target.scale
                && d.rotation == target.rotation
                && d.bounds.contains(target.bounds)
        }) {
            return Err(InputError::GeometryChanged);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key {
    Left,
    Right,
    Up,
    Down,
    Space,
    Return,
    Escape,
    Tab,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Button {
    Left,
    Right,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NativeEvent {
    Move {
        x: f64,
        y: f64,
        drag: Option<Button>,
    },
    Key {
        key: Key,
        down: bool,
    },
    Button {
        button: Button,
        down: bool,
        x: f64,
        y: f64,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    Unavailable,
    PermissionDenied,
    InvalidApproval,
    Expired,
    Revoked,
    StaleLease,
    OwnerMismatch,
    FocusLost,
    GeometryChanged,
    InvalidCoordinate,
    ReleasePending,
    NativeFailure,
    ConflictingHold,
    Busy,
    Stopped,
}

/// Implementations must inspect OS permission and focus immediately before each `emit`.
/// `release_to_process` may only direct a release to the previously approved
/// PID and stable process identity. An API failure must remain pending.
pub trait NativePort {
    fn inventory(&mut self) -> Result<View, InputError>;
    fn emit(&mut self, approval: &Approval, event: NativeEvent) -> Result<(), InputError>;
    fn release_to_process(
        &mut self,
        target: ProcessTarget,
        event: NativeEvent,
    ) -> Result<ReleaseDisposition, InputError>;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseDisposition {
    EventIssued,
    OriginalProcessEnded,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReleaseReport {
    pub event_issued: u32,
    pub process_ended: u32,
}
impl ReleaseReport {
    fn add(&mut self, disposition: ReleaseDisposition) {
        match disposition {
            ReleaseDisposition::EventIssued => self.event_issued += 1,
            ReleaseDisposition::OriginalProcessEnded => self.process_ended += 1,
        }
    }
    fn merge(&mut self, other: Self) {
        self.event_issued += other.event_issued;
        self.process_ended += other.process_ended;
    }
}

pub struct Approval {
    owner: u64,
    pub(crate) target: Surface,
    expires_at: Instant,
    revoked: Arc<AtomicBool>,
}
impl Approval {
    /// Trusted local host call after its explicit user approval, never from route bytes.
    pub fn issue(
        owner: u64,
        target: Surface,
        expires_at: Instant,
        revoked: Arc<AtomicBool>,
    ) -> Result<Self, InputError> {
        let now = Instant::now();
        if owner == 0
            || !target.valid()
            || expires_at <= now
            || expires_at.duration_since(now) > Duration::from_secs(30)
            || revoked.load(Ordering::SeqCst)
        {
            return Err(InputError::InvalidApproval);
        }
        Ok(Self {
            owner,
            target,
            expires_at,
            revoked,
        })
    }
    pub(crate) fn current(&self) -> Result<(), InputError> {
        if self.revoked.load(Ordering::SeqCst) {
            return Err(InputError::Revoked);
        }
        if Instant::now() >= self.expires_at {
            return Err(InputError::Expired);
        }
        Ok(())
    }
    fn for_operation(&self, original_deadline: Instant) -> Self {
        Self {
            owner: self.owner,
            target: self.target,
            expires_at: self.expires_at.min(original_deadline),
            revoked: Arc::clone(&self.revoked),
        }
    }
}

pub struct Lease {
    seal: Arc<()>,
}
struct Active {
    seal: Arc<()>,
    approval: Approval,
    keys: BTreeSet<Key>,
    buttons: BTreeSet<Button>,
    point: (f64, f64),
}
struct Retained<P: NativePort> {
    port: P,
    pending: Vec<(ProcessTarget, NativeEvent)>,
}
fn retry_records<P: NativePort>(
    retained: &mut Vec<Retained<P>>,
) -> Result<ReleaseReport, InputError> {
    let mut report = ReleaseReport::default();
    for record in retained.iter_mut() {
        while let Some((target, event)) = record.pending.first().copied() {
            let disposition = record
                .port
                .release_to_process(target, event)
                .map_err(|_| InputError::ReleasePending)?;
            report.add(disposition);
            record.pending.remove(0);
        }
    }
    retained.retain(|record| !record.pending.is_empty());
    Ok(report)
}
trait OrphanRelease: Send {
    fn pending_count(&self) -> usize;
    fn has_pid(&self, pid: i32) -> bool;
    fn retry(&mut self) -> Result<ReleaseReport, InputError>;
}
struct Orphan<P: NativePort + Send + 'static> {
    retained: Arc<Mutex<Vec<Retained<P>>>>,
}
impl<P: NativePort + Send + 'static> OrphanRelease for Orphan<P> {
    fn pending_count(&self) -> usize {
        self.retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|r| r.pending.len())
            .sum()
    }
    fn retry(&mut self) -> Result<ReleaseReport, InputError> {
        retry_records(&mut self.retained.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn has_pid(&self, pid: i32) -> bool {
        self.retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|record| record.pending.iter().any(|(target, _)| target.pid == pid))
    }
}
static ORPHANED: OnceLock<Mutex<Vec<Box<dyn OrphanRelease>>>> = OnceLock::new();
fn orphaned() -> &'static Mutex<Vec<Box<dyn OrphanRelease>>> {
    ORPHANED.get_or_init(|| Mutex::new(Vec::new()))
}
fn orphaned_has_pid(pid: i32) -> Result<bool, InputError> {
    let records = orphaned().try_lock().map_err(|_| InputError::Busy)?;
    Ok(records.iter().any(|record| record.has_pid(pid)))
}
/// Fallback visibility if a caller drops the last manager despite a failed release.
pub fn orphaned_pending_count() -> usize {
    orphaned()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|r| r.pending_count())
        .sum()
}
/// Explicitly retry orphaned releases after Accessibility permission returns.
pub fn retry_orphaned_releases() -> Result<ReleaseReport, InputError> {
    let mut records = orphaned().lock().unwrap_or_else(|e| e.into_inner());
    let mut report = ReleaseReport::default();
    for record in records.iter_mut() {
        report.merge(record.retry()?);
    }
    records.retain(|record| record.pending_count() > 0);
    Ok(report)
}
/// Host-owned record of releases that could not be posted. Keep this alive,
/// retry it after permission returns, and refuse final teardown while nonempty.
pub struct ReleaseManager<P: NativePort + Send + 'static> {
    retained: Arc<Mutex<Vec<Retained<P>>>>,
}
impl<P: NativePort + Send + 'static> Clone for ReleaseManager<P> {
    fn clone(&self) -> Self {
        Self {
            retained: Arc::clone(&self.retained),
        }
    }
}
impl<P: NativePort + Send + 'static> Drop for ReleaseManager<P> {
    fn drop(&mut self) {
        if Arc::strong_count(&self.retained) == 1 && self.pending_count() > 0 {
            orphaned()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(Box::new(Orphan {
                    retained: Arc::clone(&self.retained),
                }));
        }
    }
}
impl<P: NativePort + Send + 'static> Default for ReleaseManager<P> {
    fn default() -> Self {
        Self::new()
    }
}
impl<P: NativePort + Send + 'static> ReleaseManager<P> {
    pub fn new() -> Self {
        Self {
            retained: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn retain(&self, port: P, pending: Vec<(ProcessTarget, NativeEvent)>) {
        if !pending.is_empty() {
            self.retained
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(Retained { port, pending });
        }
    }
    pub fn pending_count(&self) -> usize {
        self.retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|r| r.pending.len())
            .sum()
    }
    pub fn shutdown_ready(&self) -> Result<(), InputError> {
        let records = self.retained.try_lock().map_err(|_| InputError::Busy)?;
        if records.iter().all(|record| record.pending.is_empty()) {
            Ok(())
        } else {
            Err(InputError::ReleasePending)
        }
    }
    pub fn retry(&self) -> Result<ReleaseReport, InputError> {
        let mut retained = self.retained.lock().unwrap_or_else(|e| e.into_inner());
        retry_records(&mut retained)
    }
}

pub struct NativeInput<P: NativePort + Send + 'static> {
    port: Option<P>,
    releases: ReleaseManager<P>,
    active: Option<Active>,
    pending: Vec<(ProcessTarget, NativeEvent)>,
}
/// Inert lifecycle read: no AX/CG work and no event side effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputLifecycle { pub active: bool, pub pending_releases: usize }
impl<P: NativePort + Send + 'static> NativeInput<P> {
    pub fn new(port: P, releases: ReleaseManager<P>) -> Self {
        Self {
            port: Some(port),
            releases,
            active: None,
            pending: Vec::new(),
        }
    }
    #[cfg(test)]
    pub fn port(&self) -> &P {
        self.port.as_ref().expect("port retained until drop")
    }
    #[cfg(test)]
    pub fn port_mut(&mut self) -> &mut P {
        self.port.as_mut().expect("port retained until drop")
    }
    pub fn inventory(&mut self) -> Result<View, InputError> {
        self.port.as_mut().unwrap().inventory()
    }
    fn lifecycle(&self) -> InputLifecycle {
        InputLifecycle { active: self.active.is_some(), pending_releases: self.pending.len() }
    }
    pub fn activate(&mut self, approval: Approval) -> Result<Lease, InputError> {
        self.stop()?;
        self.releases.shutdown_ready()?;
        if orphaned_has_pid(approval.target.pid)? {
            return Err(InputError::ReleasePending);
        }
        approval.current()?;
        self.port
            .as_mut()
            .unwrap()
            .inventory()?
            .admits(approval.target)?;
        approval.current()?;
        let seal = Arc::new(());
        let point = approval.target.bounds.point(0.5, 0.5)?;
        self.active = Some(Active {
            seal: Arc::clone(&seal),
            approval,
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            point,
        });
        Ok(Lease { seal })
    }
    fn gate(&mut self, lease: &Lease, owner: u64) -> Result<Surface, InputError> {
        let active = self.active.as_ref().ok_or(InputError::StaleLease)?;
        if !Arc::ptr_eq(&lease.seal, &active.seal) {
            return Err(InputError::StaleLease);
        }
        if owner != active.approval.owner {
            return Err(InputError::OwnerMismatch);
        }
        let target = active.approval.target;
        let status = active
            .approval
            .current()
            .and_then(|_| self.port.as_mut().unwrap().inventory()?.admits(target))
            .and_then(|_| active.approval.current());
        if let Err(error) = status {
            self.stop()?;
            return Err(error);
        }
        Ok(target)
    }
    fn legacy_deadline(&self) -> Instant {
        self.active
            .as_ref()
            .map(|active| active.approval.expires_at)
            .unwrap_or_else(Instant::now)
    }
    fn operation_error(&mut self, error: InputError) -> Result<(), InputError> {
        if error == InputError::Expired
            && self
                .active
                .as_ref()
                .is_some_and(|active| active.approval.current().is_ok())
        {
            return Err(InputError::Expired);
        }
        self.stop()?;
        Err(error)
    }
    pub fn move_pointer(
        &mut self,
        lease: &Lease,
        owner: u64,
        x: f64,
        y: f64,
    ) -> Result<(), InputError> {
        self.move_pointer_until(lease, owner, x, y, self.legacy_deadline())
    }
    pub fn move_pointer_until(
        &mut self,
        lease: &Lease,
        owner: u64,
        x: f64,
        y: f64,
        original_deadline: Instant,
    ) -> Result<(), InputError> {
        let target = self.gate(lease, owner)?;
        let operation = self
            .active
            .as_ref()
            .unwrap()
            .approval
            .for_operation(original_deadline);
        if let Err(error) = operation.current() {
            return self.operation_error(error);
        }
        let point = target.bounds.point(x, y)?;
        let drag = self.active.as_ref().unwrap().buttons.iter().next().copied();
        if let Err(e) = self.port.as_mut().unwrap().emit(
            &operation,
            NativeEvent::Move {
                x: point.0,
                y: point.1,
                drag,
            },
        ) {
            return self.operation_error(e);
        }
        self.active.as_mut().unwrap().point = point;
        Ok(())
    }
    pub fn set_key(
        &mut self,
        lease: &Lease,
        owner: u64,
        key: Key,
        down: bool,
    ) -> Result<(), InputError> {
        self.set_key_until(lease, owner, key, down, self.legacy_deadline())
    }
    pub fn set_key_until(
        &mut self,
        lease: &Lease,
        owner: u64,
        key: Key,
        down: bool,
        original_deadline: Instant,
    ) -> Result<(), InputError> {
        self.gate(lease, owner)?;
        let operation = self
            .active
            .as_ref()
            .unwrap()
            .approval
            .for_operation(original_deadline);
        if let Err(error) = operation.current() {
            return self.operation_error(error);
        }
        let already = self.active.as_ref().unwrap().keys.contains(&key);
        if already == down {
            return Ok(());
        }
        if let Err(e) = self
            .port
            .as_mut()
            .unwrap()
            .emit(&operation, NativeEvent::Key { key, down })
        {
            return self.operation_error(e);
        }
        let keys = &mut self.active.as_mut().unwrap().keys;
        if down {
            keys.insert(key);
        } else {
            keys.remove(&key);
        }
        Ok(())
    }
    pub fn set_button(
        &mut self,
        lease: &Lease,
        owner: u64,
        button: Button,
        down: bool,
        x: f64,
        y: f64,
    ) -> Result<(), InputError> {
        self.set_button_until(lease, owner, button, down, x, y, self.legacy_deadline())
    }
    pub fn set_button_until(
        &mut self,
        lease: &Lease,
        owner: u64,
        button: Button,
        down: bool,
        x: f64,
        y: f64,
        original_deadline: Instant,
    ) -> Result<(), InputError> {
        let target = self.gate(lease, owner)?;
        let operation = self
            .active
            .as_ref()
            .unwrap()
            .approval
            .for_operation(original_deadline);
        if let Err(error) = operation.current() {
            return self.operation_error(error);
        }
        let point = target.bounds.point(x, y)?;
        let already = self.active.as_ref().unwrap().buttons.contains(&button);
        if down && !already && !self.active.as_ref().unwrap().buttons.is_empty() {
            return Err(InputError::ConflictingHold);
        }
        if already == down {
            return Ok(());
        }
        if let Err(e) = self.port.as_mut().unwrap().emit(
            &operation,
            NativeEvent::Button {
                button,
                down,
                x: point.0,
                y: point.1,
            },
        ) {
            return self.operation_error(e);
        }
        let active = self.active.as_mut().unwrap();
        active.point = point;
        if down {
            active.buttons.insert(button);
        } else {
            active.buttons.remove(&button);
        }
        Ok(())
    }
    fn queue_active_releases(&mut self) {
        if let Some(active) = self.active.take() {
            let target = ProcessTarget {
                pid: active.approval.target.pid,
                identity: active.approval.target.process_identity,
            };
            for key in active.keys {
                self.pending
                    .push((target, NativeEvent::Key { key, down: false }));
            }
            for button in active.buttons {
                self.pending.push((
                    target,
                    NativeEvent::Button {
                        button,
                        down: false,
                        x: active.point.0,
                        y: active.point.1,
                    },
                ));
            }
        }
    }
    pub fn stop(&mut self) -> Result<(), InputError> {
        self.queue_active_releases();
        self.reconcile_releases().map(|_| ())
    }
    pub fn reconcile_releases(&mut self) -> Result<ReleaseReport, InputError> {
        let mut report = ReleaseReport::default();
        while let Some((target, event)) = self.pending.first().copied() {
            let disposition = self
                .port
                .as_mut()
                .unwrap()
                .release_to_process(target, event)
                .map_err(|_| InputError::ReleasePending)?;
            report.add(disposition);
            self.pending.remove(0);
        }
        Ok(report)
    }
    /// The host should call this on focus/geometry notifications and regularly while held.
    pub fn sweep(&mut self) -> Result<(), InputError> {
        if let Some(active) = self.active.as_ref() {
            let status = active
                .approval
                .current()
                .and_then(|_| {
                    self.port
                        .as_mut()
                        .unwrap()
                        .inventory()?
                        .admits(active.approval.target)
                })
                .and_then(|_| active.approval.current());
            if let Err(error) = status {
                self.stop()?;
                return Err(error);
            }
        }
        self.reconcile_releases().map(|_| ())
    }
}
impl<P: NativePort + Send + 'static> Drop for NativeInput<P> {
    fn drop(&mut self) {
        let _ = self.stop();
        if !self.pending.is_empty() {
            let port = self.port.take().expect("port retained until drop");
            self.releases
                .retain(port, std::mem::take(&mut self.pending));
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestWorkerPhase { BeforeLock, Locked }

/// Use this in the desktop host. Polling is best-effort: a blocked OS inventory
/// or event call can delay the sweep. `shutdown` is explicit and fallible.
pub struct GuardedInput<P: NativePort + Send + 'static> {
    inner: Arc<Mutex<NativeInput<P>>>,
    shutdown: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    #[cfg(test)]
    test_worker_hook: Arc<Mutex<Option<Arc<dyn Fn(TestWorkerPhase) + Send + Sync>>>>,
    #[cfg(test)]
    prelock_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
impl<P: NativePort + Send + 'static> GuardedInput<P> {
    pub fn new(port: P, releases: ReleaseManager<P>) -> Self {
        let inner = Arc::new(Mutex::new(NativeInput::new(port, releases)));
        let shutdown = Arc::new(AtomicBool::new(false));
        let input = Arc::clone(&inner);
        let stop = Arc::clone(&shutdown);
        #[cfg(test)]
        let test_worker_hook: Arc<Mutex<Option<Arc<dyn Fn(TestWorkerPhase) + Send + Sync>>>> = Arc::new(Mutex::new(None));
        #[cfg(test)]
        let worker_hook = Arc::clone(&test_worker_hook);
        let worker = std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                #[cfg(test)]
                let hook = worker_hook.lock().unwrap().clone();
                #[cfg(test)]
                if let Some(hook) = &hook { hook(TestWorkerPhase::BeforeLock); }
                if let Ok(mut state) = input.lock() {
                    #[cfg(test)]
                    if let Some(hook) = &hook { hook(TestWorkerPhase::Locked); }
                    let _ = state.sweep();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        Self {
            inner,
            shutdown,
            worker: Some(worker),
            #[cfg(test)]
            test_worker_hook,
            #[cfg(test)]
            prelock_hook: Mutex::new(None),
        }
    }
    #[cfg(test)]
    pub(crate) fn test_install_worker_hook(&self, hook: Arc<dyn Fn(TestWorkerPhase) + Send + Sync>) {
        *self.test_worker_hook.lock().unwrap() = Some(hook);
    }
    #[cfg(test)]
    pub(crate) fn test_stop_worker(&self) { self.shutdown.store(true, Ordering::SeqCst); }
    #[cfg(test)]
    pub(crate) fn test_join_worker(&mut self) -> std::thread::Result<Option<String>> {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let id = format!("{:?}", worker.thread().id());
            worker.join()?;
            Ok(Some(id))
        } else { Ok(None) }
    }
    #[cfg(test)]
    pub(crate) fn test_install_prelock_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.prelock_hook.lock().unwrap() = Some(hook);
    }
    #[cfg(test)]
    fn run_prelock_hook(&self) {
        let hook = self.prelock_hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook();
        }
    }
    pub fn inventory(&self) -> Result<View, InputError> {
        self.inner
            .lock()
            .map_err(|_| InputError::Unavailable)?
            .inventory()
    }
    /// Nonblocking status read; a busy native call never holds the UI status path.
    pub fn lifecycle(&self) -> Result<InputLifecycle, InputError> {
        self.inner.try_lock().map_err(|_| InputError::Busy).map(|state| state.lifecycle())
    }
    pub fn activate(&self, approval: Approval) -> Result<Lease, InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        #[cfg(test)]
        self.run_prelock_hook();
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.activate(approval)
    }
    pub fn move_pointer(
        &self,
        lease: &Lease,
        owner: u64,
        x: f64,
        y: f64,
    ) -> Result<(), InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.move_pointer(lease, owner, x, y)
    }
    pub fn move_pointer_until(
        &self,
        lease: &Lease,
        owner: u64,
        x: f64,
        y: f64,
        original_deadline: Instant,
    ) -> Result<(), InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.move_pointer_until(lease, owner, x, y, original_deadline)
    }
    pub fn set_key(
        &self,
        lease: &Lease,
        owner: u64,
        key: Key,
        down: bool,
    ) -> Result<(), InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.set_key(lease, owner, key, down)
    }
    pub fn set_key_until(
        &self,
        lease: &Lease,
        owner: u64,
        key: Key,
        down: bool,
        original_deadline: Instant,
    ) -> Result<(), InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.set_key_until(lease, owner, key, down, original_deadline)
    }
    pub fn set_button(
        &self,
        lease: &Lease,
        owner: u64,
        button: Button,
        down: bool,
        x: f64,
        y: f64,
    ) -> Result<(), InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.set_button(lease, owner, button, down, x, y)
    }
    pub fn set_button_until(
        &self,
        lease: &Lease,
        owner: u64,
        button: Button,
        down: bool,
        x: f64,
        y: f64,
        original_deadline: Instant,
    ) -> Result<(), InputError> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        let mut state = self.inner.lock().map_err(|_| InputError::Unavailable)?;
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(InputError::Stopped);
        }
        state.set_button_until(lease, owner, button, down, x, y, original_deadline)
    }
    pub fn stop(&self) -> Result<(), InputError> {
        self.inner
            .lock()
            .map_err(|_| InputError::Unavailable)?
            .stop()
    }
    /// A busy or failed release must keep the host alive with its manager.
    pub fn shutdown(&self) -> Result<(), InputError> {
        let mut state = self.inner.try_lock().map_err(|_| InputError::Busy)?;
        state.stop()?;
        state.releases.shutdown_ready()?;
        self.shutdown.store(true, Ordering::SeqCst);
        Ok(())
    }
}
impl<P: NativePort + Send + 'static> Drop for GuardedInput<P> {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Detach: an OS call holding the lock may block. Its Arc still owns
        // NativeInput and transfers pending releases to the host manager later.
        self.worker.take();
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CgRect {
        origin: Point,
        size: Size,
    }
    // sys/proc_info.h PROC_PIDTBSDINFO on the macOS SDK: size and field
    // layout are checked at compile time. This is queried only for the AX
    // focused PID or a previously approved pending-release PID.
    #[repr(C)]
    struct ProcBsdInfo {
        flags: u32,
        status: u32,
        xstatus: u32,
        pid: u32,
        ppid: u32,
        uid: u32,
        gid: u32,
        ruid: u32,
        rgid: u32,
        svuid: u32,
        svgid: u32,
        reserved: u32,
        comm: [u8; 16],
        name: [u8; 32],
        nfiles: u32,
        pgid: u32,
        pjobc: u32,
        tdev: u32,
        tpgid: u32,
        nice: i32,
        start_seconds: u64,
        start_microseconds: u64,
    }
    const _: [(); 136] = [(); std::mem::size_of::<ProcBsdInfo>()];
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
        fn geteuid() -> u32;
    }
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Ref);
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
        fn CFNumberGetValue(number: Ref, kind: i32, value: *mut c_void) -> u8;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateSystemWide() -> Ref;
        fn AXUIElementSetMessagingTimeout(element: Ref, seconds: f32) -> i32;
        fn AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, value: *mut Ref) -> i32;
        fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
        fn AXValueGetValue(value: Ref, kind: u32, output: *mut c_void) -> u8;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        static kCGWindowNumber: Ref;
        static kCGWindowOwnerPID: Ref;
        static kCGWindowLayer: Ref;
        static kCGWindowBounds: Ref;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: u32) -> CgRect;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayRotation(display: u32) -> f64;
        fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Ref;
        fn CGRectMakeWithDictionaryRepresentation(dictionary: Ref, rect: *mut CgRect) -> u8;
        fn CGEventCreateMouseEvent(source: Ref, kind: u32, point: Point, button: u32) -> Ref;
        fn CGEventCreateKeyboardEvent(source: Ref, keycode: u16, down: u8) -> Ref;
        fn CGEventPost(tap: u32, event: Ref);
        fn CGEventPostToPid(pid: i32, event: Ref);
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }
    fn attr(element: Ref, name: &'static [u8]) -> Option<Owned> {
        let key = Owned(unsafe {
            CFStringCreateWithCString(ptr::null(), name.as_ptr().cast(), 0x0800_0100)
        });
        if key.0.is_null() {
            return None;
        }
        let mut value = ptr::null();
        if unsafe { AXUIElementSetMessagingTimeout(element, 0.25) } != 0 {
            return None;
        }
        if unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut value) } != 0
            || value.is_null()
        {
            if !value.is_null() {
                unsafe { CFRelease(value) };
            }
            None
        } else {
            Some(Owned(value))
        }
    }
    fn number(dictionary: Ref, key: Ref) -> Option<i64> {
        let value = unsafe { CFDictionaryGetValue(dictionary, key) };
        let mut result = 0_i64;
        if value.is_null()
            || unsafe { CFNumberGetValue(value, 4, (&mut result as *mut i64).cast()) } == 0
        {
            None
        } else {
            Some(result)
        }
    }
    fn rect(cg: CgRect) -> Rect {
        Rect {
            x: cg.origin.x,
            y: cg.origin.y,
            width: cg.size.width,
            height: cg.size.height,
        }
    }
    fn process_identity(pid: i32) -> Result<ProcessIdentity, InputError> {
        if pid <= 0 {
            return Err(InputError::Unavailable);
        }
        let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<ProcBsdInfo>() as i32;
        let got = unsafe { proc_pidinfo(pid, 3, 0, (&mut info as *mut ProcBsdInfo).cast(), size) };
        if got != size || info.pid != pid as u32 {
            return Err(InputError::Unavailable);
        }
        let start_microseconds =
            u32::try_from(info.start_microseconds).map_err(|_| InputError::Unavailable)?;
        let identity = ProcessIdentity {
            start_seconds: info.start_seconds,
            start_microseconds,
            uid: info.uid,
        };
        if !identity.valid() {
            return Err(InputError::Unavailable);
        }
        Ok(identity)
    }
    fn ax_text(element: Ref) -> Option<String> {
        let value = attr(element, b"AXTitle\0")?;
        if unsafe { CFGetTypeID(value.0) } != unsafe { CFStringGetTypeID() } {
            return None;
        }
        let mut buffer = [0_i8; 1024];
        if unsafe {
            CFStringGetCString(
                value.0,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                0x0800_0100,
            )
        } == 0
        {
            return None;
        }
        let raw = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_str().ok()?;
        let clean: String = raw.chars().filter(|c| !c.is_control()).take(120).collect();
        let clean = clean.trim();
        if clean.is_empty() {
            None
        } else {
            Some(clean.to_owned())
        }
    }
    fn focused_window() -> Option<(i32, ProcessIdentity, Rect, Option<TargetLabel>)> {
        let system = Owned(unsafe { AXUIElementCreateSystemWide() });
        if system.0.is_null() {
            return None;
        }
        if unsafe { AXUIElementSetMessagingTimeout(system.0, 0.25) } != 0 {
            return None;
        }
        let app = attr(system.0, b"AXFocusedApplication\0")?;
        if unsafe { AXUIElementSetMessagingTimeout(app.0, 0.25) } != 0 {
            return None;
        }
        let mut pid = 0;
        if unsafe { AXUIElementGetPid(app.0, &mut pid) } != 0 || pid <= 0 {
            return None;
        }
        let identity = process_identity(pid).ok()?;
        if identity.uid != unsafe { geteuid() } {
            return None;
        }
        let window = attr(app.0, b"AXFocusedWindow\0")?;
        let label = ax_text(app.0)
            .zip(ax_text(window.0))
            .map(|(application, window)| TargetLabel {
                application,
                window,
            });
        let position = attr(window.0, b"AXPosition\0")?;
        let size = attr(window.0, b"AXSize\0")?;
        let mut point = Point::default();
        let mut extent = Size::default();
        if unsafe { AXValueGetValue(position.0, 1, (&mut point as *mut Point).cast()) } == 0
            || unsafe { AXValueGetValue(size.0, 2, (&mut extent as *mut Size).cast()) } == 0
        {
            return None;
        }
        Some((
            pid,
            identity,
            Rect {
                x: point.x,
                y: point.y,
                width: extent.width,
                height: extent.height,
            },
            label,
        ))
    }
    fn displays() -> Result<Vec<Display>, InputError> {
        let mut ids = [0_u32; 32];
        let mut count = 0_u32;
        if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0
            || count == 0
            || count as usize > ids.len()
        {
            return Err(InputError::Unavailable);
        }
        let mut result = Vec::new();
        for id in ids.into_iter().take(count as usize) {
            let bounds = rect(unsafe { CGDisplayBounds(id) });
            if !bounds.valid() {
                continue;
            }
            let scale = unsafe { CGDisplayPixelsWide(id) } as f64 / bounds.width;
            let rotation = unsafe { CGDisplayRotation(id) };
            if !scale.is_finite()
                || !(0.5..=8.0).contains(&scale)
                || ![0.0, 90.0, 180.0, 270.0].contains(&rotation)
            {
                continue;
            }
            result.push(Display {
                id,
                bounds,
                scale,
                rotation,
            });
        }
        if result.is_empty() {
            Err(InputError::Unavailable)
        } else {
            Ok(result)
        }
    }
    fn frontmost(displays: &[Display]) -> Option<(Surface, Option<TargetLabel>)> {
        let (focused_pid, focused_identity, focused_bounds, label) = focused_window()?;
        let windows = Owned(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) });
        if windows.0.is_null() {
            return None;
        }
        // WindowServer returns front-to-back order. Public AX APIs do not
        // expose a foreign CG window ID, so ambiguous geometry must fail.
        let count = unsafe { CFArrayGetCount(windows.0) };
        let mut candidates = Vec::new();
        for i in 0..count {
            let row = unsafe { CFArrayGetValueAtIndex(windows.0, i) };
            if row.is_null() || number(row, unsafe { kCGWindowLayer }) != Some(0) {
                continue;
            }
            let pid = i32::try_from(number(row, unsafe { kCGWindowOwnerPID })?).ok()?;
            let id = u32::try_from(number(row, unsafe { kCGWindowNumber })?).ok()?;
            let bounds_dictionary = unsafe { CFDictionaryGetValue(row, kCGWindowBounds) };
            let mut cg = CgRect::default();
            if bounds_dictionary.is_null()
                || unsafe { CGRectMakeWithDictionaryRepresentation(bounds_dictionary, &mut cg) }
                    == 0
            {
                return None;
            }
            candidates.push(WindowCandidate {
                pid,
                window_id: id,
                bounds: rect(cg),
            });
        }
        let selected = select_unique_frontmost(focused_pid, focused_bounds, &candidates)?;
        let identity = process_identity(selected.pid).ok()?;
        if identity != focused_identity {
            return None;
        }
        let display = displays
            .iter()
            .find(|d| d.bounds.contains(selected.bounds))?;
        return Some((
            Surface {
                pid: selected.pid,
                process_identity: identity,
                window_id: selected.window_id,
                display_id: display.id,
                bounds: selected.bounds,
                display_bounds: display.bounds,
                scale: display.scale,
                rotation: display.rotation,
            },
            label,
        ));
    }
    fn event(value: NativeEvent) -> Ref {
        unsafe {
            match value {
                NativeEvent::Move { x, y, drag } => {
                    let (kind, button) = match drag {
                        None => (5, 0),
                        Some(Button::Left) => (6, 0),
                        Some(Button::Right) => (7, 1),
                    };
                    CGEventCreateMouseEvent(ptr::null(), kind, Point { x, y }, button)
                }
                NativeEvent::Button { button, down, x, y } => {
                    let (kind, code) = match (button, down) {
                        (Button::Left, true) => (1, 0),
                        (Button::Left, false) => (2, 0),
                        (Button::Right, true) => (3, 1),
                        (Button::Right, false) => (4, 1),
                    };
                    CGEventCreateMouseEvent(ptr::null(), kind, Point { x, y }, code)
                }
                NativeEvent::Key { key, down } => {
                    let code = match key {
                        Key::Left => 123,
                        Key::Right => 124,
                        Key::Down => 125,
                        Key::Up => 126,
                        Key::Space => 49,
                        Key::Return => 36,
                        Key::Escape => 53,
                        Key::Tab => 48,
                    };
                    CGEventCreateKeyboardEvent(ptr::null(), code, down as u8)
                }
            }
        }
    }
    #[derive(Default)]
    pub struct MacPort;
    impl NativePort for MacPort {
        fn inventory(&mut self) -> Result<View, InputError> {
            let trusted = unsafe { AXIsProcessTrusted() } != 0;
            if !trusted {
                return Ok(View {
                    accessibility_trusted: false,
                    frontmost: None,
                    target_label: None,
                    displays: Vec::new(),
                });
            }
            let displays = displays()?;
            let selected = frontmost(&displays);
            let (frontmost, target_label) = match selected {
                Some((surface, label)) => (Some(surface), label),
                None => (None, None),
            };
            Ok(View {
                accessibility_trusted: true,
                frontmost,
                target_label,
                displays,
            })
        }
        fn emit(&mut self, approval: &Approval, action: NativeEvent) -> Result<(), InputError> {
            approval.current()?;
            let target = approval.target;
            self.inventory()?.admits(target)?;
            let event = Owned(event(action));
            if event.0.is_null() {
                return Err(InputError::NativeFailure);
            }
            // One final check immediately before dispatch. Process-directed delivery
            // prevents a focus switch from redirecting a key to another application.
            self.inventory()?.admits(target)?;
            approval.current()?;
            unsafe {
                match action {
                    NativeEvent::Move { .. } => CGEventPost(0, event.0),
                    _ => CGEventPostToPid(target.pid, event.0),
                }
            };
            Ok(())
        }
        fn release_to_process(
            &mut self,
            target: ProcessTarget,
            action: NativeEvent,
        ) -> Result<ReleaseDisposition, InputError> {
            let observed = process_identity(target.pid).map_err(|_| InputError::ReleasePending)?;
            if observed != target.identity {
                return Ok(ReleaseDisposition::OriginalProcessEnded);
            }
            if unsafe { AXIsProcessTrusted() } == 0 {
                return Err(InputError::ReleasePending);
            }
            let event = Owned(event(action));
            if event.0.is_null() {
                return Err(InputError::ReleasePending);
            }
            let observed = process_identity(target.pid).map_err(|_| InputError::ReleasePending)?;
            if observed != target.identity {
                return Ok(ReleaseDisposition::OriginalProcessEnded);
            }
            unsafe { CGEventPostToPid(target.pid, event.0) };
            Ok(ReleaseDisposition::EventIssued)
        }
    }
}
#[cfg(target_os = "macos")]
pub use mac::MacPort;
#[cfg(not(target_os = "macos"))]
pub struct MacPort;
#[cfg(not(target_os = "macos"))]
impl NativePort for MacPort {
    fn inventory(&mut self) -> Result<View, InputError> {
        Err(InputError::Unavailable)
    }
    fn emit(&mut self, _approval: &Approval, _event: NativeEvent) -> Result<(), InputError> {
        Err(InputError::Unavailable)
    }
    fn release_to_process(
        &mut self,
        _target: ProcessTarget,
        _event: NativeEvent,
    ) -> Result<ReleaseDisposition, InputError> {
        Err(InputError::Unavailable)
    }
}
