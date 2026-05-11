import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ios_apn_manager/ios_apn_manager_method_channel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  MethodChannelIosApnManager platform = MethodChannelIosApnManager();
  const MethodChannel channel = MethodChannel('ios_apn_manager');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      channel,
      (MethodCall methodCall) async {
        switch (methodCall.method) {
          case 'requestPermission':
            return true;
          case 'setBadgeCount':
            return null;
          case 'scheduleLocalNotification':
            return 'test-id';
          case 'cancelAllNotifications':
            return null;
          default:
            return null;
        }
      },
    );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('requestPermission', () async {
    expect(await platform.requestPermission(), true);
  });

  test('setBadgeCount', () async {
    await platform.setBadgeCount(3);
  });

  test('scheduleLocalNotification', () async {
    final id = await platform.scheduleLocalNotification(
      title: 'Test',
      body: 'Body',
    );
    expect(id, 'test-id');
  });

  test('cancelAllNotifications', () async {
    await platform.cancelAllNotifications();
  });
}
