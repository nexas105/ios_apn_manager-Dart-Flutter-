#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
# Run `pod lib lint push_manager.podspec` to validate before publishing.
#
Pod::Spec.new do |s|
  s.name             = 'push_manager'
  s.version          = '0.0.1'
  s.summary          = 'Native APNs push manager for iOS (no Firebase).'
  s.description      = <<-DESC
iOS side of the push_manager plugin — native APNs, no Firebase or third-party SDK.
                       DESC
  s.homepage         = 'https://erohub.app'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'EroHub' => 'dev@erohub.app' }
  s.source           = { :path => '.' }
  # Shared with the Swift Package layout so SPM and CocoaPods build the same
  # sources (see push_manager/Package.swift).
  s.source_files = 'push_manager/Sources/push_manager/**/*.swift'
  s.resource_bundles = {
    'push_manager_privacy' => ['push_manager/Sources/push_manager/PrivacyInfo.xcprivacy']
  }
  s.dependency 'Flutter'
  s.platform = :ios, '13.0'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'
end
