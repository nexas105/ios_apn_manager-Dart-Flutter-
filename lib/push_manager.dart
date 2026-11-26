export 'push_manager_platform_interface.dart' show PushManagerPlatform;
export 'push_server_client.dart';

import 'dart:async';

import 'push_manager_platform_interface.dart';

/// Minimal cross-platform push manager — native APNs on iOS, native FCM on
/// Android. No Flutter Firebase plugins, so the iOS build stays Firebase-free.
///
/// ## Quick start
/// ```dart
/// // 1. Wire up callbacks
/// final push = PushServerClient(
///   baseUrl: Uri.parse('https://push.example.com'),
///   apiKey: const String.fromEnvironment('PUSH_CLIENT_KEY'),
/// );
/// PushManager.onToken           = (token) => push.registerToken(userId: me.id, token: token);
/// PushManager.onNotificationTap = (p)     => router.handle(p['screen']);
/// PushManager.setSendHandler(HttpSendHandler.fromClient(push).call);
///
/// // 2. Request permission (triggers APNs / FCM registration)
/// await PushManager.requestPermission();
///
/// // 3. Send a push (uses the handler you provided)
/// await PushManager.sendPush(
///   profileId: userId,
///   title: 'New message',
///   body: 'Your partner sent you something',
///   data: {'screen': 'chat'},
/// );
///
/// // 4. Utilities
/// await PushManager.setBadgeCount(3);
/// await PushManager.cancelAllNotifications();
/// ```
///
/// Note: on-device *scheduled* local notifications are not part of this
/// plugin (use e.g. `flutter_local_notifications`). It only owns remote push,
/// badge and cancel.
abstract final class PushManager {
  static PushManagerPlatform get _p => PushManagerPlatform.instance;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /// Provides the send implementation called by [sendPush].
  ///
  /// With the self-hosted push server (`server/` in this repository), use the
  /// ready-made [HttpSendHandler]:
  /// ```dart
  /// PushManager.setSendHandler(HttpSendHandler(
  ///   url: Uri.parse('https://push.example.com'),
  ///   apiKey: const String.fromEnvironment('PUSH_CLIENT_KEY'),
  /// ).call);
  /// ```
  ///
  /// Or plug in your own backend:
  /// ```dart
  /// PushManager.setSendHandler((profileId, title, body, data) async {
  ///   await myBackend.enqueuePush(
  ///     profileId: profileId, title: title, body: body, data: data);
  /// });
  /// ```
  static void setSendHandler(
    Future<void> Function(
      String profileId,
      String title,
      String body,
      Map<String, dynamic>? data,
    )
    handler,
  ) => _sendHandler = handler;

  static Future<void> Function(
    String profileId,
    String title,
    String body,
    Map<String, dynamic>? data,
  )?
  _sendHandler;

  // ---------------------------------------------------------------------------
  // Callbacks (native → Dart)
  // ---------------------------------------------------------------------------

  /// Called when a new APNs device token (hex string) is available.
  static set onToken(void Function(String token)? handler) =>
      _p.onToken = handler;

  /// Called when APNs token registration fails.
  static set onTokenError(void Function(String error)? handler) =>
      _p.onTokenError = handler;

  /// Called when a notification arrives while the app is in the foreground.
  static set onMessage(void Function(Map<String, dynamic> payload)? handler) =>
      _p.onMessage = handler;

  /// Called when the user taps a notification.
  static set onNotificationTap(
    void Function(Map<String, dynamic> payload)? handler,
  ) => _p.onNotificationTap = handler;

  /// Stream of payloads for notifications received in the foreground.
  /// Use this to reactively listen without a callback setter.
  ///
  /// ```dart
  /// PushManager.messageStream.listen((payload) {
  ///   ref.read(notificationProvider.notifier).handle(payload);
  /// });
  /// ```
  static Stream<Map<String, dynamic>> get messageStream => _p.messageStream;

  /// Stream of payloads for notifications the user tapped.
  static Stream<Map<String, dynamic>> get notificationTapStream =>
      _p.notificationTapStream;

  /// Injects [payload] into [notificationTapStream].
  /// Used internally by the in-app banner so tapping it triggers the same
  /// routing as tapping a system notification.
  static void simulateTap(Map<String, dynamic> payload) =>
      _p.simulateTap(payload);

  // ---------------------------------------------------------------------------
  // Remote push
  // ---------------------------------------------------------------------------

  /// Requests notification permission and registers for APNs.
  /// Returns `true` if the user granted permission.
  static Future<bool> requestPermission() => _p.requestPermission();

  /// Sends a push notification to [profileId] via the handler set in [setSendHandler].
  /// Throws [StateError] if no handler has been configured.
  static Future<void> sendPush({
    required String profileId,
    required String title,
    required String body,
    Map<String, dynamic>? data,
  }) {
    final handler = _sendHandler;
    if (handler == null) {
      throw StateError(
        'No send handler configured. '
        'Call PushManager.setSendHandler(...) before sendPush().',
      );
    }
    return handler(profileId, title, body, data);
  }

  // ---------------------------------------------------------------------------
  // Badge & cancel
  // ---------------------------------------------------------------------------

  /// Updates the app icon badge count. Pass `0` to clear.
  static Future<void> setBadgeCount(int count) => _p.setBadgeCount(count);

  /// Cancels all pending and delivered notifications.
  static Future<void> cancelAllNotifications() => _p.cancelAllNotifications();
}
