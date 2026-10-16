//! Host-only native input controller. Renderer bytes never issue an Approval.
//! The selected window comes from AX/CG inventory; confirmation is a native OS alert.
//! Same-process code and OS calls are trusted, and an issued event is not delivery proof.

use crate::native_input::{
    orphaned_pending_count, retry_orphaned_releases, Approval, Button, GuardedInput, InputError,
    Key, Lease, MacPort, NativePort, ReleaseManager, ReleaseReport, Surface, TargetLabel,
};
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const ATTEMPTS: usize = 32;
const COMMAND_MAX: Duration = Duration::from_millis(500);
const USER_LEASE: Duration = Duration::from_secs(30);
static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
fn origin() -> Instant { *CLOCK_ORIGIN.get_or_init(Instant::now) }

/// String fields avoid loss of nanosecond precision in JavaScript numbers.
pub struct ClockSample { pub native_now_ns: String, pub max_command_ms: u32 }
pub fn clock_sample() -> ClockSample {
    ClockSample { native_now_ns: origin().elapsed().as_nanos().to_string(), max_command_ms: 500 }
}
/// The caller supplies the original mapped command deadline, never a new TTL.
pub fn deadline_from_native_ns(value: &str) -> Result<Instant, ControlError> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ControlError::InvalidDeadline);
    }
    let nanoseconds = value.parse::<u64>().map_err(|_| ControlError::InvalidDeadline)?;
    let deadline = origin().checked_add(Duration::from_nanos(nanoseconds)).ok_or(ControlError::InvalidDeadline)?;
    let remaining = deadline.checked_duration_since(Instant::now()).ok_or(ControlError::InvalidDeadline)?;
    if remaining.is_zero() || remaining > COMMAND_MAX { return Err(ControlError::InvalidDeadline); }
    Ok(deadline)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlError {
    Native(InputError), Busy, MissingLabel, Denied, Cancelled, InvalidToken, InvalidDeadline, RandomUnavailable,
}
impl From<InputError> for ControlError { fn from(value: InputError) -> Self { Self::Native(value) } }

