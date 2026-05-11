// This is a basic Flutter integration test.
//
// Since integration tests run in a full Flutter application, they can interact
// with the host side of a plugin implementation, unlike Dart unit tests.
//
// For more information about Flutter integration tests, please see
// https://flutter.dev/to/integration-testing

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:ios_apn_manager/ios_apn_manager.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('requestPermission test', (WidgetTester tester) async {
    // IosApnManager is an abstract final class with static methods.
    // On a real device this would request permission; here we just verify
    // the call completes without throwing.
    final bool granted = await IosApnManager.requestPermission();
    expect(granted, isA<bool>());
  });
}
