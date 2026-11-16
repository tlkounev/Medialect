package com.plugin.apk_updater

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.view.View
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class BackgroundArgs {
    var active: Boolean = false
    var title: String = "Medialect"
    var text: String = ""
    var percent: Int = -1
}

@TauriPlugin
class ApkUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    init {
        // Android 15+ draws apps edge to edge: keep the WebView out from under the status and navigation bars
        // (the gap shows the dark window background)
        val content = activity.findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(content)
    }

    // foreground service while a synchronisation runs; started while the app is visible (a sync starts
    // from the UI or the timer of the open app), later calls only update its notification
    @Command
    fun background(invoke: Invoke) {
        val args = invoke.parseArgs(BackgroundArgs::class.java)
        try {
            SyncService.title = args.title
            SyncService.text = args.text
            SyncService.percent = args.percent
            val intent = Intent(activity, SyncService::class.java)
            if (!args.active) {
                activity.stopService(intent)
            } else if (SyncService.instance != null) {
                SyncService.update(activity)
            } else {
                askNotifications()
                ContextCompat.startForegroundService(activity, intent)
            }
            invoke.resolve()
        } catch (e: Exception) {
            Log.w("ApkUpdater", "background service", e)
            invoke.reject(e.message ?: e.toString())
        }
    }

    // Android 13+: the progress notification needs the permission; asked once, the sync runs either way
    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = activity.getSharedPreferences("medialect", Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4711)
    }
}