pub trait SelectionGate: Send + Sync + 'static {
    fn pause(&self, duration: Duration);
    fn confirm(&self, surface: Surface, label: &TargetLabel) -> bool;
}
pub struct NativeSelectionGate;
impl SelectionGate for NativeSelectionGate {
    fn pause(&self, duration: Duration) { std::thread::sleep(duration); }
    fn confirm(&self, surface: Surface, label: &TargetLabel) -> bool {
        crate::native_input_approval::confirm(surface, label)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetStatus { pub application: String, pub window: String, pub pid: i32, pub window_id: u32, pub display_id: u32 }
pub struct ControllerStatus { pub selecting: bool, pub target: Option<TargetStatus>, pub pending_releases: usize }
pub struct StartReceipt { pub token: String, pub target: TargetStatus }
struct Active { token: String, owner: u64, lease: Arc<Lease>, target: TargetStatus, expires_at: Instant }
struct State { active: Option<Active> }
struct Selecting<'a>(&'a AtomicBool);
impl Drop for Selecting<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
struct InFlight<'a, P: NativePort + Send + 'static, G: SelectionGate>(&'a NativeInputController<P, G>);
impl<P: NativePort + Send + 'static, G: SelectionGate> Drop for InFlight<'_, P, G> {
    fn drop(&mut self) {
        if self.0.inflight.fetch_sub(1, Ordering::SeqCst) == 1 &&
            self.0.deferred_stop.swap(false, Ordering::SeqCst) {
            let _ = self.0.stop_native();
        }
    }
}

/// Stop first revokes the current approval and advances revision, before waiting
/// for any in-flight inventory, confirmation, or native effect lock.
pub struct NativeInputController<P: NativePort + Send + 'static, G: SelectionGate> {
    input: GuardedInput<P>, releases: ReleaseManager<P>, gate: G,
    revision: AtomicU64, revoked: Mutex<Arc<AtomicBool>>, selecting: AtomicBool,
    release_pending: AtomicBool, inflight: AtomicUsize, deferred_stop: AtomicBool, state: Mutex<State>,
}
impl<P: NativePort + Send + 'static, G: SelectionGate> NativeInputController<P, G> {
    pub fn new(port: P, gate: G) -> Self {
        let releases = ReleaseManager::new();
        Self { input: GuardedInput::new(port, releases.clone()), releases, gate,
            revision: AtomicU64::new(0), revoked: Mutex::new(Arc::new(AtomicBool::new(false))),
            selecting: AtomicBool::new(false), release_pending: AtomicBool::new(false),
            inflight: AtomicUsize::new(0), deferred_stop: AtomicBool::new(false),
            state: Mutex::new(State { active: None }) }
    }
    #[cfg(test)] pub fn test_gate(&self) -> &G { &self.gate }
    #[cfg(test)] pub fn test_install_worker_hook(&self, hook: Arc<dyn Fn(crate::native_input::TestWorkerPhase) + Send + Sync>) {
        self.input.test_install_worker_hook(hook);
    }
    #[cfg(test)] pub fn test_stop_worker(&self) { self.input.test_stop_worker(); }
    #[cfg(test)] pub fn test_join_worker(&mut self) -> std::thread::Result<Option<String>> {
        self.input.test_join_worker()
    }
    fn check_revision(&self, expected: u64) -> Result<(), ControlError> {
        if self.revision.load(Ordering::SeqCst) != expected { Err(ControlError::Cancelled) } else { Ok(()) }
    }
    fn status_for(surface: Surface, label: &TargetLabel) -> TargetStatus {
        TargetStatus { application: label.application.clone(), window: label.window.clone(), pid: surface.pid,
            window_id: surface.window_id, display_id: surface.display_id }
    }
    fn reconcile_native(&self) -> Result<usize, ControlError> {
        let lifecycle = self.input.lifecycle()?;
        if !lifecycle.active {
            let retired = self.state.lock().map_err(|_| ControlError::Busy)?.active.take().is_some();
            if retired {
                self.revoked.lock().map_err(|_| ControlError::Busy)?.store(true, Ordering::SeqCst);
                self.revision.fetch_add(1, Ordering::SeqCst);
            }
        }
        Ok(lifecycle.pending_releases)
    }
    fn valid_label(label: &TargetLabel) -> bool {
        [&label.application, &label.window].iter().all(|value| {
            !value.trim().is_empty() && value.len() <= 128 && value.trim() == *value &&
            !value.chars().any(|c| c.is_control())
        })
    }
    pub fn select_and_confirm(&self) -> Result<StartReceipt, ControlError> {
        if self.selecting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(ControlError::Busy);
        }
        let _selecting = Selecting(&self.selecting);
        if self.reconcile_native()? > 0 { return Err(ControlError::Native(InputError::ReleasePending)); }
        if self.state.lock().map_err(|_| ControlError::Busy)?.active.is_some() { return Err(ControlError::Busy); }
        let revision = self.revision.load(Ordering::SeqCst);
        // Give the user five seconds to focus the intended application. We never activate it.
        self.gate.pause(Duration::from_secs(5));
        self.check_revision(revision)?;
        let mut chosen = None;
        for attempt in 0..ATTEMPTS {
            self.check_revision(revision)?;
            let view = self.input.inventory()?;
            self.check_revision(revision)?;
            if view.accessibility_trusted {
                if let (Some(surface), Some(label)) = (view.frontmost, view.target_label) {
                    if Self::valid_label(&label) { chosen = Some((surface, label)); break; }
                }
            }
            if attempt + 1 < ATTEMPTS { self.gate.pause(Duration::from_millis(50)); }
        }
        let (surface, label) = chosen.ok_or(ControlError::MissingLabel)?;
        self.check_revision(revision)?;
        if !self.gate.confirm(surface, &label) { return Err(ControlError::Denied); }
        self.check_revision(revision)?;
        let current = self.input.inventory()?;
        self.check_revision(revision)?;
        if !current.accessibility_trusted || current.frontmost != Some(surface) || current.target_label.as_ref() != Some(&label) {
            return Err(ControlError::Native(InputError::FocusLost));
        }
        let (token, owner) = fresh_token()?;
        self.check_revision(revision)?;
        let expires_at = Instant::now() + USER_LEASE;
        let approval = {
            let mut slot = self.revoked.lock().map_err(|_| ControlError::Busy)?;
            self.check_revision(revision)?;
            let revoked = Arc::new(AtomicBool::new(false));
            let approval = Approval::issue(owner, surface, expires_at, Arc::clone(&revoked))?;
            *slot = revoked;
            approval
        };
        let lease = self.input.activate(approval)?;
        if self.check_revision(revision).is_err() { let _ = self.input.stop(); return Err(ControlError::Cancelled); }
        let target = Self::status_for(surface, &label);
        let mut state = self.state.lock().map_err(|_| ControlError::Busy)?;
        if self.check_revision(revision).is_err() { drop(state); let _ = self.input.stop(); return Err(ControlError::Cancelled); }
        state.active = Some(Active { token: token.clone(), owner, lease: Arc::new(lease), target: target.clone(), expires_at });
        Ok(StartReceipt { token, target })
    }
    pub fn status(&self) -> ControllerStatus {
        let native_pending = self.reconcile_native().ok();
        let target = native_pending.and_then(|_| self.state.lock().ok()).and_then(|state| state.active.as_ref()
            .filter(|a| Instant::now() < a.expires_at).map(|a| a.target.clone()));
        ControllerStatus { selecting: self.selecting.load(Ordering::SeqCst), target,
            pending_releases: native_pending.unwrap_or(1) + self.releases.pending_count() + orphaned_pending_count() +
                usize::from(self.release_pending.load(Ordering::SeqCst) || self.deferred_stop.load(Ordering::SeqCst)) }
    }
    fn with_active(&self, token: &str, action: impl FnOnce(&GuardedInput<P>, &Lease, u64) -> Result<(), InputError>) -> Result<(), ControlError> {
        let state = self.state.lock().map_err(|_| ControlError::Busy)?;
        let active = state.active.as_ref().ok_or(ControlError::InvalidToken)?;
        if active.token != token { return Err(ControlError::InvalidToken); }
        if Instant::now() >= active.expires_at { return Err(ControlError::Native(InputError::Expired)); }
        let lease = Arc::clone(&active.lease);
        let owner = active.owner;
        self.inflight.fetch_add(1, Ordering::SeqCst);
        drop(state);
        let _flight = InFlight(self);
        action(&self.input, &lease, owner).map_err(ControlError::Native)
    }
    pub fn move_pointer(&self, token: &str, x: f64, y: f64, deadline: Instant) -> Result<(), ControlError> {
        self.with_active(token, |input, lease, owner| input.move_pointer_until(lease, owner, x, y, deadline))
    }
    pub fn set_key(&self, token: &str, key: Key, down: bool, deadline: Instant) -> Result<(), ControlError> {
        self.with_active(token, |input, lease, owner| input.set_key_until(lease, owner, key, down, deadline))
    }
    pub fn set_button(&self, token: &str, button: Button, down: bool, x: f64, y: f64, deadline: Instant) -> Result<(), ControlError> {
        self.with_active(token, |input, lease, owner| input.set_button_until(lease, owner, button, down, x, y, deadline))
    }
    fn stop_native(&self) -> Result<(), ControlError> {
        match self.input.stop() {
            Ok(()) => { self.release_pending.store(false, Ordering::SeqCst); Ok(()) },
            Err(error) => { if error == InputError::ReleasePending { self.release_pending.store(true, Ordering::SeqCst); }
                Err(ControlError::Native(error)) },
        }
    }
    pub fn stop(&self) -> Result<(), ControlError> {
        { let slot = self.revoked.lock().map_err(|_| ControlError::Busy)?;
          slot.store(true, Ordering::SeqCst); self.revision.fetch_add(1, Ordering::SeqCst); }
        let had_active = self.state.lock().map_err(|_| ControlError::Busy)?.active.take().is_some();
        // Native inventory can call back into Stop while holding GuardedInput's
        // inner lock. A pending selection has issued no event, and its revision
        // check will stop an activated lease before publication. Avoid waiting
        // on that same lock from the callback stack.
        if self.selecting.load(Ordering::SeqCst) && !had_active { return Ok(()); }
        self.deferred_stop.store(true, Ordering::SeqCst);
        if self.inflight.load(Ordering::SeqCst) > 0 { return Err(ControlError::Native(InputError::Busy)); }
        if self.deferred_stop.swap(false, Ordering::SeqCst) { self.stop_native() } else { Ok(()) }
    }
    pub fn retry_releases(&self) -> Result<ReleaseReport, ControlError> {
        self.stop()?;
        let mut report = self.releases.retry()?;
        let orphaned = retry_orphaned_releases()?;
        report.event_issued += orphaned.event_issued; report.process_ended += orphaned.process_ended;
        Ok(report)
    }
    pub fn shutdown(&self) -> Result<(), ControlError> {
        if self.selecting.load(Ordering::SeqCst) { return Err(ControlError::Busy); }
        self.stop()?;
        if orphaned_pending_count() > 0 { return Err(ControlError::Native(InputError::ReleasePending)); }
        self.input.shutdown()?;
        self.releases.shutdown_ready()?;
        Ok(())
    }
}
fn fresh_token() -> Result<(String, u64), ControlError> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom").and_then(|mut source| source.read_exact(&mut bytes)).map_err(|_| ControlError::RandomUnavailable)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let owner = u64::from_be_bytes(bytes[..8].try_into().unwrap()).max(1);
    let token = format!("{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        u32::from_be_bytes(bytes[0..4].try_into().unwrap()), u16::from_be_bytes(bytes[4..6].try_into().unwrap()),
        u16::from_be_bytes(bytes[6..8].try_into().unwrap()), u16::from_be_bytes(bytes[8..10].try_into().unwrap()),
        u64::from_be_bytes([0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]]));
    Ok((token, owner))
}
pub type MacInputController = NativeInputController<MacPort, NativeSelectionGate>;
pub fn mac_controller() -> MacInputController { NativeInputController::new(MacPort, NativeSelectionGate) }
