package com.plugin.apk_updater

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.view.inputmethod.InputMethodManager
import android.os.Build
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.PermissionState
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.plugin.JSObject
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

@InvokeArg
class OpenLinkArgs {
    var url: String = ""
    var name: String = ""
}

@InvokeArg
class LocalNetworkArgs {
    var ask: Boolean = true
}

@TauriPlugin(
    permissions = [Permission(strings = ["android.permission.ACCESS_LOCAL_NETWORK"], alias = "localNetwork")]
)
class ApkUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    // Google TV: when nothing in the page has focus, Android framed the whole WebView as the focused view
    private var web: WebView? = null

    override fun load(webView: WebView) {
        super.load(webView)
        web = webView
        if (Build.VERSION.SDK_INT >= 26) {
            // also on the views holding the WebView: the focus can land on them (Back on a TV)
            var v: View? = webView
            while (v != null) {
                v.defaultFocusHighlightEnabled = false
                v = v.parent as? View
            }
            activity.window.decorView.defaultFocusHighlightEnabled = false
        }
    }

    // Google TV opens no keyboard for a text field focused with the remote: show it for the focused field
    @Command
    fun showKeyboard(invoke: Invoke) {
        val view = web ?: return invoke.reject("no WebView")
        view.postDelayed({
            view.requestFocus()
            WindowCompat.getInsetsController(activity.window, view).show(WindowInsetsCompat.Type.ime())
            activity.getSystemService(InputMethodManager::class.java)?.showSoftInput(view, 0)
        }, 120)
        invoke.resolve()
    }

    // A streaming link: the service's app (or the browser) opens it. A TV has no browser and some TV apps take
    // no links (Emby, Oneplay, Prima+): then the service's app is opened, found among the installed apps by name.
    @Command
    fun openLink(invoke: Invoke) {
        val args = invoke.parseArgs(OpenLinkArgs::class.java)
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(args.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Android TV answers a web link it has no app for with a stub that only says "you don't have an app
        // that can do this" (com.google.android.tv.frameworkpackagestubs): such a stub is no app for the link
        val handlers = activity.packageManager
            .queryIntentActivities(view, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY or android.content.pm.PackageManager.GET_META_DATA)
            .filter { r ->
                val pkg = r.activityInfo.packageName
                !pkg.contains("frameworkpackagestubs") && r.activityInfo.metaData?.getBoolean("com.android.tv.stub") != true
            }
        if (handlers.isNotEmpty()) {
            try {
                activity.startActivity(view)
                return invoke.resolve(JSObject().apply { put("opened", "link") })
            } catch (e: ActivityNotFoundException) {
                Log.i("ApkUpdater", "no app for ${args.url}")
            }
        }
        val norm = { s: String -> s.lowercase().filter { it.isLetterOrDigit() } }
        val want = norm(args.name)
        if (want.length >= 2) {
            val pm = activity.packageManager
            for (category in listOf("android.intent.category.LEANBACK_LAUNCHER", Intent.CATEGORY_LAUNCHER)) {
                val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(category), 0)
                    .filter { it.activityInfo.packageName != activity.packageName }
                val label = { r: android.content.pm.ResolveInfo -> norm(r.loadLabel(pm).toString()) }
                val hit = apps.firstOrNull { label(it) == want }
                    ?: apps.firstOrNull { val l = label(it); l.length >= 3 && (l.startsWith(want) || want.startsWith(l)) }
                if (hit != null) {
                    activity.startActivity(Intent(Intent.ACTION_MAIN).addCategory(category)
                        .setClassName(hit.activityInfo.packageName, hit.activityInfo.name)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    return invoke.resolve(JSObject().apply {
                        put("opened", "app"); put("app", hit.loadLabel(pm).toString())
                    })
                }
            }
        }
        invoke.resolve(JSObject().apply { put("opened", "none") })
    }

    init {
        // Android 15+ draws apps edge to edge: keep the WebView out from under the status and navigation bars
        // (the gap shows the dark window background)
        // The keyboard shrinks the WebView too (instead of panning the whole page up), so the top bar and
        // the search field stay in place while typing.
        @Suppress("DEPRECATION")
        activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        // The padding below is the only thing that makes room for the bars and the keyboard, on every Android
        // version. (Before Android 15 the system also shrank the window for the keyboard, and with the padding
        // on top of that an empty gap as tall as the keyboard opened above it.)
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        val content = activity.findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
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
                ContextCompat.startForegroundService(activity, intent)
            }
            invoke.resolve()
        } catch (e: Exception) {
            Log.w("ApkUpdater", "background service", e)
            invoke.reject(e.message ?: e.toString())
        }
    }

    // The sync runs as a foreground service without asking for the notification permission: on Android 13+
    // its notice then stays out of the notification drawer (only the system's list of running apps shows it);
    // Android 12 and older always show it.

    // Android 17: access to the home network (the user's media servers) needs a runtime permission.
    // Resolves { granted }; with ask=false (a sync running in the background) it only checks.
    @Command
    fun localNetwork(invoke: Invoke) {
        val args = invoke.parseArgs(LocalNetworkArgs::class.java)
        if (Build.VERSION.SDK_INT < 37 || getPermissionState("localNetwork") == PermissionState.GRANTED) {
            invoke.resolve(JSObject().apply { put("granted", true) })
        } else if (!args.ask) {
            invoke.resolve(JSObject().apply { put("granted", false) })
        } else {
            requestPermissionForAlias("localNetwork", invoke, "localNetworkResult")
        }
    }

    @PermissionCallback
    private fun localNetworkResult(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("granted", getPermissionState("localNetwork") == PermissionState.GRANTED) })
    }
}
