# ios_apn_manager

Minimal iOS-only Flutter plugin for full-cycle APNs push notification management.
**No Firebase. No third-party SDK. Pure APNs via a native MethodChannel.**

---

## Features

| Feature | Description |
|---|---|
| `requestPermission()` | Asks the user for notification permission + registers for APNs |
| `onToken` | Callback fired with the hex APNs device token |
| `onTokenError` | Callback fired when registration fails |
| `onMessage` | Callback fired when a notification arrives in the foreground |
| `onNotificationTap` | Callback fired when the user taps a notification |
| `sendPush()` | Sends a remote push via your custom backend handler |
| `setBadgeCount()` | Updates the app icon badge count |
| `scheduleLocalNotification()` | Schedules an on-device local notification |
| `cancelAllNotifications()` | Cancels all pending and delivered notifications |

---

## Installation

```yaml
dependencies:
  ios_apn_manager:
    path: ../ios_apn_manager   # or git / pub.dev path
```

**Xcode:** `Signing & Capabilities` → `+ Capability` → **Push Notifications**
That's it. `AppDelegate.swift` stays untouched — the plugin registers itself.

---

## Quick start

```dart
import 'package:ios_apn_manager/ios_apn_manager.dart';

// 1. Wire callbacks
IosApnManager.onToken = (token) async {
  await repo.upsertToken(token, 'APNS_SANDBOX');
};

IosApnManager.onNotificationTap = (payload) {
  final screen = payload['screen'] as String?;
  if (screen != null) router.go(screen);
};

// 2. Provide a send backend (e.g. Supabase push_queue)
IosApnManager.setSendHandler((profileId, title, body, data) async {
  await supabase.from('push_queue').insert({
    'profile': profileId,
    'title': title,
    'body': body,
    if (data != null) 'data': data,
  });
});

// 3. Request permission (triggers APNs registration → onToken fires)
await IosApnManager.requestPermission();
```

---

## Sending a push

```dart
await IosApnManager.sendPush(
  profileId: 'uuid-of-recipient',
  title: 'New message',
  body: 'Your partner sent you something ❤️',
  data: {'screen': '/chat'},
);
```

`sendPush` calls the handler you configured in `setSendHandler`.
The plugin itself has no knowledge of Supabase, HTTP, or any backend.

---

## Local notifications

```dart
// Schedule a local notification in 10 seconds
final id = await IosApnManager.scheduleLocalNotification(
  title: 'Reminder',
  body: 'Time to check in with your partner',
  delaySeconds: 10,
  data: {'screen': '/mood'},
);

// Update badge
await IosApnManager.setBadgeCount(3);

// Clear all
await IosApnManager.cancelAllNotifications();
await IosApnManager.setBadgeCount(0);
```

---

## Architecture

```
Flutter (Dart)          MethodChannel "ios_apn_manager"        Swift (iOS)
─────────────────────────────────────────────────────────────────────────
requestPermission()  ──────────────────────────────────►  UNUserNotificationCenter
                                                           UIApplication.registerForRemoteNotifications()

                     ◄──────────────────────────── onToken(hexString)
                     ◄───────────────────── onMessage(payload)
                     ◄──────────────── onNotificationTap(payload)

setBadgeCount(n)     ──────────────────────────────────►  UNUserNotificationCenter.setBadgeCount
scheduleLocal(...)   ──────────────────────────────────►  UNNotificationRequest
cancelAll()          ──────────────────────────────────►  removeAllPending + removeAllDelivered
```

---

## Uninstall detection

APNs returns `410 Unregistered` or `400 BadDeviceToken` when a token is no longer valid (app uninstalled, token rotated). Handle this **server-side** by checking the APNs response in your Edge Function / backend and marking the token as inactive in your database.

---

## Platform support

| Platform | Support |
|---|---|
| iOS | ✅ 13.0+ |
| Android | ❌ iOS-only by design |
| Web | ❌ |
