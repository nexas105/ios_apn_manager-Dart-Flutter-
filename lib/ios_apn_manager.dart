library ios_apn_manager;

export 'ios_apn_manager_platform_interface.dart' show IosApnManagerPlatform;

import 'dart:async';

import 'ios_apn_manager_platform_interface.dart';

/// Minimal iOS APNs manager — no Firebase, no third-party SDK.
///
/// ## Quick start
/// ```dart
/// // 1. Wire up callbacks
/// IosApnManager.onToken        = (token) => repo.upsertToken(token);
/// IosApnManager.onNotificationTap = (p)  => router.handle(p['screen']);
/// IosApnManager.setSendHandler((profileId, title, body, data) async {
///   await repo.enqueue(profileId: profileId, title: title, body: body, data: data);
/// });
///
/// // 2. Request permission (triggers APNs registration)
/// await IosApnManager.requestPermission();
///
/// // 3. Send a push (uses the handler you provided)
/// await IosApnManager.sendPush(
///   profileId: userId,
///   title: 'New message',
///   body: 'Your partner sent you something',
///   data: {'screen': 'chat'},
/// );
///
/// // 4. Utilities
/// await IosApnManager.setBadgeCount(3);
/// await IosApnManager.scheduleLocalNotification(
///   title: 'Reminder',
///   body: 'Time to check in',
///   delaySeconds: 5,
/// );
/// await IosApnManager.cancelAllNotifications();
/// ```
abstract final class IosApnManager {
  static IosApnManagerPlatform get _p => IosApnManagerPlatform.instance;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /// Provides the custom send implementation.
  /// Called by [sendPush] — the plugin does not know about Supabase / HTTP.
  ///
  /// Example (eorhub):
  /// ```dart
  /// IosApnManager.setSendHandler((profileId, title, body, data) async {
  ///   await const PushRepo().enqueue(
  ///     profileId: profileId, title: title, body: body, data: data);
  /// });
  /// ```
  static void setSendHandler(
    Future<void> Function(
      String profileId,
      String title,
      String body,
      Map<String, dynamic>? data,
    ) handler,
  ) => _sendHandler = handler;

  static Future<void> Function(
    String profileId,
    String title,
    String body,
    Map<String, dynamic>? data,
  )? _sendHandler;

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
  /// IosApnManager.messageStream.listen((payload) {
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
        'Call IosApnManager.setSendHandler(...) before sendPush().',
      );
    }
    return handler(profileId, title, body, data);
  }

  // ---------------------------------------------------------------------------
  // Local notifications & badge
  // ---------------------------------------------------------------------------

  /// Updates the app icon badge count. Pass `0` to clear.
  static Future<void> setBadgeCount(int count) => _p.setBadgeCount(count);

  /// Schedules a local (on-device) notification.
  /// Returns the notification identifier.
  static Future<String> scheduleLocalNotification({
    required String title,
    required String body,
    double delaySeconds = 1,
    int? badge,
    Map<String, dynamic>? data,
    String? id,
  }) => _p.scheduleLocalNotification(
        title: title,
        body: body,
        delaySeconds: delaySeconds,
        badge: badge,
        data: data,
        id: id,
      );

  /// Cancels all pending and delivered notifications.
  static Future<void> cancelAllNotifications() => _p.cancelAllNotifications();
}
