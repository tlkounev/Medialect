package com.plugin.apk_updater

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/** Keeps the app process (and its WebView doing the synchronisation) alive while a sync runs. */
class SyncService : Service() {
    companion object {
        const val CHANNEL = "medialect-sync"
        const val ID = 4711
        @Volatile var instance: SyncService? = null
        var title = "Medialect"
        var text = ""
        var percent = -1

        fun build(ctx: Context): Notification {
            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
                ?: ctx.packageManager.getLeanbackLaunchIntentForPackage(ctx.packageName)
            val tap = launch?.let {
                PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            return NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setContentIntent(tap)
                .setProgress(100, maxOf(percent, 0), percent < 0)
                .build()
        }

        fun update(ctx: Context) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(ID, build(ctx))
        }
    }

    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Synchronizace", NotificationManager.IMPORTANCE_LOW))
        }
        // the CPU keeps running with the screen off; released when the sync ends (at most 6 h)
        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "medialect:sync").apply { acquire(6 * 3600 * 1000L) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ID, build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(ID, build(this))
        }
        return START_NOT_STICKY   // never restarted without the app: the sync itself lives in the WebView
    }

    override fun onTimeout(startId: Int, fgsType: Int) {   // Android 15: daily limit for dataSync reached
        stopSelf()
    }

    override fun onDestroy() {
        instance = null
        wake?.let { if (it.isHeld) it.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
