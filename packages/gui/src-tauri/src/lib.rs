// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Tracks the sidecar's own announced port (task 5.3: "Wire the Rust
/// shell to read the sidecar's announced port ... and pass it to the
/// React frontend on startup"). `port` starts `None` — the sidecar
/// process takes a moment to bind and print its port line, and the
/// frontend may finish mounting before that happens — so `sidecar_port`
/// is a poll-able command rather than a fire-once value, while the
/// `sidecar-port` event covers the common case where the frontend is
/// already listening when the port becomes known.
struct SidecarState {
    port: Mutex<Option<u16>>,
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn sidecar_port(state: State<SidecarState>) -> Option<u16> {
    *state.port.lock().expect("sidecar port mutex poisoned")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState {
            port: Mutex::new(None),
            child: Mutex::new(None),
        })
        .setup(|app| {
            // "trellis-gui-sidecar" here must match tauri.conf.json's
            // `bundle.externalBin` entry (sans platform-triple suffix,
            // which Tauri appends itself) and the capability grant in
            // `capabilities/default.json` scoping `shell:allow-execute`
            // to this exact sidecar name.
            let (mut rx, child) = app
                .shell()
                .sidecar("trellis-gui-sidecar")
                .expect("trellis-gui-sidecar is not a registered externalBin — check tauri.conf.json")
                .spawn()
                .expect("failed to spawn the trellis-gui sidecar process");

            app.state::<SidecarState>()
                .child
                .lock()
                .expect("sidecar child mutex poisoned")
                .replace(child);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // The sidecar's only stdout contract (sidecar/index.ts's
                // `main()`): the first and only line is
                // `TRELLIS_SIDECAR_PORT=<port>`. Any other stdout output
                // would be a real bug in the sidecar, not something this
                // loop should try to interpret — it only ever looks for
                // that one prefix and ignores everything else.
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line_bytes) = event {
                        let line = String::from_utf8_lossy(&line_bytes);
                        if let Some(port_str) = line.trim().strip_prefix("TRELLIS_SIDECAR_PORT=") {
                            if let Ok(port) = port_str.parse::<u16>() {
                                handle
                                    .state::<SidecarState>()
                                    .port
                                    .lock()
                                    .expect("sidecar port mutex poisoned")
                                    .replace(port);
                                let _ = handle.emit("sidecar-port", port);
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Task 5.2: `tauri build` must produce an app that "cleanly
            // terminates [the sidecar] on quit (no orphaned process)" —
            // tauri-plugin-shell's spawned child is a real OS child
            // process that is NOT automatically reaped when the Tauri
            // window closes, so it is killed explicitly here rather than
            // left to whatever the OS does with an orphaned process.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(child) = window
                    .state::<SidecarState>()
                    .child
                    .lock()
                    .expect("sidecar child mutex poisoned")
                    .take()
                {
                    let _ = child.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, sidecar_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
