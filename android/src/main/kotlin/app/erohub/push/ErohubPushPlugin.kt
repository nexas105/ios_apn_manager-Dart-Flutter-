package app.erohub.push

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

private const val CHANNEL_NAME = "ios_apn_manager"
private const val DEFAULT_CHANNEL_ID = "erohub_default"
private const val DEFAULT_CHANNEL_NAME = "EroHub Benachrichtigungen"
private const val POST_NOTIFICATIONS_REQUEST_CODE = 0xE40B

/// Android side of the ios_apn_manager Flutter plugin.
///
/// Mirrors the iOS plugin's MethodChannel surface (channel name `ios_apn_manager`).
/// Methods handled: requestPermission, setBadgeCount (no-op on Android),
/// scheduleLocalNotification, cancelAllNotifications.
///
/// Native → Dart events (matching iOS):
///   - onToken(String)
///   - onMessage(Map)
///   - onNotificationTap(Map)
class ErohubPushPlugin :
    FlutterPlugin,
    ActivityAware,
    MethodChannel.MethodCallHandler,
    PluginRegistry.RequestPermissionsResultListener {

    private lateinit var channel: MethodChannel
    private lateinit var appContext: Context
    private var activity: Activity? = null
    private var permissionResult: MethodChannel.Result? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel.setMethodCallHandler(this)

        ensureDefaultChannel(appContext)

        // Register a single static dispatcher so FcmService can forward events.
        PushDispatcher.bind(channel)

        // Cold-start tap: if MainActivity was launched from a notification tap,
        // the intent extras carry the data payload. Surface it once so PushService
        // can route navigation.
        flushColdStartTapIfAny()

        // If a permission was granted previously and the OS has a token cached,
        // re-emit it so PushRepo upserts on app launch.
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                task.result?.let { PushDispatcher.emitToken(it) }
            }
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        PushDispatcher.unbind()
    }

    // ── ActivityAware ─────────────────────────────────────────────────────────

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() { activity = null }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
        binding.addRequestPermissionsResultListener(this)
    }
    override fun onDetachedFromActivity() { activity = null }

    // ── Method dispatch ───────────────────────────────────────────────────────

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "requestPermission" -> requestPermission(result)
            "setBadgeCount" -> result.success(null) // Android has no app badge API
            "scheduleLocalNotification" -> result.success("") // out of scope for now
            "cancelAllNotifications" -> {
                val nm = appContext.getSystemService(Context.NOTIFICATION_SERVICE)
                    as NotificationManager
                nm.cancelAll()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun requestPermission(result: MethodChannel.Result) {
        // < Android 13: notifications are granted at install time.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.success(true)
            fetchTokenAndEmit()
            return
        }

        val permission = Manifest.permission.POST_NOTIFICATIONS
        val granted = ContextCompat.checkSelfPermission(appContext, permission) ==
            PackageManager.PERMISSION_GRANTED

        if (granted) {
            result.success(true)
            fetchTokenAndEmit()
            return
        }

        val act = activity
        if (act == null) {
            result.success(false)
            return
        }
        permissionResult = result
        act.requestPermissions(arrayOf(permission), POST_NOTIFICATIONS_REQUEST_CODE)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != POST_NOTIFICATIONS_REQUEST_CODE) return false
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        permissionResult?.success(granted)
        permissionResult = null
        if (granted) fetchTokenAndEmit()
        return true
    }

    private fun fetchTokenAndEmit() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                task.result?.let { PushDispatcher.emitToken(it) }
            } else {
                PushDispatcher.emitTokenError(task.exception?.message ?: "unknown")
            }
        }
    }

    private fun flushColdStartTapIfAny() {
        val intent = activity?.intent ?: return
        val extras = intent.extras ?: return
        if (extras.isEmpty) return

        // FCM data-only messages put their payload directly in the intent extras
        // when the user taps a notification (notification + data hybrid messages
        // also include data). We mark consumed via a sentinel so the same intent
        // isn't forwarded twice on configuration change.
        if (extras.getBoolean("erohub_tap_consumed", false)) return

        val payload = HashMap<String, Any?>()
        for (key in extras.keySet()) {
            // Skip Android system / FCM internal keys.
            if (key.startsWith("google.") || key.startsWith("gcm.") ||
                key == "from" || key == "collapse_key" || key == "erohub_tap_consumed") continue
            payload[key] = extras.get(key)
        }
        if (payload.isNotEmpty()) {
            extras.putBoolean("erohub_tap_consumed", true)
            PushDispatcher.emitTap(payload)
        }
    }

    private fun ensureDefaultChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(DEFAULT_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            DEFAULT_CHANNEL_ID,
            DEFAULT_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Wichtige Benachrichtigungen aus EroHub"
            enableLights(true)
            enableVibration(true)
        }
        nm.createNotificationChannel(channel)
    }
}
