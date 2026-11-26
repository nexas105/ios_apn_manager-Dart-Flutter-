import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Platform a device token belongs to.
enum PushPlatform { ios, android }

/// APNs environment of an iOS device token.
///
/// Debug builds from Xcode and the iOS Simulator get [sandbox] tokens,
/// TestFlight and App Store builds get [production] tokens.
enum ApnsEnvironment { sandbox, production }

/// Thrown when the push server answers with a non-2xx status.
class PushServerException implements Exception {
  PushServerException(this.statusCode, this.code, this.message);

  /// HTTP status (0 for network errors and timeouts).
  final int statusCode;

  /// Machine-readable error code from the server, e.g. `invalid_api_key`,
  /// `client_send_disabled`, `rate_limited`.
  final String code;
  final String message;

  @override
  String toString() => 'PushServerException($statusCode, $code): $message';
}

/// Delivery result for a single device token.
class PushTargetResult {
  const PushTargetResult({
    required this.token,
    required this.platform,
    required this.ok,
    this.error,
    this.invalidToken = false,
  });

  factory PushTargetResult.fromJson(Map<String, dynamic> json) =>
      PushTargetResult(
        token: json['token'] as String? ?? '',
        platform: json['platform'] as String? ?? '',
        ok: json['ok'] as bool? ?? false,
        error: json['error'] as String?,
        invalidToken: json['invalidToken'] as bool? ?? false,
      );

  /// Masked token (first 8 characters).
  final String token;
  final String platform;
  final bool ok;

  /// Provider error code such as `Unregistered` or `UNREGISTERED`.
  final String? error;

  /// The token was dead and the server removed it.
  final bool invalidToken;
}

/// Result of [PushServerClient.send].
class PushSendResult {
  const PushSendResult({
    required this.sent,
    required this.failed,
    this.reason,
    this.results = const [],
  });

  factory PushSendResult.fromJson(Map<String, dynamic> json) => PushSendResult(
    sent: json['sent'] as int? ?? 0,
    failed: json['failed'] as int? ?? 0,
    reason: json['reason'] as String?,
    results: [
      for (final r in (json['results'] as List? ?? const []))
        PushTargetResult.fromJson(Map<String, dynamic>.from(r as Map)),
    ],
  );

  final int sent;
  final int failed;

  /// `no_tokens` when the user has no registered device.
  final String? reason;
  final List<PushTargetResult> results;
}

