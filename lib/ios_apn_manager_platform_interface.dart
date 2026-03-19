import 'package:plugin_platform_interface/plugin_platform_interface.dart';

import 'ios_apn_manager_method_channel.dart';

abstract class IosApnManagerPlatform extends PlatformInterface {
  /// Constructs a IosApnManagerPlatform.
  IosApnManagerPlatform() : super(token: _token);

  static final Object _token = Object();

  static IosApnManagerPlatform _instance = MethodChannelIosApnManager();

  /// The default instance of [IosApnManagerPlatform] to use.
  ///
  /// Defaults to [MethodChannelIosApnManager].
  static IosApnManagerPlatform get instance => _instance;

  /// Platform-specific implementations should set this with their own
  /// platform-specific class that extends [IosApnManagerPlatform] when
  /// they register themselves.
  static set instance(IosApnManagerPlatform instance) {
    PlatformInterface.verifyToken(instance, _token);
    _instance = instance;
  }

  Future<String?> getPlatformVersion() {
    throw UnimplementedError('platformVersion() has not been implemented.');
  }
}
