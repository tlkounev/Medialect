//! Android-only: downloads a newer APK and hands it to the system PackageInstaller.
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

#[cfg(mobile)]
pub struct ApkUpdater<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[cfg(not(mobile))]
pub struct ApkUpdater<R: Runtime>(std::marker::PhantomData<R>);

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
}

#[tauri::command]
async fn install<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<()> {
    app.state::<ApkUpdater<R>>().install(InstallRequest { url })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .invoke_handler(tauri::generate_handler![install])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let updater = ApkUpdater(api.register_android_plugin("com.plugin.apk_updater", "ApkUpdaterPlugin")?);
            #[cfg(target_os = "ios")]
            let updater: ApkUpdater<R> = { let _ = api; return Err("not supported on iOS".into()); };
            #[cfg(not(mobile))]
            let updater = { let _ = api; ApkUpdater::<R>(std::marker::PhantomData) };
            app.manage(updater);
            Ok(())
        })
        .build()
}
