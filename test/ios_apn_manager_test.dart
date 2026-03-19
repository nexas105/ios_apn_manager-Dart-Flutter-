import 'package:flutter_test/flutter_test.dart';
import 'package:ios_apn_manager/ios_apn_manager.dart';
import 'package:ios_apn_manager/ios_apn_manager_platform_interface.dart';
import 'package:ios_apn_manager/ios_apn_manager_method_channel.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

class MockIosApnManagerPlatform
    with MockPlatformInterfaceMixin
    implements IosApnManagerPlatform {

  @override
  Future<String?> getPlatformVersion() => Future.value('42');
}

void main() {
  final IosApnManagerPlatform initialPlatform = IosApnManagerPlatform.instance;

  test('$MethodChannelIosApnManager is the default instance', () {
    expect(initialPlatform, isInstanceOf<MethodChannelIosApnManager>());
  });

  test('getPlatformVersion', () async {
    IosApnManager iosApnManagerPlugin = IosApnManager();
    MockIosApnManagerPlatform fakePlatform = MockIosApnManagerPlatform();
    IosApnManagerPlatform.instance = fakePlatform;

    expect(await iosApnManagerPlugin.getPlatformVersion(), '42');
  });
}
