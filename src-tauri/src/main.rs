// The whole app is the web frontend in ../src; this just hosts it in a native window.

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer crashes on some Linux setups (notably NVIDIA on Wayland:
    // "Error 71 (Protocol error) dispatching to Wayland display"). The fallback renderer
    // is plenty fast for this app. Set the variable to 0 to opt back in.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Probagraph");
}
