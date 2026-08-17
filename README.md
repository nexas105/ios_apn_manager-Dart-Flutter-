# push_manager

Minimal cross-platform push plugin. **Native APNs on iOS, native FCM on Android.**
No Flutter Firebase plugins — the iOS build stays completely Firebase-free (smaller
bundle + no Firebase in the iOS privacy surface). One Dart API for both platforms.

> The MethodChannel wire name is still `ios_apn_manager` for historical reasons
> (the plugin started iOS-only). It's an internal identifier — the Dart API,
> package and classes are `push_manager` / `PushManager`.

---

## Features

| Feature | Description |
|---|---|
| `requestPermission()` | Asks for notification permission + registers for APNs (iOS) / FCM (Android) |
| `onToken` | Callback fired with the device token (APNs hex on iOS, FCM token on Android) |
| `onTokenError` | Callback fired when registration fails |
| `onMessage` | Callback fired when a notification arrives in the foreground |
| `onNotificationTap` | Callback fired when the user taps a notification |
| `sendPush()` | Sends a remote push via your custom backend handler |
| `setBadgeCount()` | Updates the app icon badge count |
| `cancelAllNotifications()` | Cancels all pending and delivered notifications |

> **Scheduled local notifications** are *not* handled here — use
> `flutter_local_notifications` (see `SyncSessionReminderService`). This plugin
> owns remote push + badge + cancel only.

---

## Installation

```yaml
dependencies:
  push_manager:
    path: packages/push_manager
```

**iOS (Xcode):** `Signing & Capabilities` → `+ Capability` → **Push Notifications**.
The plugin registers itself — `AppDelegate.swift` stays untouched.

**Android:** requires `google-services.json` in `android/app/` and the
`com.google.gms.google-services` Gradle plugin (already wired in this repo).
Firebase is used **only** for FCM message transport — no analytics, no
Firebase Flutter plugins.

---

## Quick start

```dart
import 'package:push_manager/push_manager.dart';

// 1. Wire callbacks
PushManager.onToken = (token) async {
  await repo.upsertToken(token, platform); // 'FCM' | 'APNS_SANDBOX' | 'APNS_PRODUCTION'
};

PushManager.onNotificationTap = (payload) {
  final screen = payload['screen'] as String?;
  if (screen != null) router.go(screen);
};

// 2. Provide a send backend (e.g. Supabase push_queue)
PushManager.setSendHandler((profileId, title, body, data) async {
  await supabase.from('push_queue').insert({
    'profile': profileId,
    'title': title,
    'body': body,
    if (data != null) 'data': data,
  });
});

// 3. Request permission (triggers APNs / FCM registration → onToken fires)
await PushManager.requestPermission();
```

---

## Sending a push

```dart
await PushManager.sendPush(
  profileId: 'uuid-of-recipient',
  title: 'New message',
  body: 'Your partner sent you something ❤️',
  data: {'screen': '/chat'},
);
```

`sendPush` calls the handler you configured in `setSendHandler`.
The plugin itself has no knowledge of Supabase, HTTP, or any backend.

---

## Badge & cancel

```dart
await PushManager.setBadgeCount(3);

await PushManager.cancelAllNotifications();
await PushManager.setBadgeCount(0);
```

---

## Architecture

```
Flutter (Dart)          MethodChannel "ios_apn_manager"        Native
──────────────────────────────────────────────────────────────────────────────
requestPermission()  ──────────────────────────────────►  iOS:     UNUserNotificationCenter + registerForRemoteNotifications
                                                           Android: NotificationManager + FirebaseMessaging.getToken()

                     ◄──────────────────────────── onToken(token)
                     ◄───────────────────── onMessage(payload)
                     ◄──────────────── onNotificationTap(payload)

setBadgeCount(n)     ──────────────────────────────────►  iOS: setBadgeCount   (Android: no-op)
cancelAll()          ──────────────────────────────────►  remove all pending + delivered
```

- **iOS** (`ios/Classes/IosApnManagerPlugin.swift`) — native APNs, no Firebase.
- **Android** (`android/.../ErohubPushPlugin.kt` + `ErohubFcmService.kt`) — FCM via
  `firebase-messaging` only, forwarded to the same MethodChannel.

---

## Uninstall detection

APNs returns `410 Unregistered` / `400 BadDeviceToken`, FCM returns
`UNREGISTERED`, when a token is no longer valid (app uninstalled, token rotated).
Handle this **server-side** — check the send response in your Edge Function and
mark the token inactive in the database.

---

## Platform support

| Platform | Support |
|---|---|
| iOS | ✅ 13.0+ (native APNs) |
| Android | ✅ 21+ (FCM) |
| Web | ❌ |
