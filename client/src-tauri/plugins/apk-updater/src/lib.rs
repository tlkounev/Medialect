//! Android-only helpers.
//! - background: foreground service with a progress notification while a synchronisation runs.
//! - sleep: a pause that is not throttled when the WebView is hidden.
//! - probe: plain TCP connect to host:port, to tell the user why a media server cannot be reached
//!   (the HTTP client only reports "error sending request").
//! App updates are downloaded in the browser and installed by the system (no REQUEST_INSTALL_PACKAGES).
use serde::Deserialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRequest {
    pub active: bool,
    pub title: String,
    pub text: String,
    pub percent: i32,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepRequest {
    pub ms: u64,
}

#[cfg(mobile)]
pub struct ApkUpdater<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[cfg(not(mobile))]
pub struct ApkUpdater<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> ApkUpdater<R> {
    pub fn local_network(&self, req: LocalNetworkRequest) -> Result<serde_json::Value> {
        #[cfg(mobile)]
        {
            self.0.run_mobile_plugin::<serde_json::Value>("localNetwork", req).map_err(Into::into)
        }
        #[cfg(not(mobile))]
        {
            let _ = req;
            Ok(serde_json::json!({ "granted": true }))
        }
    }

    pub fn background(&self, req: BackgroundRequest) -> Result<()> {
        #[cfg(mobile)]
        {
            self.0.run_mobile_plugin::<()>("background", req).map_err(Into::into)
        }
        #[cfg(not(mobile))]
        {
            let _ = req;
            Err(Error::Unsupported)
        }
    }
}

#[tauri::command]
async fn background<R: Runtime>(app: tauri::AppHandle<R>, active: bool, title: String, text: String, percent: i32) -> Result<()> {
    app.state::<ApkUpdater<R>>().background(BackgroundRequest { active, title, text, percent })
}

#[tauri::command]
async fn sleep(ms: u64) -> Result<()> {
    // async command: runs on the async runtime, so the pause does not block anything
    tokio::time::sleep(std::time::Duration::from_millis(ms.min(600_000))).await;
    Ok(())
}

/// "open" | "refused" | "timeout" | "dns" | "unreachable: <os error>"
#[tauri::command]
async fn probe(host: String, port: u16) -> Result<String> {
    let res = tauri::async_runtime::spawn_blocking(move || {
        use std::net::{TcpStream, ToSocketAddrs};
        let addrs: Vec<_> = match (host.as_str(), port).to_socket_addrs() {
            Ok(a) => a.collect(),
            Err(_) => return "dns".to_string(),
        };
        if addrs.is_empty() {
            return "dns".to_string();
        }
        let mut last = "timeout".to_string();
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(4)) {
                Ok(_) => return "open".to_string(),
                Err(e) => {
                    last = match e.kind() {
                        std::io::ErrorKind::ConnectionRefused => "refused".to_string(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "timeout".to_string(),
                        _ => format!("unreachable: {e}"),
                    }
                }
            }
        }
        last
    })
    .await;
    Ok(res.unwrap_or_else(|_| "timeout".to_string()))
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct LocalNetworkRequest {
    pub ask: bool,
}

#[tauri::command]
async fn local_network<R: Runtime>(app: tauri::AppHandle<R>, ask: bool) -> Result<serde_json::Value> {
    app.state::<ApkUpdater<R>>().local_network(LocalNetworkRequest { ask })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .invoke_handler(tauri::generate_handler![background, sleep, probe, local_network])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let updater = ApkUpdater(api.register_android_plugin("com.plugin.apk_updater", "ApkUpdaterPlugin")?);
            #[cfg(target_os = "ios")]
            let updater: ApkUpdater<R> = { let _ = api; return Err("not supported on iOS".into()); };
            #[cfg(not(mobile))]
            let updater = { let _ = api; ApkUpdater::<R>(std::marker::PhantomData::<fn() -> R>) };
            app.manage(updater);
            Ok(())
        })
        .build()
}
