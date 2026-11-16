//! Android-only helpers.
//! - install: downloads a newer APK and hands it to the system PackageInstaller.
//! - background: foreground service with a progress notification while a synchronisation runs.
//! - sleep: a pause that is not throttled when the WebView is hidden.
//! On Android 12+ the update installs without a prompt once the app may install apps
//! (it is updating itself); older systems show the usual confirmation.
use serde::Deserialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub url: String,
}

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
    pub fn install(&self, req: InstallRequest) -> Result<()> {
        #[cfg(mobile)]
        {
            self.0.run_mobile_plugin::<()>("install", req).map_err(Into::into)
        }
        #[cfg(not(mobile))]
        {
            let _ = req;
            Err(Error::Unsupported)
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
async fn install<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<()> {
    app.state::<ApkUpdater<R>>().install(InstallRequest { url })
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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .invoke_handler(tauri::generate_handler![install, background, sleep])
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
