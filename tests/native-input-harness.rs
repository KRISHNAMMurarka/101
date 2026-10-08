#[path = "../apps/desktop-hub/src-tauri/src/native_input.rs"]
mod native_input;

use native_input::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

fn serial_guard() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct FakePort {
    view: Option<View>,
    current_identity: Option<Arc<Mutex<ProcessIdentity>>>,
    identity_unavailable: Option<Arc<AtomicBool>>,
    events: Vec<NativeEvent>,
    fail_release: bool,
    release_gate: Option<Arc<AtomicBool>>,
    shared_events: Option<Arc<Mutex<Vec<NativeEvent>>>>,
    block_inventory: Option<Arc<AtomicBool>>,
    entered_inventory: Option<Arc<AtomicBool>>,
    block_emit: Option<Arc<AtomicBool>>,
    entered_emit: Option<Arc<AtomicBool>>,
}
impl NativePort for FakePort {
    fn inventory(&mut self) -> Result<View, InputError> {
        if let Some(block) = &self.block_inventory {
            if block.load(Ordering::SeqCst) {
                if let Some(entered) = &self.entered_inventory {
                    entered.store(true, Ordering::SeqCst);
                }
                while block.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
        self.view.clone().ok_or(InputError::Unavailable)
    }
    fn emit(&mut self, approval: &Approval, event: NativeEvent) -> Result<(), InputError> {
        let view = self.inventory()?;
        approval.current()?;
        if !view.accessibility_trusted || view.frontmost != Some(approval.target) {
            return Err(InputError::FocusLost);
        }
        if let Some(block) = &self.block_emit {
            if block.load(Ordering::SeqCst) {
                if let Some(entered) = &self.entered_emit {
                    entered.store(true, Ordering::SeqCst);
                }
                while block.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
        approval.current()?;
        self.events.push(event);
        if let Some(events) = &self.shared_events {
            events.lock().unwrap().push(event);
        }
        Ok(())
    }
    fn release_to_process(
        &mut self,
        target: ProcessTarget,
        event: NativeEvent,
    ) -> Result<ReleaseDisposition, InputError> {
        if self
            .identity_unavailable
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Err(InputError::ReleasePending);
        }
        let actual = self
            .current_identity
            .as_ref()
            .map(|identity| *identity.lock().unwrap())
            .or_else(|| {
                self.view
                    .as_ref()?
                    .frontmost
                    .map(|surface| surface.process_identity)
            })
            .unwrap_or(surface().process_identity);
        if actual != target.identity {
            return Ok(ReleaseDisposition::OriginalProcessEnded);
        }
        if self.fail_release
            || self
                .release_gate
                .as_ref()
                .is_some_and(|gate| gate.load(Ordering::SeqCst))
            || !self
                .view
                .as_ref()
                .is_some_and(|view| view.accessibility_trusted)
        {
            return Err(InputError::ReleasePending);
        }
        self.events.push(event);
        if let Some(events) = &self.shared_events {
            events.lock().unwrap().push(event);
        }
        Ok(ReleaseDisposition::EventIssued)
    }
}

fn surface() -> Surface {
    Surface {
        pid: 42,
        process_identity: ProcessIdentity {
            start_seconds: 123_456,
            start_microseconds: 789,
            uid: 501,
        },
        window_id: 7,
        display_id: 1,
        bounds: Rect {
            x: 10.0,
            y: 20.0,
            width: 400.0,
            height: 200.0,
        },
        display_bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        },
        scale: 2.0,
        rotation: 0.0,
    }
}
fn view(s: Surface) -> View {
    View {
        accessibility_trusted: true,
        frontmost: Some(s),
        target_label: Some(TargetLabel {
            application: "Fixture App".into(),
            window: "Main Window".into(),
        }),
        displays: vec![Display {
            id: 1,
            bounds: s.display_bounds,
            scale: 2.0,
            rotation: 0.0,
        }],
    }
}
fn approval(s: Surface, owner: u64, revoke: Arc<AtomicBool>, until: Instant) -> Approval {
    Approval::issue(owner, s, until, revoke).unwrap()
}

#[test]
fn no_input_without_explicit_live_approval_and_exact_window() {
    let _test_guard = serial_guard();
    let s = surface();
    assert_eq!(
        view(s).target_label.as_ref().unwrap().application,
        "Fixture App"
    );
    let mut invalid_identity = s;
    invalid_identity.process_identity.start_seconds = 0;
    assert_eq!(
        Approval::issue(
            1,
            invalid_identity,
            Instant::now() + Duration::from_secs(1),
            Arc::new(AtomicBool::new(false))
        )
        .err(),
        Some(InputError::InvalidApproval)
    );
    let port = FakePort {
        view: Some(view(s)),
        ..Default::default()
    };
    let mut input = NativeInput::new(port, ReleaseManager::new());
    let revoked = Arc::new(AtomicBool::new(false));
    let lease = input
        .activate(approval(
            s,
            1,
            revoked.clone(),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input.move_pointer(&lease, 1, 0.0, 1.0).unwrap();
    assert_eq!(input.port().events.len(), 1);
    assert_eq!(
        input.port().events[0],
        NativeEvent::Move {
            x: 10.0,
            y: 219.0,
            drag: None
        }
    );
    assert_eq!(
        input.move_pointer(&lease, 2, 0.5, 0.5),
        Err(InputError::OwnerMismatch)
    );
    assert_eq!(
        input.move_pointer(&lease, 1, f64::NAN, 0.5),
        Err(InputError::InvalidCoordinate)
    );
    assert_eq!(input.port().events.len(), 1);
    revoked.store(true, Ordering::SeqCst);
    assert_eq!(
        input.move_pointer(&lease, 1, 0.5, 0.5),
        Err(InputError::Revoked)
    );
    assert_eq!(input.port().events.len(), 1);
}

#[test]
fn transfer_stop_and_focus_loss_release_holds_and_retire_old_handle() {
    let _test_guard = serial_guard();
    let s = surface();
    let mut input = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        ReleaseManager::new(),
    );
    let lease1 = input
        .activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input.set_key(&lease1, 1, Key::Left, true).unwrap();
    input
        .set_button(&lease1, 1, Button::Left, true, 0.5, 0.5)
        .unwrap();
    let lease2 = input
        .activate(approval(
            s,
            2,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    assert_eq!(
        input
            .port()
            .events
            .iter()
            .filter(|e| matches!(
                e,
                NativeEvent::Key { down: false, .. } | NativeEvent::Button { down: false, .. }
            ))
            .count(),
        2
    );
    assert_eq!(
        input.set_key(&lease1, 1, Key::Left, true),
        Err(InputError::StaleLease)
    );
    input.set_key(&lease2, 2, Key::Right, true).unwrap();
    input.port_mut().view.as_mut().unwrap().frontmost = None;
    assert_eq!(
        input.set_key(&lease2, 2, Key::Space, true),
        Err(InputError::FocusLost)
    );
    assert!(input.port().events.contains(&NativeEvent::Key {
        key: Key::Right,
        down: false
    }));
    assert_eq!(
        input.set_key(&lease2, 2, Key::Right, true),
        Err(InputError::StaleLease)
    );
}

#[test]
fn expired_lease_or_changed_display_never_emits_new_press() {
    let _test_guard = serial_guard();
    let s = surface();
    let mut input = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        ReleaseManager::new(),
    );
    assert_eq!(
        Approval::issue(
            1,
            s,
            Instant::now() - Duration::from_millis(1),
            Arc::new(AtomicBool::new(false))
        )
        .err(),
        Some(InputError::InvalidApproval)
    );
    let lease = input
        .activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input.port_mut().view.as_mut().unwrap().displays.clear();
    assert_eq!(
        input.set_key(&lease, 1, Key::Escape, true),
        Err(InputError::GeometryChanged)
    );
    assert!(input.port().events.is_empty());
}

#[test]
fn failed_release_blocks_replacement_until_reconciled() {
    let _test_guard = serial_guard();
    let s = surface();
    let mut input = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        ReleaseManager::new(),
    );
    let lease = input
        .activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input.set_key(&lease, 1, Key::Left, true).unwrap();
    input.port_mut().fail_release = true;
    assert_eq!(input.stop(), Err(InputError::ReleasePending));
    assert_eq!(
        input
            .activate(approval(
                s,
                2,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1)
            ))
            .err(),
        Some(InputError::ReleasePending)
    );
    input.port_mut().fail_release = false;
    input.reconcile_releases().unwrap();
    input
        .activate(approval(
            s,
            2,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
}

#[test]
fn watchdog_releases_expired_hold_without_another_route_command() {
    let _test_guard = serial_guard();
    let s = surface();
    let shared = Arc::new(Mutex::new(Vec::new()));
    let guarded = GuardedInput::new(
        FakePort {
            view: Some(view(s)),
            shared_events: Some(shared.clone()),
            ..Default::default()
        },
        ReleaseManager::new(),
    );
    let lease = guarded
        .activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_millis(25),
        ))
        .unwrap();
    guarded.set_key(&lease, 1, Key::Left, true).unwrap();
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline
        && !shared.lock().unwrap().contains(&NativeEvent::Key {
            key: Key::Left,
            down: false,
        })
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(shared.lock().unwrap().contains(&NativeEvent::Key {
        key: Key::Left,
        down: false
    }));
    assert_eq!(
        guarded.set_key(&lease, 1, Key::Right, true),
        Err(InputError::StaleLease)
    );
    guarded.shutdown().unwrap();
}

#[test]
fn permission_loss_and_revocation_retire_holds_without_new_down_events() {
    let _test_guard = serial_guard();
    let s = surface();
    let revoked = Arc::new(AtomicBool::new(false));
    let mut input = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        ReleaseManager::new(),
    );
    let lease = input
        .activate(approval(
            s,
            1,
            revoked.clone(),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input.set_key(&lease, 1, Key::Space, true).unwrap();
    revoked.store(true, Ordering::SeqCst);
    assert_eq!(input.sweep(), Err(InputError::Revoked));
    assert_eq!(
        input.port().events.last(),
        Some(&NativeEvent::Key {
            key: Key::Space,
            down: false
        })
    );

    let lease = input
        .activate(approval(
            s,
            2,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input
        .set_button(&lease, 2, Button::Right, true, 0.5, 0.5)
        .unwrap();
    input
        .port_mut()
        .view
        .as_mut()
        .unwrap()
        .accessibility_trusted = false;
    assert_eq!(input.sweep(), Err(InputError::ReleasePending));
    input
        .port_mut()
        .view
        .as_mut()
        .unwrap()
        .accessibility_trusted = true;
    input.reconcile_releases().unwrap();
    assert!(input.port().events.contains(&NativeEvent::Button {
        button: Button::Right,
        down: false,
        x: 209.5,
        y: 119.5
    }));
    assert_eq!(
        input.set_button(&lease, 2, Button::Right, true, 0.5, 0.5),
        Err(InputError::StaleLease)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn mac_backend_symbols_link_without_invoking_the_os() {
    let _test_guard = serial_guard();
    fn tauri_state_compatible<T: Send + Sync>() {}
    tauri_state_compatible::<GuardedInput<MacPort>>();
    tauri_state_compatible::<ReleaseManager<MacPort>>();
    let _ = std::hint::black_box(
        <MacPort as NativePort>::inventory as fn(&mut MacPort) -> Result<View, InputError>,
    );
    let _ = std::hint::black_box(
        <MacPort as NativePort>::emit
            as fn(&mut MacPort, &Approval, NativeEvent) -> Result<(), InputError>,
    );
    let _ = std::hint::black_box(
        <MacPort as NativePort>::release_to_process
            as fn(
                &mut MacPort,
                ProcessTarget,
                NativeEvent,
            ) -> Result<ReleaseDisposition, InputError>,
    );
}

#[test]
fn dropped_controller_retains_failed_release_for_host_retry() {
    let _test_guard = serial_guard();
    let s = surface();
    let gate = Arc::new(AtomicBool::new(true));
    let journal = ReleaseManager::<FakePort>::new();
    {
        let mut input = NativeInput::new(
            FakePort {
                view: Some(view(s)),
                release_gate: Some(gate.clone()),
                ..Default::default()
            },
            journal.clone(),
        );
        let lease = input
            .activate(approval(
                s,
                1,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
        input.set_key(&lease, 1, Key::Left, true).unwrap();
        assert_eq!(input.stop(), Err(InputError::ReleasePending));
    }
    assert_eq!(journal.pending_count(), 1);
    assert_eq!(journal.shutdown_ready(), Err(InputError::ReleasePending));
    let mut replacement = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        journal.clone(),
    );
    assert_eq!(
        replacement
            .activate(approval(
                s,
                2,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1)
            ))
            .err(),
        Some(InputError::ReleasePending)
    );
    gate.store(false, Ordering::SeqCst);
    journal.retry().unwrap();
    assert_eq!(journal.pending_count(), 0);
    assert_eq!(journal.shutdown_ready(), Ok(()));
    replacement
        .activate(approval(
            s,
            2,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
}

#[test]
fn focused_window_match_rejects_near_identical_ambiguity() {
    let _test_guard = serial_guard();
    let s = surface();
    let first = WindowCandidate {
        pid: s.pid,
        window_id: 7,
        bounds: s.bounds,
    };
    let mut near = first;
    near.window_id = 8;
    near.bounds.x += 0.9;
    assert_eq!(
        select_unique_frontmost(s.pid, s.bounds, &[first, near]),
        None
    );
    near.bounds.x += 0.2;
    assert_eq!(
        select_unique_frontmost(s.pid, s.bounds, &[first, near]),
        Some(first)
    );
}

#[test]
fn held_button_moves_emit_drag_kind_and_second_button_is_denied() {
    let _test_guard = serial_guard();
    let s = surface();
    let journal = ReleaseManager::<FakePort>::new();
    let mut input = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        journal,
    );
    let lease = input
        .activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
    input
        .set_button(&lease, 1, Button::Left, true, 0.5, 0.5)
        .unwrap();
    input.move_pointer(&lease, 1, 0.75, 0.75).unwrap();
    assert_eq!(
        input.port().events.last(),
        Some(&NativeEvent::Move {
            x: 309.25,
            y: 169.25,
            drag: Some(Button::Left)
        })
    );
    assert_eq!(
        input.set_button(&lease, 1, Button::Right, true, 0.5, 0.5),
        Err(InputError::ConflictingHold)
    );
}

#[test]
fn guarded_drop_retains_denied_release_in_host_manager() {
    let _test_guard = serial_guard();
    let s = surface();
    let gate = Arc::new(AtomicBool::new(true));
    let manager = ReleaseManager::<FakePort>::new();
    {
        let guarded = GuardedInput::new(
            FakePort {
                view: Some(view(s)),
                release_gate: Some(gate.clone()),
                ..Default::default()
            },
            manager.clone(),
        );
        let lease = guarded
            .activate(approval(
                s,
                1,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
        guarded.set_key(&lease, 1, Key::Space, true).unwrap();
        assert_eq!(guarded.shutdown(), Err(InputError::ReleasePending));
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    while manager.pending_count() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(manager.pending_count(), 1);
    gate.store(false, Ordering::SeqCst);
    manager.retry().unwrap();
    assert_eq!(manager.shutdown_ready(), Ok(()));
}

#[test]
fn last_manager_drop_uses_observable_orphan_retry_queue() {
    let _test_guard = serial_guard();
    let mut s = surface();
    s.pid = 4242;
    let gate = Arc::new(AtomicBool::new(true));
    let before = orphaned_pending_count();
    {
        let mut input = NativeInput::new(
            FakePort {
                view: Some(view(s)),
                release_gate: Some(gate.clone()),
                ..Default::default()
            },
            ReleaseManager::new(),
        );
        let lease = input
            .activate(approval(
                s,
                1,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
        input.set_key(&lease, 1, Key::Left, true).unwrap();
        assert_eq!(input.stop(), Err(InputError::ReleasePending));
    }
    assert_eq!(orphaned_pending_count(), before + 1);
    let mut replacement = NativeInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        ReleaseManager::new(),
    );
    assert_eq!(
        replacement
            .activate(approval(
                s,
                2,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1)
            ))
            .err(),
        Some(InputError::ReleasePending)
    );
    gate.store(false, Ordering::SeqCst);
    retry_orphaned_releases().unwrap();
    assert_eq!(orphaned_pending_count(), before);
    replacement
        .activate(approval(
            s,
            2,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
}

#[test]
fn blocked_inventory_delays_watchdog_and_shutdown_reports_busy() {
    let _test_guard = serial_guard();
    let s = surface();
    let block = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let manager = ReleaseManager::<FakePort>::new();
    let guarded = GuardedInput::new(
        FakePort {
            view: Some(view(s)),
            block_inventory: Some(block.clone()),
            entered_inventory: Some(entered.clone()),
            shared_events: Some(events.clone()),
            ..Default::default()
        },
        manager,
    );
    let lease = guarded
        .activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_millis(300),
        ))
        .unwrap();
    guarded.set_key(&lease, 1, Key::Left, true).unwrap();
    block.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_millis(250);
    while !entered.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(entered.load(Ordering::SeqCst));
    std::thread::sleep(Duration::from_millis(330));
    assert_eq!(guarded.shutdown(), Err(InputError::Busy));
    assert!(!events.lock().unwrap().contains(&NativeEvent::Key {
        key: Key::Left,
        down: false
    }));
    block.store(false, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_millis(500);
    while !events.lock().unwrap().contains(&NativeEvent::Key {
        key: Key::Left,
        down: false,
    }) && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(events.lock().unwrap().contains(&NativeEvent::Key {
        key: Key::Left,
        down: false
    }));
    guarded.shutdown().unwrap();
    assert_eq!(
        guarded
            .activate(approval(
                s,
                2,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1)
            ))
            .err(),
        Some(InputError::Stopped)
    );
}

#[test]
fn queued_activation_cannot_cross_successful_shutdown() {
    let _test_guard = serial_guard();
    let s = surface();
    let guarded = Arc::new(GuardedInput::new(
        FakePort {
            view: Some(view(s)),
            ..Default::default()
        },
        ReleaseManager::new(),
    ));
    let entered = Arc::new(AtomicBool::new(false));
    let proceed = Arc::new(AtomicBool::new(false));
    let entered_hook = entered.clone();
    let proceed_hook = proceed.clone();
    guarded.test_install_prelock_hook(Arc::new(move || {
        entered_hook.store(true, Ordering::SeqCst);
        while !proceed_hook.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }));
    let command = guarded.clone();
    let task = std::thread::spawn(move || {
        command.activate(approval(
            s,
            1,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(1),
        ))
    });
    let deadline = Instant::now() + Duration::from_millis(500);
    while !entered.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(entered.load(Ordering::SeqCst));
    loop {
        match guarded.shutdown() {
            Ok(()) => break,
            Err(InputError::Busy) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(2))
            }
            other => panic!("shutdown: {other:?}"),
        }
    }
    proceed.store(true, Ordering::SeqCst);
    assert_eq!(task.join().unwrap().err(), Some(InputError::Stopped));
}

#[test]
fn reused_pid_discards_pending_release_without_targeting_new_process() {
    let _test_guard = serial_guard();
    let s = surface();
    let current = Arc::new(Mutex::new(s.process_identity));
    let gate = Arc::new(AtomicBool::new(true));
    let shared_events = Arc::new(Mutex::new(Vec::new()));
    let manager = ReleaseManager::<FakePort>::new();
    {
        let mut input = NativeInput::new(
            FakePort {
                view: Some(view(s)),
                current_identity: Some(current.clone()),
                release_gate: Some(gate.clone()),
                shared_events: Some(shared_events.clone()),
                ..Default::default()
            },
            manager.clone(),
        );
        let lease = input
            .activate(approval(
                s,
                1,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
        input.set_key(&lease, 1, Key::Left, true).unwrap();
        assert_eq!(input.stop(), Err(InputError::ReleasePending));
    }
    *current.lock().unwrap() = ProcessIdentity {
        start_seconds: s.process_identity.start_seconds + 1,
        ..s.process_identity
    };
    gate.store(false, Ordering::SeqCst);
    let report = manager.retry().unwrap();
    assert_eq!(report.process_ended, 1);
    assert_eq!(report.event_issued, 0);
    assert_eq!(manager.pending_count(), 0);
    assert!(!shared_events.lock().unwrap().contains(&NativeEvent::Key {
        key: Key::Left,
        down: false
    }));
}

#[test]
fn unavailable_identity_lookup_keeps_release_pending() {
    let _test_guard = serial_guard();
    let s = surface();
    let unavailable = Arc::new(AtomicBool::new(true));
    let manager = ReleaseManager::<FakePort>::new();
    {
        let mut input = NativeInput::new(
            FakePort {
                view: Some(view(s)),
                identity_unavailable: Some(unavailable.clone()),
                ..Default::default()
            },
            manager.clone(),
        );
        let lease = input
            .activate(approval(
                s,
                1,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
        input.set_key(&lease, 1, Key::Left, true).unwrap();
        assert_eq!(input.stop(), Err(InputError::ReleasePending));
    }
    assert_eq!(manager.retry(), Err(InputError::ReleasePending));
    assert_eq!(manager.pending_count(), 1);
    unavailable.store(false, Ordering::SeqCst);
    let report = manager.retry().unwrap();
    assert_eq!(report.event_issued, 1);
    assert_eq!(report.process_ended, 0);
}

#[test]
fn original_command_deadline_expires_during_native_preparation_without_ending_user_lease() {
    let _test_guard = serial_guard();
    let s = surface();
    let block = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let guarded = Arc::new(GuardedInput::new(
        FakePort {
            view: Some(view(s)),
            block_emit: Some(block.clone()),
            entered_emit: Some(entered.clone()),
            shared_events: Some(events.clone()),
            ..Default::default()
        },
        ReleaseManager::new(),
    ));
    let lease = Arc::new(
        guarded
            .activate(approval(
                s,
                1,
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(2),
            ))
            .unwrap(),
    );
    block.store(true, Ordering::SeqCst);
    let command = guarded.clone();
    let held = lease.clone();
    let original_deadline = Instant::now() + Duration::from_millis(50);
    let task = std::thread::spawn(move || {
        command.set_key_until(&held, 1, Key::Left, true, original_deadline)
    });
    let wait_until = Instant::now() + Duration::from_millis(300);
    while !entered.load(Ordering::SeqCst) && Instant::now() < wait_until {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(entered.load(Ordering::SeqCst));
    std::thread::sleep(Duration::from_millis(70));
    block.store(false, Ordering::SeqCst);
    assert_eq!(task.join().unwrap(), Err(InputError::Expired));
    assert!(events.lock().unwrap().is_empty());
    let already_expired = Instant::now() - Duration::from_millis(1);
    assert_eq!(
        guarded.move_pointer_until(&lease, 1, 0.5, 0.5, already_expired),
        Err(InputError::Expired)
    );
    assert_eq!(
        guarded.set_button_until(&lease, 1, Button::Left, true, 0.5, 0.5, already_expired),
        Err(InputError::Expired)
    );
    assert!(events.lock().unwrap().is_empty());
    guarded
        .set_key_until(
            &lease,
            1,
            Key::Left,
            true,
            Instant::now() + Duration::from_millis(100),
        )
        .unwrap();
    assert_eq!(
        events.lock().unwrap().as_slice(),
        &[NativeEvent::Key {
            key: Key::Left,
            down: true
        }]
    );
    guarded.stop().unwrap();
}
