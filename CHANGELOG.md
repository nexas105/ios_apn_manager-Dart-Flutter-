## 1.3.1

* Android: `onNotificationTap` no longer fires on app launches that were not
  caused by a notification (deep links, app shortcuts, `flutter run` debug
  extras). A launch intent only counts as a tap if it carries FCM's keys.
* Android: `onToken` delivers the same token only once per engine instead of
  up to three times per launch.
* Server: keep the APNs HTTP/2 session referenced while requests are in flight;
  log a concrete hint for errors caused by server configuration.

## 1.3.0

* Add `PushServerClient` and `HttpSendHandler` to register device tokens and send
  pushes through the self-hosted push server. `setSendHandler` keeps working for
  custom backends. New dependency: `package:http`.
* Add a self-hosted push server in `server/` (Node.js/TypeScript, Docker): APNs over
  HTTP/2 and FCM HTTP v1, `.env` configuration, admin/client API keys, optional user
  JWT verification, SQLite token store, optional HTTPS via Caddy. Not part of the
  pub.dev package.
* README: installation from pub.dev, server setup, payload format.

## 1.2.0

* Add Swift Package Manager support for iOS (Package.swift). CocoaPods podspec
  kept in parallel; iOS sources moved to `ios/push_manager/Sources/push_manager/`.

## 0.0.1

* TODO: Describe initial release.
