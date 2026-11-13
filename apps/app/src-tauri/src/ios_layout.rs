//! iOS-only workaround: WebKit can size the layout viewport to the safe-area height
//! (bounds − insets) while still placing content at y=0 and reporting
//! env(safe-area-inset-*) — leaving a blank strip under the page. Any later frame change
//! (e.g. rotation) recomputes it correctly.
//!
//! Two steps: the scroll view is told up front never to adjust for the safe area (the cause),
//! and once a page has loaded the WKWebView frame is nudged by 1pt and restored (a relayout,
//! for a viewport that was sized before the first step took hold).
//! Observed with tauri 2.12 / wry 0.57 / tao 0.37 on iOS 18.2. TODO: upstream.

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_core_foundation::CGRect;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, Webview};

/// `UIScrollViewContentInsetAdjustmentNever`
const INSET_ADJUSTMENT_NEVER: isize = 2;

/// Stop the scroll view from taking the safe area out of the layout viewport. The page asks for
/// this itself (`viewport-fit=cover`), but WebKit hears about it from the web process some time
/// after the first layout and does not lay out again, which is the blank strip.
///
/// # Safety
/// `wk` is a live `WKWebView`, on the main thread.
unsafe fn pin_insets(wk: *mut AnyObject) {
    let scroll: *mut AnyObject = msg_send![wk, scrollView];
    if !scroll.is_null() {
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: INSET_ADJUSTMENT_NEVER];
    }
}

/// Before the first page: the windows from the config exist by the time `setup` runs.
pub fn on_setup(app: &tauri::App) {
    for window in app.webview_windows().values() {
        let _ = window.with_webview(|platform| unsafe {
            let wk: *mut AnyObject = platform.inner().cast();
            if !wk.is_null() {
                pin_insets(wk);
            }
        });
    }
}

pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    let finished = payload.event() == PageLoadEvent::Finished;
    let _ = webview.with_webview(move |platform| unsafe {
        let wk: *mut AnyObject = platform.inner().cast();
        if wk.is_null() {
            return;
        }
        pin_insets(wk);
        if !finished {
            return;
        }
        let superview: *mut AnyObject = msg_send![wk, superview];
        if superview.is_null() {
            return;
        }
        let bounds: CGRect = msg_send![superview, bounds];
        let mut nudged = bounds;
        nudged.size.height -= 1.0;
        let _: () = msg_send![wk, setFrame: nudged];
        let _: () = msg_send![wk, setFrame: bounds];
    });
}
