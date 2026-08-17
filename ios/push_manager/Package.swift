// swift-tools-version: 5.9
import PackageDescription

// Swift Package Manager manifest for the push_manager Flutter plugin (iOS).
// The CocoaPods podspec (../push_manager.podspec) is kept in parallel so both
// dependency managers work. The Flutter framework is provided implicitly by
// the Flutter tool — it is not declared as a package dependency.
let package = Package(
    name: "push_manager",
    platforms: [
        .iOS("13.0")
    ],
    products: [
        .library(name: "push-manager", targets: ["push_manager"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "push_manager",
            dependencies: [],
            resources: [
                .process("PrivacyInfo.xcprivacy")
            ]
        )
    ]
)
