import Flutter
import UIKit
import UserNotifications

/// Flutter plugin for full-cycle APNs push notification management on iOS.
/// No Firebase, no third-party SDK.
///
/// Flutter → Native:
///   requestPermission                   → Bool (granted)
///   setBadgeCount(count: Int)           → void
///   scheduleLocalNotification(args)     → void
///   cancelAllNotifications              → void
///
/// Native → Flutter:
///   onToken(String)                     — hex APNs device token
///   onTokenError(String)                — registration failure message
///   onMessage(Map)                      — notification received in foreground
///   onNotificationTap(Map)              — user tapped a notification
public class IosApnManagerPlugin: NSObject, FlutterPlugin, UNUserNotificationCenterDelegate {

  private var channel: FlutterMethodChannel?

  // ── Registration ──────────────────────────────────────────────────────────

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "ios_apn_manager",
      binaryMessenger: registrar.messenger()
    )
    let instance = IosApnManagerPlugin()
    instance.channel = channel

    registrar.addMethodCallDelegate(instance, channel: channel)
    registrar.addApplicationDelegate(instance)
    UNUserNotificationCenter.current().delegate = instance
  }

  // ── Flutter → Native ─────────────────────────────────────────────────────

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "requestPermission":
      requestPermission(result: result)
    case "setBadgeCount":
      let count = (call.arguments as? [String: Any])?["count"] as? Int ?? 0
      setBadgeCount(count, result: result)
    case "scheduleLocalNotification":
      scheduleLocal(call.arguments as? [String: Any], result: result)
    case "cancelAllNotifications":
      UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
      UNUserNotificationCenter.current().removeAllDeliveredNotifications()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // ── Permission + APNs registration ───────────────────────────────────────

  private func requestPermission(result: @escaping FlutterResult) {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .badge, .sound]
    ) { granted, _ in
      DispatchQueue.main.async {
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        result(granted)
      }
    }
  }

  // ── Badge ─────────────────────────────────────────────────────────────────

  private func setBadgeCount(_ count: Int, result: @escaping FlutterResult) {
    DispatchQueue.main.async {
      if #available(iOS 16.0, *) {
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in result(nil) }
      } else {
        UIApplication.shared.applicationIconBadgeNumber = count
        result(nil)
      }
    }
  }

  // ── Local notification ────────────────────────────────────────────────────

  private func scheduleLocal(_ args: [String: Any]?, result: @escaping FlutterResult) {
    guard let args = args,
          let title = args["title"] as? String,
          let body  = args["body"]  as? String else {
      result(FlutterError(code: "INVALID_ARGS", message: "title and body required", details: nil))
      return
    }

    let content       = UNMutableNotificationContent()
    content.title     = title
    content.body      = body
    content.sound     = .default
    if let data = args["data"] as? [String: Any] { content.userInfo = data }
    if let badge = args["badge"] as? Int         { content.badge    = NSNumber(value: badge) }

    let delay    = args["delaySeconds"] as? Double ?? 1
    let trigger  = UNTimeIntervalNotificationTrigger(timeInterval: max(delay, 0.1), repeats: false)
    let id       = args["id"] as? String ?? UUID().uuidString
    let request  = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

    UNUserNotificationCenter.current().add(request) { error in
      DispatchQueue.main.async {
        if let error = error {
          result(FlutterError(code: "SCHEDULE_ERROR", message: error.localizedDescription, details: nil))
        } else {
          result(id)
        }
      }
    }
  }

  // ── APNs token callbacks ──────────────────────────────────────────────────

  public func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) -> Bool {
    let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
    channel?.invokeMethod("onToken", arguments: token)
    return true
  }

  public func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) -> Bool {
    channel?.invokeMethod("onTokenError", arguments: error.localizedDescription)
    return true
  }

  // ── UNUserNotificationCenterDelegate ─────────────────────────────────────

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    channel?.invokeMethod("onMessage", arguments: toStringMap(notification.request.content.userInfo))
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .sound, .badge])
    } else {
      completionHandler([.alert, .sound, .badge])
    }
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    channel?.invokeMethod("onNotificationTap", arguments: toStringMap(response.notification.request.content.userInfo))
    completionHandler()
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private func toStringMap(_ dict: [AnyHashable: Any]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (k, v) in dict { if let s = k as? String { out[s] = v } }
    return out
  }
}
