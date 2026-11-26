import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:push_manager/push_manager.dart';

void main() {
  late List<http.Request> requests;
  late http.Response Function(http.Request) respond;

  setUp(() {
    requests = [];
    respond = (_) => http.Response('{"ok":true}', 200);
  });

  PushServerClient client({String base = 'https://push.example.com/api'}) =>
      PushServerClient(
        baseUrl: Uri.parse(base),
        apiKey: 'client-key',
        userToken: () => 'user-jwt',
        httpClient: MockClient((r) async {
          requests.add(r);
          return respond(r);
        }),
      );

  Map<String, dynamic> bodyOf(http.Request r) =>
      jsonDecode(r.body) as Map<String, dynamic>;

  test('registerToken sends platform, environment and auth headers', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);

    await client().registerToken(userId: 'u1', token: 'abcd');

    final r = requests.single;
    expect(r.method, 'POST');
    expect(r.url.toString(), 'https://push.example.com/api/v1/tokens');
    expect(r.headers['authorization'], 'Bearer client-key');
    expect(r.headers['x-user-token'], 'user-jwt');
    expect(bodyOf(r), {
      'userId': 'u1',
      'token': 'abcd',
      'platform': 'ios',
      'environment': 'sandbox', // tests run in debug mode
    });
  });

  test(
    'registerToken omits environment on Android and userId if null',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      await client().registerToken(token: 'fcm');
      expect(bodyOf(requests.single), {'token': 'fcm', 'platform': 'android'});
    },
  );

  test('unregisterToken encodes the token in the path', () async {
    await client().unregisterToken('a:b/c');
    expect(requests.single.method, 'DELETE');
    expect(requests.single.url.path, '/api/v1/tokens/a%3Ab%2Fc');
  });

  test('send parses the result', () async {
    respond = (_) => http.Response.bytes(
      utf8.encode(
        jsonEncode({
          'sent': 1,
          'failed': 1,
          'results': [
            {'token': 'aaaaaaaa…', 'platform': 'ios', 'ok': true},
            {
              'token': 'bbbbbbbb…',
              'platform': 'android',
              'ok': false,
              'error': 'UNREGISTERED',
              'invalidToken': true,
            },
          ],
        }),
      ),
      200,
      headers: {'content-type': 'application/json'}, // no charset on purpose
    );
    final result = await client().send(
      userId: 'u2',
      title: 'Hi',
      body: 'There',
      data: {'screen': '/chat'},
    );
    expect(bodyOf(requests.single), {
      'userId': 'u2',
      'title': 'Hi',
      'body': 'There',
      'data': {'screen': '/chat'},
    });
    expect(result.sent, 1);
    expect(result.results.last.invalidToken, isTrue);
    expect(result.results.last.error, 'UNREGISTERED');
  });

  test('server errors become PushServerException', () async {
    respond = (_) =>
        http.Response('{"error":"client_send_disabled","message":"nope"}', 403);
    await expectLater(
      client().send(userId: 'u', title: 't', body: 'b'),
      throwsA(
        isA<PushServerException>()
            .having((e) => e.statusCode, 'statusCode', 403)
            .having((e) => e.code, 'code', 'client_send_disabled'),
      ),
    );
  });

  test('non-JSON error bodies are handled', () async {
    respond = (_) => http.Response('<html>Bad Gateway</html>', 502);
    await expectLater(
      client().registerToken(token: 't', platform: PushPlatform.android),
      throwsA(
        isA<PushServerException>().having((e) => e.code, 'code', 'http_502'),
      ),
    );
  });

  test('HttpSendHandler plugs into PushManager.setSendHandler', () async {
    respond = (_) =>
        http.Response('{"sent":0,"failed":0,"reason":"no_tokens"}', 200);
    PushManager.setSendHandler(HttpSendHandler.fromClient(client()).call);

    await PushManager.sendPush(profileId: 'p1', title: 'T', body: 'B');

    expect(requests.single.url.path, '/api/v1/send');
    expect(bodyOf(requests.single)['userId'], 'p1');
  });
}
