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

    /// Last token delivered to the current engine. The token is requested from
    /// several places (engine attach, requestPermission, onNewToken), so the
    /// same value would otherwise reach Dart up to three times per launch.
    private var lastEmittedToken: String? = null

    fun bind(channel: MethodChannel) {
        this.channel = channel
        main.post { lastEmittedToken = null }
    }

    fun unbind() {
        channel = null
        main.post { lastEmittedToken = null }
    }

    fun emitToken(token: String) = main.post {
        val ch = channel ?: return@post
        if (token == lastEmittedToken) return@post
        lastEmittedToken = token
        ch.invokeMethod("onToken", token)
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
