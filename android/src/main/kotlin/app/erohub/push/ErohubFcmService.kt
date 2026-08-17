package app.erohub.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/// Receives FCM messages on Android.
///
/// Behavior:
///   - Foreground: forwards payload to Dart via PushDispatcher.emitMessage().
///     Android does NOT auto-display notifications when the app is in the
///     foreground (different from iOS). Dart side renders an in-app banner.
///   - Background: FCM auto-displays the notification (because we send the
///     `notification` block from the Edge Function). Tap routing happens via
///     ErohubPushPlugin.flushColdStartTapIfAny() on Activity launch.
///   - Token refresh: forwarded so PushRepo can upsert.
class ErohubFcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        PushDispatcher.emitToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val payload = HashMap<String, Any?>()
        // 1. data block (always strings on FCM v1)
        payload.putAll(message.data)
        // 2. notification metadata (title/body) for in-app banner rendering
        message.notification?.let {
            it.title?.let { t -> payload["title"] = t }
            it.body?.let { b -> payload["body"] = b }
        }
        PushDispatcher.emitMessage(payload)
    }
}
