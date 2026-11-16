//! Android only: the app's cache folder, and reading files the system picker hands over as
//! `content://` addresses (DEV_NOTES §9.46). Both go through JNI; the copying itself is done by
//! `dev.coredump119.tavern.PickedFiles` on the Kotlin side.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use jni::objects::{JClass, JObject, JString, JValue};
use jni::JNIEnv;

const PICKED_FILES_CLASS: &str = "dev.coredump119.tavern.PickedFiles";

/// Attach to the JVM and run `f` with the app context. A Java exception left pending would take
/// the process down when the thread returns, so it is turned into the error text and cleared.
fn with_env<T>(
    f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    f(&mut env, &context).map_err(|e| pending_exception(&mut env).unwrap_or_else(|| e.to_string()))
}

/// Text of the pending Java exception, which is cleared.
fn pending_exception(env: &mut JNIEnv) -> Option<String> {
    if !env.exception_check().unwrap_or(false) {
        return None;
    }
    let thrown = env.exception_occurred().ok()?;
    let _ = env.exception_clear();
    let text = env
        .call_method(&thrown, "toString", "()Ljava/lang/String;", &[])
        .and_then(|v| v.l())
        .ok()?;
    java_string(env, text).ok()
}

fn java_string(env: &mut JNIEnv, obj: JObject) -> jni::errors::Result<String> {
    Ok(env.get_string(&JString::from(obj))?.into())
}

/// The app's cache folder. `std::env::temp_dir()` points at a folder apps cannot write to.
pub fn cache_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        with_env(|env, context| {
            let dir = env
                .call_method(context, "getCacheDir", "()Ljava/io/File;", &[])?
                .l()?;
            let path = env
                .call_method(&dir, "getAbsolutePath", "()Ljava/lang/String;", &[])?
                .l()?;
            java_string(env, path)
        })
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
    })
    .clone()
}

/// Copy the file behind a `content://` address into `dir`, under the name the picker showed.
pub fn copy_content(uri: &str, dir: &Path) -> Result<PathBuf, String> {
    with_env(|env, context| {
        // classes of the app are only visible through its own class loader on a native thread
        let loader = env
            .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let class_name = env.new_string(PICKED_FILES_CLASS)?;
        let class = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&class_name)],
            )?
            .l()?;
        let uri = env.new_string(uri)?;
        let dir = env.new_string(dir.to_string_lossy())?;
        let copy = env
            .call_static_method(
                JClass::from(class),
                "copyTo",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(context),
                    JValue::Object(&uri),
                    JValue::Object(&dir),
                ],
            )?
            .l()?;
        java_string(env, copy)
    })
    .map(PathBuf::from)
}
