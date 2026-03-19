import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'ios_apn_manager_platform_interface.dart';

/// An implementation of [IosApnManagerPlatform] that uses method channels.
class MethodChannelIosApnManager extends IosApnManagerPlatform {
  /// The method channel used to interact with the native platform.
  @visibleForTesting
  final methodChannel = const MethodChannel('ios_apn_manager');

  @override
  Future<String?> getPlatformVersion() async {
    final version = await methodChannel.invokeMethod<String>('getPlatformVersion');
    return version;
  }
}
