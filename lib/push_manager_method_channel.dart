import 'dart:async';

import 'package:flutter/services.dart';

import 'push_manager_platform_interface.dart';

class MethodChannelPushManager extends PushManagerPlatform {
  // Stable wire identifier — must match the native side (Swift + Kotlin).
  // Kept as 'ios_apn_manager' for historical reasons; renaming it would
  // require a coordinated native change and break push until rebuilt.
  final _channel = const MethodChannel('ios_apn_manager');

  void Function(String)? _onToken;
  void Function(String)? _onTokenError;
  void Function(Map<String, dynamic>)? _onMessage;
  void Function(Map<String, dynamic>)? _onNotificationTap;

  final _messageController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _tapController =
      StreamController<Map<String, dynamic>>.broadcast();

  MethodChannelPushManager() {
    _channel.setMethodCallHandler(_handle);
  }

  // ── Setters ───────────────────────────────────────────────────────────────

  @override
  set onToken(void Function(String)? h) => _onToken = h;
  @override
  set onTokenError(void Function(String)? h) => _onTokenError = h;
  @override
  set onMessage(void Function(Map<String, dynamic>)? h) => _onMessage = h;
  @override
  set onNotificationTap(void Function(Map<String, dynamic>)? h) =>
      _onNotificationTap = h;

  // ── Streams ───────────────────────────────────────────────────────────────

  @override
  Stream<Map<String, dynamic>> get messageStream => _messageController.stream;

  @override
  Stream<Map<String, dynamic>> get notificationTapStream => _tapController.stream;

  // ── Methods ───────────────────────────────────────────────────────────────

  @override
  Future<bool> requestPermission() async {
    final granted = await _channel.invokeMethod<bool>('requestPermission');
    return granted ?? false;
  }

  @override
  Future<void> setBadgeCount(int count) =>
      _channel.invokeMethod('setBadgeCount', {'count': count});

  @override
  Future<void> cancelAllNotifications() =>
      _channel.invokeMethod('cancelAllNotifications');

  @override
  void simulateTap(Map<String, dynamic> payload) => _tapController.add(payload);

  // ── Native → Dart dispatch ────────────────────────────────────────────────

  Future<void> _handle(MethodCall call) async {
    switch (call.method) {
      case 'onToken':
        _onToken?.call(call.arguments as String);
      case 'onTokenError':
        _onTokenError?.call(call.arguments as String);
      case 'onMessage':
        final payload = _toStringMap(call.arguments);
        _onMessage?.call(payload);
        _messageController.add(payload);
      case 'onNotificationTap':
        final payload = _toStringMap(call.arguments);
        _onNotificationTap?.call(payload);
        _tapController.add(payload);
    }
  }

  Map<String, dynamic> _toStringMap(dynamic raw) {
    if (raw is Map) return raw.map((k, v) => MapEntry(k.toString(), v));
    return {};
  }
}
