//! 生成期间的"保活"：
//! - iOS：`UIApplication.beginBackgroundTaskWithExpirationHandler:` 换取约 30s 的后台宽限，结束时 `endBackgroundTask:`
//! - Android：起一个前台服务（通知"正在生成…"），系统不杀进程，流可以收到结束；结束时停掉
//! - 桌面：无需
//!
//! UIKit 调用必须在主线程；Android 走 JNI 调 `dev.coredump119.tavern.GenerationService.setGenerating(Context, boolean)`。

#[cfg(target_os = "ios")]
mod imp {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    /// UIBackgroundTaskInvalid
    pub const INVALID: usize = usize::MAX;

    /// 主线程调用
    pub fn begin() -> usize {
        unsafe {
            let app: *mut AnyObject = msg_send![objc2::class!(UIApplication), sharedApplication];
            if app.is_null() {
                return INVALID;
            }
            let handler: *const core::ffi::c_void = core::ptr::null();
            let id: usize = msg_send![app, beginBackgroundTaskWithExpirationHandler: handler];
            id
        }
    }

    /// 主线程调用
    pub fn end(id: usize) {
        if id == INVALID {
            return;
        }
        unsafe {
            let app: *mut AnyObject = msg_send![objc2::class!(UIApplication), sharedApplication];
            if app.is_null() {
                return;
            }
            let _: () = msg_send![app, endBackgroundTask: id];
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    use jni::objects::{JClass, JObject, JValue};

    /// 任意线程调用（JNI attach）
    pub fn set_generating(active: bool) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let result = call(&mut env, &context, active);
        // 留着没清的 Java 异常会在线程返回时把整个进程带崩；保活失败只是少一条通知，不该中断生成
        if result.is_err() && env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        result
    }

    fn call(env: &mut jni::JNIEnv, context: &JObject, active: bool) -> Result<(), String> {
        let loader = env
            .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .and_then(|v| v.l())
            .map_err(|e| e.to_string())?;
        let name = env
            .new_string("dev.coredump119.tavern.GenerationService")
            .map_err(|e| e.to_string())?;
        let cls = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )
            .and_then(|v| v.l())
            .map_err(|e| e.to_string())?;
        let cls = JClass::from(cls);
        env.call_static_method(
            cls,
            "setGenerating",
            "(Landroid/content/Context;Z)V",
            &[JValue::Object(context), JValue::Bool(u8::from(active))],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

use std::sync::{Arc, Mutex};

/// 一次生成持有的保活令牌
#[derive(Default)]
pub struct Keepalive {
    #[cfg(target_os = "ios")]
    task: Arc<Mutex<Option<usize>>>,
    #[cfg(not(target_os = "ios"))]
    _unused: Arc<Mutex<()>>,
}

impl Keepalive {
    /// 生成开始：iOS 在主线程申请 background task；Android 起前台服务
    pub fn begin(&self, app: &tauri::AppHandle) -> Result<(), String> {
        #[cfg(target_os = "ios")]
        {
            let slot = self.task.clone();
            app.run_on_main_thread(move || {
                let id = imp::begin();
                if let Ok(mut s) = slot.lock() {
                    *s = Some(id);
                }
            })
            .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "android")]
        {
            let _ = app;
            imp::set_generating(true)?;
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            let _ = app;
        }
        Ok(())
    }

    /// 生成结束（无论成败）
    pub fn end(&self, app: &tauri::AppHandle) {
        #[cfg(target_os = "ios")]
        {
            let slot = self.task.clone();
            let _ = app.run_on_main_thread(move || {
                if let Ok(mut s) = slot.lock() {
                    if let Some(id) = s.take() {
                        imp::end(id);
                    }
                }
            });
        }
        #[cfg(target_os = "android")]
        {
            let _ = app;
            if let Err(e) = imp::set_generating(false) {
                eprintln!("[background] stop foreground service failed: {e}");
            }
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            let _ = app;
        }
    }
}
