import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:ios_apn_manager/ios_apn_manager.dart';
import 'package:ios_apn_manager/ios_apn_manager_method_channel.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

class MockIosApnManagerPlatform
    with MockPlatformInterfaceMixin
    implements IosApnManagerPlatform {
  @override
  Future<bool> requestPermission() => Future.value(true);

  @override
  Future<void> setBadgeCount(int count) => Future.value();

  @override
  Future<String> scheduleLocalNotification({
    required String title,
    required String body,
    double delaySeconds = 1,
    int? badge,
    Map<String, dynamic>? data,
    String? id,
  }) => Future.value('mock-notification-id');

  @override
  Future<void> cancelAllNotifications() => Future.value();

  @override
  set onToken(void Function(String token)? handler) {}

  @override
  set onTokenError(void Function(String error)? handler) {}

  @override
  set onMessage(void Function(Map<String, dynamic> payload)? handler) {}

  @override
  set onNotificationTap(
          void Function(Map<String, dynamic> payload)? handler) {}

  final _messageController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _tapController = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> get messageStream => _messageController.stream;

  @override
  Stream<Map<String, dynamic>> get notificationTapStream =>
      _tapController.stream;

  @override
  void simulateTap(Map<String, dynamic> payload) =>
      _tapController.add(payload);
}

void main() {
  final IosApnManagerPlatform initialPlatform =
      IosApnManagerPlatform.instance;

  test('MethodChannelIosApnManager is the default instance', () {
    expect(initialPlatform, isInstanceOf<MethodChannelIosApnManager>());
  });

  test('requestPermission returns true from mock', () async {
    MockIosApnManagerPlatform fakePlatform = MockIosApnManagerPlatform();
    IosApnManagerPlatform.instance = fakePlatform;

    expect(await IosApnManager.requestPermission(), true);
  });

  test('setBadgeCount completes from mock', () async {
    MockIosApnManagerPlatform fakePlatform = MockIosApnManagerPlatform();
    IosApnManagerPlatform.instance = fakePlatform;

    await IosApnManager.setBadgeCount(5);
  });

  test('scheduleLocalNotification returns id from mock', () async {
    MockIosApnManagerPlatform fakePlatform = MockIosApnManagerPlatform();
    IosApnManagerPlatform.instance = fakePlatform;

    final id = await IosApnManager.scheduleLocalNotification(
      title: 'Test',
      body: 'Test body',
    );
    expect(id, 'mock-notification-id');
  });
}
