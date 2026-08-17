package app.erohub.push

import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodChannel

/// Process-wide singleton bridging FcmService → MethodChannel.
///
/// FcmService runs in a separate process context; FlutterPlugin holds the
/// MethodChannel. This dispatcher decouples them so messages received while
/// the engine is alive are forwarded immediately, and others are dropped
/// (FCM also delivers a system notification, so the user still sees it).
object PushDispatcher {
    private var channel: MethodChannel? = null
    private val main = Handler(Looper.getMainLooper())

    fun bind(channel: MethodChannel) {
        this.channel = channel
    }

    fun unbind() {
        channel = null
    }

    fun emitToken(token: String) = main.post {
        channel?.invokeMethod("onToken", token)
    }

    fun emitTokenError(error: String) = main.post {
        channel?.invokeMethod("onTokenError", error)
    }

    fun emitMessage(payload: Map<String, Any?>) = main.post {
        channel?.invokeMethod("onMessage", payload)
    }

    fun emitTap(payload: Map<String, Any?>) = main.post {
        channel?.invokeMethod("onNotificationTap", payload)
    }
}