/// Talks to the self-hosted push server in `server/` of this repository.
///
/// The [apiKey] you put in an app is extractable, so use the server's
/// `CLIENT_API_KEY` here, **never** `ADMIN_API_KEY`. APNs/FCM credentials stay on
/// the server.
///
/// ```dart
/// final push = PushServerClient(
///   baseUrl: Uri.parse('https://push.example.com'),
///   apiKey: const String.fromEnvironment('PUSH_CLIENT_KEY'),
///   userToken: () async => auth.currentSession?.accessToken, // if JWT_* is set
/// );
///
/// PushManager.onToken = (token) => push.registerToken(userId: me.id, token: token);
/// PushManager.setSendHandler(HttpSendHandler.fromClient(push).call);
/// ```
class PushServerClient {
  PushServerClient({
    required Uri baseUrl,
    required this.apiKey,
    this.userToken,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 15),
  }) : baseUrl = _withTrailingSlash(baseUrl),
       _http = httpClient ?? http.Client(),
       _ownsClient = httpClient == null;

  /// Server URL, e.g. `https://push.example.com` or `http://192.168.0.10:8080`.
  final Uri baseUrl;

  /// The server's `CLIENT_API_KEY` (or `ADMIN_API_KEY` in your own backend).
  final String apiKey;

  /// Returns the signed-in user's JWT. Required when the server has
  /// `JWT_SECRET` / `JWT_JWKS_URL` configured; sent as `X-User-Token`.
  final FutureOr<String?> Function()? userToken;

  final Duration timeout;
  final http.Client _http;
  final bool _ownsClient;

  static Uri _withTrailingSlash(Uri uri) =>
      uri.path.endsWith('/') ? uri : uri.replace(path: '${uri.path}/');

  /// Platform of the current device.
  static PushPlatform get currentPlatform =>
      defaultTargetPlatform == TargetPlatform.iOS
      ? PushPlatform.ios
      : PushPlatform.android;

  /// APNs environment of this build: [ApnsEnvironment.production] in release
  /// builds, otherwise [ApnsEnvironment.sandbox].
  ///
  /// A release build run directly from Xcode still uses the sandbox. The
  /// server retries the other environment automatically, so a wrong guess
  /// only costs one extra request the first time.
  static ApnsEnvironment get defaultApnsEnvironment =>
      kReleaseMode ? ApnsEnvironment.production : ApnsEnvironment.sandbox;

  /// Registers [token] (from `PushManager.onToken`) for [userId].
  ///
  /// With JWT verification on the server, [userId] may be omitted: the server
  /// takes it from the user's JWT and rejects any other id.
  Future<void> registerToken({
    String? userId,
    required String token,
    PushPlatform? platform,
    ApnsEnvironment? environment,
  }) async {
    final p = platform ?? currentPlatform;
    await _request('POST', 'v1/tokens', {
      'userId': ?userId,
      'token': token,
      'platform': p.name,
      if (p == PushPlatform.ios)
        'environment': (environment ?? defaultApnsEnvironment).name,
    });
  }

  /// Removes [token] from the server, e.g. on logout.
  Future<void> unregisterToken(String token) =>
      _request('DELETE', 'v1/tokens/${Uri.encodeComponent(token)}');

  /// Sends a push to all devices of [userId].
  ///
  /// With the client key this only works if the server runs with
  /// `ALLOW_CLIENT_SEND=true`; otherwise it throws a [PushServerException]
  /// with code `client_send_disabled`.
  Future<PushSendResult> send({
    required String userId,
    required String title,
    required String body,
    Map<String, dynamic>? data,
    int? badge,
    String? sound,
    String? collapseId,
    String? threadId,
  }) async {
    final json = await _request('POST', 'v1/send', {
      'userId': userId,
      'title': title,
      'body': body,
      'data': ?data,
      'badge': ?badge,
      'sound': ?sound,
      'collapseId': ?collapseId,
      'threadId': ?threadId,
    });
    return PushSendResult.fromJson(json);
  }

  Future<Map<String, dynamic>> _request(
    String method,
    String path, [
    Map<String, Object?>? body,
  ]) async {
    final headers = <String, String>{
      'authorization': 'Bearer $apiKey',
      'accept': 'application/json',
      if (body != null) 'content-type': 'application/json',
    };
    final jwt = await userToken?.call();
    if (jwt != null && jwt.isNotEmpty) headers['x-user-token'] = jwt;

    final request = http.Request(method, baseUrl.resolve(path))
      ..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);

    final http.Response res;
    try {
      res = await http.Response.fromStream(
        await _http.send(request).timeout(timeout),
      ).timeout(timeout);
    } on TimeoutException {
      throw PushServerException(0, 'timeout', 'Push server did not answer');
    } on http.ClientException catch (e) {
      throw PushServerException(0, 'network_error', e.message);
    }

    Map<String, dynamic> json = const {};
    if (res.bodyBytes.isNotEmpty) {
      try {
        final decoded = jsonDecode(utf8.decode(res.bodyBytes));
        if (decoded is Map) json = Map<String, dynamic>.from(decoded);
      } on FormatException {
        // Non-JSON body (e.g. a proxy error page); handled below.
      }
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw PushServerException(
        res.statusCode,
        json['error'] as String? ?? 'http_${res.statusCode}',
        json['message'] as String? ?? res.reasonPhrase ?? 'Request failed',
      );
    }
    return json;
  }

  /// Closes the underlying HTTP client if this instance created it.
  void close() {
    if (_ownsClient) _http.close();
  }
}

/// Ready-made send handler for `PushManager.setSendHandler` that sends through
/// the self-hosted push server.
///
/// ```dart
/// PushManager.setSendHandler(HttpSendHandler(
///   url: Uri.parse('https://push.example.com'),
///   apiKey: const String.fromEnvironment('PUSH_CLIENT_KEY'),
/// ).call);
/// ```
///
/// Sending from the app needs `ALLOW_CLIENT_SEND=true` on the server. Throws
/// [PushServerException] on HTTP errors; a user without devices is not an error.
class HttpSendHandler {
  HttpSendHandler({
    required Uri url,
    required String apiKey,
    FutureOr<String?> Function()? userToken,
    http.Client? httpClient,
  }) : client = PushServerClient(
         baseUrl: url,
         apiKey: apiKey,
         userToken: userToken,
         httpClient: httpClient,
       );

  /// Shares one [PushServerClient] for token registration and sending.
  HttpSendHandler.fromClient(this.client);

  final PushServerClient client;

  /// Called by `PushManager.sendPush`. Pass it as `handler.call`.
  Future<void> call(
    String profileId,
    String title,
    String body,
    Map<String, dynamic>? data,
  ) async {
    await client.send(userId: profileId, title: title, body: body, data: data);
  }
}
