package com.plugin.apk_updater

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.net.HttpURLConnection
import java.net.URL

@InvokeArg
class InstallArgs {
    var url: String = ""
}

@InvokeArg
class BackgroundArgs {
    var active: Boolean = false
    var title: String = "Medialect"
    var text: String = ""
    var percent: Int = -1
}

@TauriPlugin
class ApkUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    private val action = "${activity.packageName}.APK_UPDATE_STATUS"

    // PackageInstaller reports the result here; when the system wants a confirmation,
    // its dialog is opened (first update, Android < 12, or installing from unknown sources not allowed yet).
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(confirm)
                }
            } else {
                Log.i("ApkUpdater", "install status $status: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
            }
        }
    }

    init {
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    @Command
    fun install(invoke: Invoke) {
        val args = invoke.parseArgs(InstallArgs::class.java)
        Thread {
            try {
                val installer = activity.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(activity.packageName)
                if (Build.VERSION.SDK_INT >= 31) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    val conn = URL(args.url).openConnection() as HttpURLConnection
                    conn.instanceFollowRedirects = true
                    conn.connectTimeout = 20000
                    conn.readTimeout = 60000
                    if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode}")
                    val size = conn.contentLengthLong
                    conn.inputStream.use { input ->
                        session.openWrite("medialect.apk", 0, if (size > 0) size else -1).use { out ->
                            input.copyTo(out)
                            session.fsync(out)
                        }
                    }
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                        (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val pending = PendingIntent.getBroadcast(activity, sessionId, Intent(action).setPackage(activity.packageName), flags)
                    session.commit(pending.intentSender)
                }
                invoke.resolve()
            } catch (e: Exception) {
                Log.e("ApkUpdater", "update failed", e)
                invoke.reject(e.message ?: e.toString())
            }
        }.start()
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
