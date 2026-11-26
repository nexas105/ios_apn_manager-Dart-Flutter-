# push_manager server

A small, self-hosted push server for the [`push_manager`](../README.md) Flutter plugin.
It sends notifications to **APNs** (iOS) and **FCM HTTP v1** (Android), keeps an optional
`userId → device tokens` store in SQLite, and is configured entirely through a `.env` file.

- Run it **locally** for testing (including the iOS Simulator) or **online** with your own
  domain and HTTPS.
- Starts with **Docker / docker compose**, no local Node.js needed.
- Your APNs key and FCM service account **stay on the server**. The app never sees them.
- Not part of the pub.dev package (excluded via `.pubignore`).

```
 Flutter app (push_manager)                push server                     Apple / Google
 ─────────────────────────────            ───────────────                  ───────────────
 PushManager.onToken ──► PushServerClient.registerToken ─► POST /v1/tokens ─► SQLite
 PushManager.sendPush ─► HttpSendHandler ──────────────► POST /v1/send ───► APNs (HTTP/2)
 your backend ─────────── ADMIN_API_KEY ───────────────► POST /v1/send ───► FCM HTTP v1
```

## Contents

1. [Quick start (local)](#1-quick-start-local)
2. [Get the APNs key (iOS)](#2-get-the-apns-key-ios)
3. [Get the FCM service account (Android)](#3-get-the-fcm-service-account-android)
4. [Connect the app](#4-connect-the-app)
5. [Testing locally: Simulator, emulator, devices](#5-testing-locally-simulator-emulator-devices)
6. [Going online with a domain and HTTPS](#6-going-online-with-a-domain-and-https)
7. [Security model](#7-security-model)
8. [API reference](#8-api-reference)
9. [Token lifecycle](#9-token-lifecycle)
10. [Operations: logs, backup, updates](#10-operations-logs-backup-updates)
11. [Development without Docker](#11-development-without-docker)

---

## 1. Quick start (local)

Requirements: [Docker](https://docs.docker.com/get-docker/) with Compose v2.24 or newer.

```bash
git clone https://github.com/nexas105/ios_apn_manager-Dart-Flutter-.git
cd ios_apn_manager-Dart-Flutter-/server

cp .env.example .env
openssl rand -base64 32   # → paste as ADMIN_API_KEY in .env
openssl rand -base64 32   # → paste as CLIENT_API_KEY in .env
```

Put your credentials (steps 2 and 3) into `server/secrets/` and reference them in `.env`:

```dotenv
APNS_KEY_PATH=/secrets/AuthKey_ABC123DEFG.p8
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=TEAM123456
APNS_BUNDLE_ID=com.example.myapp
APNS_ENVIRONMENT=sandbox

FCM_SERVICE_ACCOUNT_PATH=/secrets/service-account.json
```

Start it:

```bash
docker compose up -d --build
docker compose logs -f          # "push server listening" shows what is enabled
curl http://localhost:8080/health
# {"status":"ok"}
```

You can configure only iOS or only Android: leave the other block empty.
Every variable is explained in [`.env.example`](.env.example).

> `/secrets` is the container path of `server/secrets/`. Everything in that folder
> except `.gitkeep` is git-ignored.

## 2. Get the APNs key (iOS)

You need a paid Apple Developer account. One key works for all your apps.

1. Open [developer.apple.com/account](https://developer.apple.com/account) →
   **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Enter a name (e.g. `Push server`) and tick **Apple Push Notifications service (APNs)**.
   If the portal asks you to configure the key, choose the environment
   **Sandbox & Production** (one key for debug and release builds).
3. **Continue** → **Register** → **Download**. You get `AuthKey_<KEYID>.p8`.
   **You can only download it once.** Store it safely.
4. Note the values:
   - `APNS_KEY_ID`: the 10-character Key ID (shown on the key page, also in the file name).
   - `APNS_TEAM_ID`: your Team ID (top right in the portal, or **Membership details**).
   - `APNS_BUNDLE_ID`: your app's bundle identifier, e.g. `com.example.myapp`.
5. In Xcode, the app target needs **Signing & Capabilities → + Capability → Push
   Notifications** (this also enables push on the App ID).
6. Copy the `.p8` into `server/secrets/` and set `APNS_KEY_PATH=/secrets/AuthKey_<KEYID>.p8`.

Instead of a file you can put the key into `.env` directly, either with `\n` for the line
breaks or base64-encoded (`base64 -i AuthKey_X.p8`):

```dotenv
APNS_KEY=-----BEGIN PRIVATE KEY-----\nMIGTAgEA...\n-----END PRIVATE KEY-----
```

**Sandbox or production?** Xcode debug builds and the Simulator get *sandbox* tokens,
TestFlight and App Store builds get *production* tokens. The plugin reports the right
environment per token, `APNS_ENVIRONMENT` is only the default. If Apple answers
`BadDeviceToken`, the server tries the other environment once and remembers it.

## 3. Get the FCM service account (Android)

1. Open the [Firebase console](https://console.firebase.google.com/) and create or select
   a project.
2. **Add app → Android** with your application id, download `google-services.json` and put
   it into `android/app/` of your **Flutter app** (see the plugin README for the Gradle setup).
3. **Project settings** (gear icon) → **Service accounts** → **Generate new private key** →
   **Generate key**. You get a JSON file. Treat it like a password.
4. Check **Project settings → Cloud Messaging**: *Firebase Cloud Messaging API (V1)* must be
   **Enabled** (it is by default for new projects).
5. Copy the JSON into `server/secrets/service-account.json` and set
   `FCM_SERVICE_ACCOUNT_PATH=/secrets/service-account.json`.

`FCM_PROJECT_ID` is read from the file. `FCM_ANDROID_CHANNEL_ID` defaults to
`erohub_default`, the channel the plugin creates. Change it only if your app shows
notifications on its own channel.

## 4. Connect the app

```dart
import 'package:push_manager/push_manager.dart';

final push = PushServerClient(
  baseUrl: Uri.parse('https://push.example.com'),       // or http://<LAN-IP>:8080
  apiKey: const String.fromEnvironment('PUSH_CLIENT_KEY'), // CLIENT_API_KEY, never the admin key
  userToken: () async => auth.currentSession?.accessToken, // only if JWT_* is configured
);

PushManager.onToken = (token) => push.registerToken(userId: currentUser.id, token: token);
PushManager.setSendHandler(HttpSendHandler.fromClient(push).call); // needs ALLOW_CLIENT_SEND=true

await PushManager.requestPermission();

// on logout:
await push.unregisterToken(lastToken);
```

Build with `flutter run --dart-define=PUSH_CLIENT_KEY=...` so the key is not in your
source code. It still ends up in the app binary, which is why the client key has limited
rights (see [Security model](#7-security-model)).

Sending from **your backend** instead (recommended for production):

```bash
curl -X POST https://push.example.com/v1/send \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"42","title":"New message","body":"Hi!","data":{"screen":"/chat"}}'
```

## 5. Testing locally: Simulator, emulator, devices

| Where the app runs | Server URL in the app | Notes |
|---|---|---|
| iOS Simulator | `http://localhost:8080` | Receives real sandbox pushes on macOS 13+ with Xcode 14+ on Apple silicon or T2 Macs. |
| Android emulator | `http://10.0.2.2:8080` | Use an emulator image **with Google Play** so FCM works. |
| Physical device on your Wi-Fi | `http://<your-computer-LAN-IP>:8080` | Keep `BIND_ADDRESS=0.0.0.0`, allow the port in your firewall. |

**Plain HTTP in debug builds**

- **Android** blocks cleartext HTTP since Android 9. Allow it only in debug builds by creating
  `android/app/src/debug/AndroidManifest.xml`:
  ```xml
  <manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <application android:usesCleartextTraffic="true" />
  </manifest>
  ```
- **iOS** App Transport Security may block `http://` to LAN addresses. For debug builds add
  `NSAppTransportSecurity` → `NSAllowsLocalNetworking = YES` to `Info.plist`.
- Online, always use HTTPS and none of the above.

**Test a push without the app's send path**

```bash
# Register a token by hand (copy it from PushManager.onToken / the Xcode console)
curl -X POST http://localhost:8080/v1/tokens \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"me","token":"<hex token>","platform":"ios","environment":"sandbox"}'

curl -X POST http://localhost:8080/v1/send \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"me","title":"Hello","body":"From my push server"}'
```

The response lists every device with `ok` or the provider's error code, e.g.
`DeviceTokenNotForTopic` (wrong `APNS_BUNDLE_ID`) or `SENDER_ID_MISMATCH` (service account
from a different Firebase project than `google-services.json`).

> Only want to check the UI on the Simulator without any server?
> `xcrun simctl push booted com.example.myapp payload.apns` delivers a local payload file.

## 6. Going online with a domain and HTTPS

You need a server (any VPS with Docker), a domain and a DNS `A`/`AAAA` record
(e.g. `push.example.com`) pointing at it. Copy the `server/` folder (or clone the repo)
to the machine, create `.env` and `secrets/` as in step 1, then choose **one** option.

### Option A: behind your own reverse proxy (default)

The container speaks plain HTTP. Publish it only on localhost and let your existing proxy
terminate TLS:

```dotenv
PORT=8080
BIND_ADDRESS=127.0.0.1
TRUST_PROXY=true
```

```bash
docker compose up -d --build
```

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name push.example.com;
    # ssl_certificate / ssl_certificate_key from certbot etc.

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy (system-wide install):

```caddyfile
push.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Traefik and others work the same way: forward to `127.0.0.1:${PORT}`.

### Option B: bundled Caddy with automatic HTTPS

`docker-compose.https.yml` adds a Caddy container that obtains and renews a Let's Encrypt
certificate. Ports **80 and 443** must be free and reachable from the internet.

```dotenv
DOMAIN=push.example.com
ACME_EMAIL=you@example.com
```

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
curl https://push.example.com/health
```

In this mode the push server is not published on any host port, only Caddy is. To avoid
typing both files every time, set `COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml`
in `.env`.

### Production checklist

- [ ] Strong, different `ADMIN_API_KEY` and `CLIENT_API_KEY` (`openssl rand -base64 32`).
- [ ] HTTPS only, the app uses `https://…`.
- [ ] `JWT_SECRET` or `JWT_JWKS_URL` set if the app registers tokens itself.
- [ ] `ALLOW_CLIENT_SEND=false` unless you accept the risk (send from your backend instead).
- [ ] `APNS_ENVIRONMENT=production` if most of your users run App Store/TestFlight builds.
- [ ] Back up the `push-data` volume (see below).

## 7. Security model

| Key / setting | Where it lives | What it can do |
|---|---|---|
| APNs `.p8`, FCM service account | server only | Send pushes to your apps. Never in the app or in git. |
| `ADMIN_API_KEY` | your backend, scripts | Everything: register/delete tokens for anyone, send to anyone, list tokens. |
| `CLIENT_API_KEY` | the app | Register and delete device tokens. Send **only** if `ALLOW_CLIENT_SEND=true`, only by `userId` (never to raw tokens), rate limited (`CLIENT_SEND_RATE_LIMIT` per minute). |
| `JWT_SECRET` / `JWT_JWKS_URL` | server | Makes the client key require the signed-in user's JWT (`X-User-Token`). The user id then comes from the JWT (`JWT_USER_CLAIM`, default `sub`): a client can only register/delete its own tokens and is rate limited per user. |

Anything shipped in an app can be extracted. Without JWT verification, someone with the
client key could register their own device under another user's id and receive that user's
pushes. **Use JWT verification whenever the app registers tokens itself.** Supabase,
Firebase Auth, Auth0 and others publish a JWKS URL (examples in `.env.example`).

`ALLOW_CLIENT_SEND=true` lets anyone with the client key push to any user id (within the
rate limit). That's fine for prototypes and for apps where users message each other and you
accept the risk; otherwise send from your backend with the admin key.

Other measures: API keys are compared in constant time; request bodies are limited to
`MAX_BODY_BYTES`; logs contain no titles, bodies, full tokens or clear-text user ids
(user ids are hashed, tokens cut to 8 characters).

## 8. API reference

All endpoints except `/health` require `Authorization: Bearer <ADMIN_API_KEY | CLIENT_API_KEY>`.
With JWT verification, client requests also need `X-User-Token: <user JWT>`.
Errors look like `{"error": "<code>", "message": "…"}`.

### `GET /health`
`200 {"status":"ok"}`. No auth; used by the Docker health check.

### `POST /v1/tokens` (admin, client)
Registers a device token or moves it to another user (one device token belongs to one user).

```json
{ "userId": "42", "token": "<APNs hex or FCM token>", "platform": "ios", "environment": "sandbox" }
```

`platform`: `ios` | `android`. `environment` (iOS only, optional): `sandbox` | `production`.
With JWT verification `userId` may be omitted. If present, it must match the JWT.

### `DELETE /v1/tokens/{token}` (admin, client)
Removes a token. With JWT verification, clients can only remove their own tokens.
`200 {"ok":true,"removed":true|false}`

### `POST /v1/send` (admin; client only with `ALLOW_CLIENT_SEND=true`)

```json
{
  "userId": "42",
  "title": "New message",
  "body": "Your partner sent you something",
  "data": { "screen": "/chat", "id": 7 },
  "badge": 3,
  "sound": "default",
  "collapseId": "chat-7",
  "threadId": "chat",
  "ttlSeconds": 3600
}
```

Use **either** `userId` (needs the token store) **or**
`"tokens": [{"token": "…", "platform": "ios", "environment": "production"}]`
(admin only, up to 500, works with `TOKEN_STORE=none`). Only one of `title` and `body` is
required. `sound: null` sends a notification without sound.

Response (`200` as soon as the request was processed, even if some devices failed):

```json
{
  "sent": 1,
  "failed": 1,
  "results": [
    { "token": "a1b2c3d4…", "platform": "ios", "ok": true, "environment": "sandbox" },
    { "token": "fGh5…", "platform": "android", "ok": false, "error": "UNREGISTERED", "invalidToken": true }
  ]
}
```

A user without devices returns `{"sent":0,"failed":0,"results":[],"reason":"no_tokens"}`.

**Payload on the device:** on iOS, the keys of `data` are top-level keys next to `aps`; on
Android they are FCM data (values converted to strings, nested values as JSON). In both
cases `PushManager.onMessage` / `onNotificationTap` receive them as top-level keys, e.g.
`payload['screen']`.

### `GET /v1/users/{userId}/tokens` (admin)
Lists a user's devices (tokens masked) with platform, environment, last success and last error.

## 9. Token lifecycle

- **Deleted automatically** when the provider says the token is dead: APNs `410 Unregistered`,
  APNs `BadDeviceToken` in *both* environments, FCM `UNREGISTERED` / `NOT_FOUND`, or an
  invalid registration token.
- **Kept** on errors that usually mean a server misconfiguration, such as
  `DeviceTokenNotForTopic` (wrong bundle id), `SENDER_ID_MISMATCH` (wrong Firebase project),
  `InvalidProviderToken` (wrong key/team id), and on network errors. These are logged as
  warnings with a hint, so a typo in `.env` can't wipe your token table.
- Re-registering a token resets its error counter and moves it to the given user.

## 10. Operations: logs, backup, updates

```bash
docker compose logs -f push-server             # JSON lines
docker compose exec push-server node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>r.text()).then(console.log)"
```

**Backup** of the token store (named volume `push-data`):

```bash
docker compose cp push-server:/data/push.db ./push-backup.db
```

Losing it is not fatal: apps register their token again on the next start.

**Update:**

```bash
git pull
docker compose up -d --build
```

## 11. Development without Docker

Requires Node.js 24 or newer (TypeScript runs natively, no build step).

```bash
cd server
npm ci
cp .env.example .env            # set ADMIN_API_KEY; paths like ./secrets/AuthKey_X.p8
npm run dev                     # watches src/, reads .env
npm test                        # unit + integration tests (fake APNs/FCM servers)
npm run typecheck
```
