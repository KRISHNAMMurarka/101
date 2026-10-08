//! Native confirmation is separate from renderer requests and OS permission.
//! https://developer.apple.com/documentation/corefoundation/cfusernotification

use crate::native_input::{Surface, TargetLabel};

fn accepted(status: i32, response: usize) -> bool {
    // Cancel is the default button. Only the explicit alternate Allow button
    // grants authority; errors, timeout and unfamiliar response flags deny.
    status == 0 && response == 1
}

#[cfg(target_os = "macos")]
pub fn confirm(surface: Surface, label: &TargetLabel) -> bool {
    use std::ffi::{c_char, c_void, CString};
    use std::ptr;
    type CFString = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> CFString;
        fn CFRelease(value: *const c_void);
        fn CFUserNotificationDisplayAlert(timeout: f64, flags: usize, icon: *const c_void,
            sound: *const c_void, localization: *const c_void, header: CFString,
            message: CFString, default_button: CFString, alternate_button: CFString,
            other_button: CFString, response: *mut usize) -> i32;
    }
    if label.application.trim().is_empty() || label.window.trim().is_empty() { return false; }
    let message = format!("Allow 101 to send pointer input and arrow keys, Space, Return, Escape and Tab to {} — {}, window {}, application PID {}, on display {}, for up to 30 seconds? Switching windows stops control. Stop remains available in the Hub.", label.application, label.window, surface.window_id, surface.pid, surface.display_id);
    let texts = ["Allow control of this window?", message.as_str(), "Cancel", "Allow"];
    let mut strings = Vec::new();
    for text in texts {
        let Ok(text) = CString::new(text) else { return false; };
        let value = unsafe { CFStringCreateWithCString(ptr::null(), text.as_ptr(), 0x0800_0100) };
        if value.is_null() {
            for value in strings { unsafe { CFRelease(value); } }
            return false;
        }
        strings.push(value);
    }
    let mut response = 3;
    let status = unsafe { CFUserNotificationDisplayAlert(30.0, 0, ptr::null(), ptr::null(), ptr::null(),
        strings[0], strings[1], strings[2], strings[3], ptr::null(), &mut response) };
    for value in strings { unsafe { CFRelease(value); } }
    accepted(status, response)
}

#[cfg(not(target_os = "macos"))]
pub fn confirm(_surface: Surface, _label: &TargetLabel) -> bool { false }

#[cfg(test)]
mod tests {
    use super::accepted;
    #[test]
    fn only_explicit_allow_grants_native_authority() {
        assert!(accepted(0, 1));
        for response in [0, 2, 3, 4, usize::MAX] { assert!(!accepted(0, response)); }
        assert!(!accepted(-1, 1));
        assert!(!accepted(1, 1));
    }
}
