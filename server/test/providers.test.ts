import assert from "node:assert/strict";
import { createServer } from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { ApnsClient, apnsErrorCode, buildApnsPayload } from "../src/apns.ts";
import { FcmClient, buildFcmMessage, fcmErrorCode, fcmInvalidToken } from "../src/fcm.ts";
import { ecKeyPem, IOS_TOKEN, rsaKeyPem } from "./helpers.ts";

describe("APNs payload", () => {
  it("puts custom data next to aps", () => {
    const p = buildApnsPayload({ title: "T", body: "B", data: { screen: "/x", aps: "ignored" }, badge: 2, threadId: "chat" });
    assert.deepEqual(p, {
      screen: "/x",
      aps: { alert: { title: "T", body: "B" }, sound: "default", badge: 2, "thread-id": "chat" },
    });
  });

  it("omits sound when null", () => {
    assert.equal((buildApnsPayload({ title: "T", body: "B", sound: null }).aps as any).sound, undefined);
  });

  it("maps error codes", () => {
    assert.equal(apnsErrorCode(410, '{"reason":"Unregistered"}'), "Unregistered");
    assert.equal(apnsErrorCode(400, '{"reason":"secret stuff"}'), "apns_400");
    assert.equal(apnsErrorCode(410, "garbage"), "Unregistered");
  });
});

describe("FCM message", () => {
  it("stringifies data and sets the channel", () => {
    const m = buildFcmMessage("tok", { title: "T", body: "B", data: { a: 1, b: "x", c: null, d: { e: true } }, badge: 4 }, "chan") as any;
    assert.deepEqual(m.message.data, { a: "1", b: "x", d: '{"e":true}' });
    assert.equal(m.message.android.notification.channel_id, "chan");
    assert.equal(m.message.android.notification.notification_count, 4);
  });

  it("maps error codes and invalid tokens", () => {
    const unreg = JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } });
    assert.equal(fcmErrorCode(404, unreg), "UNREGISTERED");
    assert.equal(fcmInvalidToken(404, "UNREGISTERED", unreg), true);
    assert.equal(fcmInvalidToken(403, "SENDER_ID_MISMATCH", ""), false);
    assert.equal(fcmInvalidToken(400, "INVALID_ARGUMENT", "bad payload"), false);
    assert.equal(fcmInvalidToken(400, "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token"), true);
  });
});

describe("ApnsClient over HTTP/2", () => {
  const seen: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];
  const server = http2.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      if (req.headers[":path"]!.endsWith("/dead")) {
        res.writeHead(410, { "content-type": "application/json" });
        res.end('{"reason":"Unregistered"}');
      } else {
        res.writeHead(200, { "apns-id": "x" });
        res.end();
      }
    });
  });
  after(() => server.close());

  it("sends with a signed provider token and the right headers", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new ApnsClient(
      { key: ecKeyPem(), keyId: "KEY123", teamId: "TEAM123", bundleId: "com.example.app", defaultEnvironment: "sandbox" },
      { sandbox: base, production: base },
    );
    await client.verifyKey();
    const ok = await client.send(IOS_TOKEN, "sandbox", { title: "T", body: "B", collapseId: "c1" });
    assert.deepEqual(ok, { ok: true, status: 200, invalidToken: false });
    const h = seen[0]!.headers;
    assert.equal(h[":path"], `/3/device/${IOS_TOKEN}`);
    assert.equal(h["apns-topic"], "com.example.app");
    assert.equal(h["apns-push-type"], "alert");
    assert.equal(h["apns-collapse-id"], "c1");
    const jwt = String(h.authorization).replace(/^bearer /, "");
    assert.equal(decodeProtectedHeader(jwt).kid, "KEY123");
    assert.equal(decodeJwt(jwt).iss, "TEAM123");
    assert.equal(JSON.parse(seen[0]!.body).aps.alert.title, "T");

    const dead = await client.send("dead", "sandbox", { title: "T", body: "B" });
    assert.deepEqual(dead, { ok: false, status: 410, error: "Unregistered", invalidToken: true });
    client.close();
  });
});

describe("FcmClient", () => {
  let oauthCalls = 0;
  const sent: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/token") {
        oauthCalls++;
        const assertion = new URLSearchParams(body).get("assertion")!;
        assert.equal(decodeJwt(assertion).iss, "svc@example.iam.gserviceaccount.com");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at-1", expires_in: 3600 }));
        return;
      }
      assert.equal(req.headers.authorization, "Bearer at-1");
      const msg = JSON.parse(body);
      sent.push({ url: req.url, msg });
      if (msg.message.token === "gone") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"name":"projects/p/messages/1"}');
      }
    });
  });
  after(() => server.close());

  it("exchanges the service account for a cached token and sends", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new FcmClient(
      {
        serviceAccount: { client_email: "svc@example.iam.gserviceaccount.com", private_key: rsaKeyPem() },
        projectId: "my-project",
        androidChannelId: "erohub_default",
      },
      { tokenUrl: `${base}/token`, apiBase: base },
    );
    assert.equal((await client.send("tok", { title: "T", body: "B" })).ok, true);
    const gone = await client.send("gone", { title: "T", body: "B" });
    assert.deepEqual(gone, { ok: false, status: 404, error: "UNREGISTERED", invalidToken: true });
    assert.equal(oauthCalls, 1);
    assert.equal(sent[0].url, "/v1/projects/my-project/messages:send");
  });
});
