import 'dart:async';

import 'package:plugin_platform_interface/plugin_platform_interface.dart';

import 'push_manager_method_channel.dart';

abstract class PushManagerPlatform extends PlatformInterface {
  PushManagerPlatform() : super(token: _token);

  static final Object _token = Object();
  static PushManagerPlatform _instance = MethodChannelPushManager();

  static PushManagerPlatform get instance => _instance;
  static set instance(PushManagerPlatform instance) {
    PlatformInterface.verifyToken(instance, _token);
    _instance = instance;
  }

  Future<bool> requestPermission() =>
      throw UnimplementedError('requestPermission() not implemented.');

  Future<void> setBadgeCount(int count) =>
      throw UnimplementedError('setBadgeCount() not implemented.');

  Future<void> cancelAllNotifications() =>
      throw UnimplementedError('cancelAllNotifications() not implemented.');

  set onToken(void Function(String token)? handler) =>
      throw UnimplementedError('onToken not implemented.');
  set onTokenError(void Function(String error)? handler) =>
      throw UnimplementedError('onTokenError not implemented.');
  set onMessage(void Function(Map<String, dynamic> payload)? handler) =>
      throw UnimplementedError('onMessage not implemented.');
  set onNotificationTap(void Function(Map<String, dynamic> payload)? handler) =>
      throw UnimplementedError('onNotificationTap not implemented.');

  /// Stream of payloads for notifications received in the foreground.
  Stream<Map<String, dynamic>> get messageStream =>
      throw UnimplementedError('messageStream not implemented.');

  /// Stream of payloads for notifications the user tapped.
  Stream<Map<String, dynamic>> get notificationTapStream =>
      throw UnimplementedError('notificationTapStream not implemented.');

  /// Manually injects a payload into [notificationTapStream].
  /// Used by the in-app banner to re-emit a foreground notification as a tap.
  void simulateTap(Map<String, dynamic> payload) =>
      throw UnimplementedError('simulateTap() not implemented.');
}
