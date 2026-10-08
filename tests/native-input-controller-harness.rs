#[path = "../apps/desktop-hub/src-tauri/src/native_input.rs"]
mod native_input;
#[path = "../apps/desktop-hub/src-tauri/src/native_input_approval.rs"]
mod native_input_approval;
#[path = "../apps/desktop-hub/src-tauri/src/native_input_controller.rs"]
mod native_input_controller;

use native_input::*;
use native_input_controller::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Shared { emitted: usize, confirmed: usize, releases: usize, fail_release: bool,
    inventory_calls: usize, inventory_hook: Option<Box<dyn Fn() + Send>>, inventory: Option<View> }
struct Port(Arc<Mutex<Shared>>);
impl NativePort for Port {
    fn inventory(&mut self) -> Result<View, InputError> {
        let (view, hook) = { let mut state = self.0.lock().unwrap(); state.inventory_calls += 1;
            (state.inventory.clone().unwrap(), state.inventory_hook.take()) };
        if let Some(hook) = hook { hook(); }
        Ok(view)
    }
    fn emit(&mut self, approval: &Approval, _: NativeEvent) -> Result<(), InputError> {
        approval.current()?; self.0.lock().unwrap().emitted += 1; Ok(())
    }
    fn release_to_process(&mut self, _: ProcessTarget, _: NativeEvent) -> Result<ReleaseDisposition, InputError> {
        let mut state = self.0.lock().unwrap();
        if state.fail_release { return Err(InputError::PermissionDenied); }
        state.releases += 1; Ok(ReleaseDisposition::EventIssued)
    }
}
struct Gate { shared: Arc<Mutex<Shared>>, allow: bool, during_confirm: Mutex<Option<Box<dyn Fn() + Send>>> }
impl SelectionGate for Gate {
    fn pause(&self, _: Duration) {}
    fn confirm(&self, _: Surface, _: &TargetLabel) -> bool {
        self.shared.lock().unwrap().confirmed += 1;
        if let Some(f) = self.during_confirm.lock().unwrap().take() { f(); }
        self.allow
    }
}
fn fixture(allow: bool) -> (Arc<NativeInputController<Port, Gate>>, Arc<Mutex<Shared>>) {
    let shared = Arc::new(Mutex::new(Shared::default()));
    let rect = Rect { x: 0.0, y: 0.0, width: 500.0, height: 400.0 };
    let surface = Surface { pid: 41, process_identity: ProcessIdentity { start_seconds: 1, start_microseconds: 2, uid: 3 }, window_id: 7,
        display_id: 1, bounds: rect, display_bounds: rect, scale: 1.0, rotation: 0.0 };
    shared.lock().unwrap().inventory = Some(View { accessibility_trusted: true, frontmost: Some(surface),
        target_label: Some(TargetLabel { application: "App".into(), window: "Window".into() }),
        displays: vec![Display { id: 1, bounds: rect, scale: 1.0, rotation: 0.0 }] });
    let gate = Gate { shared: Arc::clone(&shared), allow, during_confirm: Mutex::new(None) };
    let controller = Arc::new(NativeInputController::new(Port(Arc::clone(&shared)), gate));
    (controller, shared)
}
#[test]
fn denied_and_unlabelled_selection_issue_no_approval() {
    let (controller, shared) = fixture(false);
    assert!(controller.select_and_confirm().is_err());
    assert_eq!(shared.lock().unwrap().emitted, 0);
    assert!(controller.status().target.is_none());
    let (controller, shared) = fixture(true);
    shared.lock().unwrap().inventory.as_mut().unwrap().target_label = None;
    assert!(controller.select_and_confirm().is_err());
    assert_eq!(shared.lock().unwrap().confirmed, 0);
}
#[test]
fn stop_during_prompt_fences_approval_and_effects() {
    let (controller, shared) = fixture(true);
    let weak = Arc::downgrade(&controller);
    controller.test_gate().during_confirm.lock().unwrap().replace(Box::new(move || { weak.upgrade().unwrap().stop().unwrap(); }));
    assert!(controller.select_and_confirm().is_err());
    assert_eq!(shared.lock().unwrap().emitted, 0);
    assert!(controller.status().target.is_none());
}
#[test]
fn stop_during_inventory_fences_confirmation_and_approval() {
    let (controller, shared) = fixture(true);
    let weak = Arc::downgrade(&controller);
    shared.lock().unwrap().inventory_hook = Some(Box::new(move || { weak.upgrade().unwrap().stop().unwrap(); }));
    assert_eq!(controller.select_and_confirm().err(), Some(ControlError::Cancelled));
    assert_eq!(shared.lock().unwrap().confirmed, 0);
    assert!(controller.status().target.is_none());
}
#[test]
fn stop_during_active_inventory_fences_emit_and_defers_cleanup_without_deadlock() {
    let (controller, shared) = fixture(true);
    let receipt = controller.select_and_confirm().unwrap();
    let weak = Arc::downgrade(&controller);
    shared.lock().unwrap().inventory_hook = Some(Box::new(move || {
        assert_eq!(weak.upgrade().unwrap().stop(), Err(ControlError::Native(InputError::Busy)));
    }));
    assert!(controller.move_pointer(&receipt.token, 0.5, 0.5, Instant::now() + Duration::from_millis(100)).is_err());
    assert_eq!(shared.lock().unwrap().emitted, 0);
    assert!(controller.status().target.is_none());
    assert_eq!(controller.status().pending_releases, 0);
    controller.shutdown().unwrap();
}
#[test]
fn search_is_bounded_and_old_token_cannot_command_replacement() {
    let (controller, shared) = fixture(true);
    shared.lock().unwrap().inventory.as_mut().unwrap().target_label = None;
    assert_eq!(controller.select_and_confirm().err(), Some(ControlError::MissingLabel));
    assert_eq!(shared.lock().unwrap().inventory_calls, 32);
    shared.lock().unwrap().inventory.as_mut().unwrap().target_label = Some(TargetLabel { application: "App".into(), window: "Window".into() });
    let old = controller.select_and_confirm().unwrap(); controller.stop().unwrap();
    let new = controller.select_and_confirm().unwrap();
    assert_ne!(old.token, new.token);
    assert_eq!(controller.move_pointer(&old.token, 0.5, 0.5, Instant::now() + Duration::from_millis(100)), Err(ControlError::InvalidToken));
    assert_eq!(shared.lock().unwrap().emitted, 0);
    controller.stop().unwrap();
}
#[test]
fn original_native_deadline_fences_event_without_renewing_lease() {
    let (controller, shared) = fixture(true);
    let receipt = controller.select_and_confirm().unwrap();
    let expired = Instant::now() - Duration::from_millis(1);
    assert!(controller.move_pointer(&receipt.token, 0.5, 0.5, expired).is_err());
    assert_eq!(shared.lock().unwrap().emitted, 0);
    assert!(controller.status().target.is_some());
    controller.stop().unwrap();
}
#[test]
fn clock_conversion_rejects_expired_or_overlong_deadline() {
    let sample = clock_sample();
    assert!(deadline_from_native_ns(&sample.native_now_ns).is_err());
    let over = sample.native_now_ns.parse::<u64>().unwrap() + 5_000_000_000;
    assert!(deadline_from_native_ns(&over.to_string()).is_err());
}
#[test]
fn failed_held_release_refuses_shutdown_and_remains_retryable() {
    let (controller, shared) = fixture(true);
    let receipt = controller.select_and_confirm().unwrap();
    controller.set_key(&receipt.token, Key::Left, true, Instant::now() + Duration::from_millis(100)).unwrap();
    shared.lock().unwrap().fail_release = true;
    assert_eq!(controller.stop(), Err(ControlError::Native(InputError::ReleasePending)));
    assert!(controller.status().pending_releases > 0);
    assert_eq!(controller.shutdown(), Err(ControlError::Native(InputError::ReleasePending)));
    shared.lock().unwrap().fail_release = false;
    controller.retry_releases().unwrap();
    assert_eq!(shared.lock().unwrap().releases, 1);
    assert_eq!(controller.status().pending_releases, 0);
    controller.shutdown().unwrap();
}
#[test]
fn watchdog_retirement_clears_status_and_allows_reselection_after_release() {
    let (controller, shared) = fixture(true);
    let first = controller.select_and_confirm().unwrap();
    controller.set_key(&first.token, Key::Left, true, Instant::now() + Duration::from_millis(100)).unwrap();
    shared.lock().unwrap().inventory.as_mut().unwrap().accessibility_trusted = false;
    for _ in 0..50 {
        if shared.lock().unwrap().releases > 0 { break; }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(shared.lock().unwrap().releases, 1, "watchdog did not retire the held key");
    assert!(controller.status().target.is_none());
    shared.lock().unwrap().inventory.as_mut().unwrap().accessibility_trusted = true;
    let replacement = controller.select_and_confirm().unwrap();
    assert_ne!(first.token, replacement.token);
    controller.stop().unwrap();
}
