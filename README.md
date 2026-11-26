# push_manager

Minimal cross-platform push plugin. **Native APNs on iOS, native FCM on Android.**
No Flutter Firebase plugins: the iOS build stays completely Firebase-free (smaller
bundle, no Firebase in the iOS privacy surface). One Dart API for both platforms.

Comes with an optional **self-hosted push server** (Docker, APNs + FCM HTTP v1) and a
ready-made `HttpSendHandler`, or plug in any backend you like via `setSendHandler`.

> The MethodChannel wire name is still `ios_apn_manager` for historical reasons
> (the plugin started iOS-only). It's an internal identifier. The Dart API,
> package and classes are `push_manager` / `PushManager`.

---

## Features

| Feature | Description |
|---|---|
| `requestPermission()` | Asks for notification permission + registers for APNs (iOS) / FCM (Android) |
| `onToken` | Callback fired with the device token (APNs hex on iOS, FCM token on Android) |
| `onTokenError` | Callback fired when registration fails |
| `onMessage` / `messageStream` | Notification arrived while the app is in the foreground |
| `onNotificationTap` / `notificationTapStream` | The user tapped a notification |
| `sendPush()` | Sends a remote push via the configured send handler |
| `PushServerClient` / `HttpSendHandler` | Talk to the bundled push server (`server/`) |
| `setBadgeCount()` | Updates the app icon badge count |
| `cancelAllNotifications()` | Cancels all pending and delivered notifications |

> **Scheduled local notifications** are *not* handled here. Use e.g.
> `flutter_local_notifications`. This plugin owns remote push, badge and cancel only.

---

## Installation

```yaml
dependencies:
  push_manager: ^1.3.1
```

**iOS (Xcode):** `Signing & Capabilities` → `+ Capability` → **Push Notifications**.
The plugin registers itself. `AppDelegate.swift` stays untouched.

**Android:** put `google-services.json` (Firebase console → your Android app) into
`android/app/` and apply the Google services Gradle plugin:

```kotlin
// android/settings.gradle.kts → plugins { … }
id("com.google.gms.google-services") version "4.4.2" apply false // or the current version

// android/app/build.gradle.kts → plugins { … }
id("com.google.gms.google-services")
```

Firebase is used **only** for FCM message transport. No analytics, no Firebase
Flutter plugins. The plugin creates the notification channel `erohub_default`.

---

## Quick start with the push server

The repository contains a small push server you run yourself, locally or online
(Docker, `.env` configuration, optional HTTPS via Caddy). Your APNs key and FCM
service account stay on that server. **Setup guide: [server/README.md](server/README.md).**

```dart
import 'package:push_manager/push_manager.dart';

final push = PushServerClient(
  baseUrl: Uri.parse('https://push.example.com'),
  // The server's CLIENT_API_KEY, NEVER the ADMIN_API_KEY.
  apiKey: const String.fromEnvironment('PUSH_CLIENT_KEY'),
  // Only if the server verifies user JWTs (JWT_SECRET / JWT_JWKS_URL):
  userToken: () async => auth.currentSession?.accessToken,
);

// 1. Store the device token on the server
PushManager.onToken = (token) =>
    push.registerToken(userId: currentUser.id, token: token);

// 2. Route taps
PushManager.onNotificationTap = (payload) {
  final screen = payload['screen'] as String?;
  if (screen != null) router.go(screen);
};

// 3. Send through the server (requires ALLOW_CLIENT_SEND=true on the server)
PushManager.setSendHandler(HttpSendHandler.fromClient(push).call);

// 4. Ask for permission → APNs / FCM registration → onToken fires
await PushManager.requestPermission();
```

`registerToken` detects the platform and, on iOS, the APNs environment
(`production` in release builds, `sandbox` otherwise). Both can be overridden.
On logout call `push.unregisterToken(token)`.

If only your backend should send (recommended for production), skip step 3 and call
`POST /v1/send` from the backend with the admin key. See the
[server API reference](server/README.md#8-api-reference).

---

## Quick start with your own backend

The plugin does not need the bundled server. Register tokens and send pushes
however you like:

```dart
PushManager.onToken = (token) async {
  await myApi.saveToken(token, platform: Platform.isIOS ? 'ios' : 'android');
};

PushManager.setSendHandler((profileId, title, body, data) async {
  await myApi.enqueuePush(profileId: profileId, title: title, body: body, data: data);
});

await PushManager.requestPermission();
```

Your backend then talks to APNs / FCM itself. Put custom keys at the top level of the
APNs payload (next to `aps`) and into `data` for FCM so `payload['screen']` works the
same on both platforms.

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

`sendPush` calls the handler configured with `setSendHandler` and throws a
`StateError` if there is none. With `HttpSendHandler`, HTTP errors (bad key,
client sending disabled, rate limit) throw a `PushServerException`; a recipient
without registered devices is not an error. Use `PushServerClient.send(...)` directly
if you need the per-device result.

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

sendPush(...)        ──► your send handler ──► e.g. HttpSendHandler ──► push server ──► APNs / FCM
```

- **iOS** (`ios/push_manager/Sources/push_manager/IosApnManagerPlugin.swift`): native APNs, no Firebase.
- **Android** (`android/.../ErohubPushPlugin.kt` + `ErohubFcmService.kt`): FCM via
  `firebase-messaging` only, forwarded to the same MethodChannel.
- **Server** (`server/`, not part of the pub package): Node.js/TypeScript, Docker.

---

## Uninstall detection

APNs returns `410 Unregistered` / `400 BadDeviceToken`, FCM returns `UNREGISTERED`
when a token is no longer valid (app uninstalled, token rotated). The bundled server
removes such tokens automatically. With your own backend, check the provider response
and deactivate the token there.

---

## Platform support

| Platform | Support |
|---|---|
| iOS | ✅ 13.0+ (native APNs) |
| Android | ✅ 21+ (FCM) |
| Web | ❌ |
