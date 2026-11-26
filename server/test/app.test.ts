import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SignJWT } from "jose";
import {
  ADMIN_KEY, ANDROID_TOKEN, CLIENT_KEY, IOS_TOKEN, IOS_TOKEN_2, JWT_SECRET, startServer, type TestServer,
} from "./helpers.ts";

let srv: TestServer;
afterEach(async () => srv?.close());

const userJwt = (sub: string, secret = JWT_SECRET) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));

describe("auth", () => {
  it("serves /health without a key", async () => {
    srv = await startServer();
    const r = await srv.request("GET", "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "ok" });
  });

  it("rejects missing and wrong keys", async () => {
    srv = await startServer();
    assert.equal((await srv.request("POST", "/v1/send", { body: {} })).status, 401);
    const r = await srv.request("POST", "/v1/send", { key: "wrong-key-wrong-key-wrong-key", body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_api_key");
  });

  it("returns 404 for unknown routes before auth", async () => {
    srv = await startServer();
    assert.equal((await srv.request("GET", "/nope")).status, 404);
  });

  it("only lets admins list tokens", async () => {
    srv = await startServer();
    assert.equal((await srv.request("GET", "/v1/users/u1/tokens", { key: CLIENT_KEY })).status, 403);
    assert.equal((await srv.request("GET", "/v1/users/u1/tokens", { key: ADMIN_KEY })).status, 200);
  });
});

describe("tokens", () => {
  it("registers, lists (masked) and deletes a token", async () => {
    srv = await startServer();
    let r = await srv.request("POST", "/v1/tokens", {
      key: CLIENT_KEY,
      body: { userId: "u1", token: IOS_TOKEN, platform: "ios", environment: "sandbox" },
    });
    assert.equal(r.status, 200);
    r = await srv.request("GET", "/v1/users/u1/tokens", { key: ADMIN_KEY });
    assert.equal(r.body.tokens.length, 1);
    assert.equal(r.body.tokens[0].token, "aaaaaaaa…");
    assert.equal(r.body.tokens[0].environment, "sandbox");
    r = await srv.request("DELETE", `/v1/tokens/${IOS_TOKEN}`, { key: CLIENT_KEY });
    assert.deepEqual(r.body, { ok: true, removed: true });
    assert.equal(srv.store.tokensForUser("u1").length, 0);
  });

  it("moves a token to the newest user", async () => {
    srv = await startServer();
    for (const userId of ["u1", "u2"]) {
      await srv.request("POST", "/v1/tokens", { key: ADMIN_KEY, body: { userId, token: ANDROID_TOKEN, platform: "android" } });
    }
    assert.equal(srv.store.tokensForUser("u1").length, 0);
    assert.equal(srv.store.tokensForUser("u2").length, 1);
  });

  it("validates input", async () => {
    srv = await startServer();
    const cases = [
      { userId: "u1", token: "not-hex!", platform: "ios" },
      { userId: "u1", token: IOS_TOKEN, platform: "web" },
      { token: IOS_TOKEN, platform: "ios" },
      { userId: "u1", token: IOS_TOKEN, platform: "ios", environment: "staging" },
    ];
    for (const body of cases) {
      const r = await srv.request("POST", "/v1/tokens", { key: ADMIN_KEY, body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  it("rejects malformed URL encoding with 400", async () => {
    srv = await startServer();
    assert.equal((await srv.request("DELETE", "/v1/tokens/%E0%A4%A", { key: ADMIN_KEY })).status, 400);
  });

  it("reports a disabled token store", async () => {
    srv = await startServer({ noStore: true });
    const r = await srv.request("POST", "/v1/tokens", { key: ADMIN_KEY, body: { userId: "u", token: IOS_TOKEN, platform: "ios" } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "token_store_disabled");
  });
});

describe("user JWT", () => {
  const jwt = { secret: JWT_SECRET, userClaim: "sub" };

  it("requires a valid user token for the client key", async () => {
    srv = await startServer({ jwt });
    const body = { token: IOS_TOKEN, platform: "ios" };
    assert.equal((await srv.request("POST", "/v1/tokens", { key: CLIENT_KEY, body })).body.error, "missing_user_token");
    const forged = await userJwt("u1", "another-secret-another-secret-123");
    assert.equal((await srv.request("POST", "/v1/tokens", { key: CLIENT_KEY, body, userToken: forged })).body.error, "invalid_user_token");
  });

  it("binds registration to the JWT subject", async () => {
    srv = await startServer({ jwt });
    const token = await userJwt("u1");
    let r = await srv.request("POST", "/v1/tokens", { key: CLIENT_KEY, userToken: token, body: { token: IOS_TOKEN, platform: "ios" } });
    assert.equal(r.status, 200);
    assert.equal(srv.store.tokensForUser("u1").length, 1);
    r = await srv.request("POST", "/v1/tokens", {
      key: CLIENT_KEY, userToken: token, body: { userId: "u2", token: IOS_TOKEN_2, platform: "ios" },
    });
    assert.equal(r.status, 403);
  });

  it("lets clients delete only their own tokens", async () => {
    srv = await startServer({ jwt });
    srv.store.upsert("u2", { token: IOS_TOKEN, platform: "ios" });
    const r = await srv.request("DELETE", `/v1/tokens/${IOS_TOKEN}`, { key: CLIENT_KEY, userToken: await userJwt("u1") });
    assert.equal(r.body.removed, false);
    assert.equal(srv.store.tokensForUser("u2").length, 1);
  });

  it("does not require a user token for the admin key", async () => {
    srv = await startServer({ jwt });
    const r = await srv.request("POST", "/v1/tokens", { key: ADMIN_KEY, body: { userId: "u9", token: IOS_TOKEN, platform: "ios" } });
    assert.equal(r.status, 200);
  });
});

describe("send", () => {
  const msg = { title: "Hi", body: "There", data: { screen: "/chat", n: 3 } };

  it("sends to all tokens of a user", async () => {
    srv = await startServer();
    srv.store.upsert("u1", { token: IOS_TOKEN, platform: "ios", environment: "production" });
    srv.store.upsert("u1", { token: ANDROID_TOKEN, platform: "android" });
    const r = await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "u1", ...msg } });
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, 2);
    assert.equal(srv.apns.calls[0]!.env, "production");
    assert.deepEqual(srv.apns.calls[0]!.msg.data, msg.data);
    assert.equal(srv.fcm.calls.length, 1);
  });

  it("sends to explicit tokens without the store", async () => {
    srv = await startServer({ noStore: true });
    const r = await srv.request("POST", "/v1/send", {
      key: ADMIN_KEY, body: { tokens: [{ token: IOS_TOKEN, platform: "ios" }], ...msg },
    });
    assert.equal(r.body.sent, 1);
    assert.equal(srv.apns.calls[0]!.env, "sandbox");
  });

  it("reports no_tokens", async () => {
    srv = await startServer();
    const r = await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "ghost", ...msg } });
    assert.deepEqual(r.body, { sent: 0, failed: 0, results: [], reason: "no_tokens" });
  });

  it("requires exactly one of userId/tokens and some text", async () => {
    srv = await startServer();
    assert.equal((await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: msg })).status, 400);
    assert.equal((await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "u", title: "", body: "" } })).status, 400);
  });

  it("removes tokens the provider reports as unregistered", async () => {
    srv = await startServer();
    srv.store.upsert("u1", { token: ANDROID_TOKEN, platform: "android" });
    srv.fcm.respond = () => ({ ok: false, status: 404, error: "UNREGISTERED", invalidToken: true });
    const r = await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "u1", ...msg } });
    assert.equal(r.body.failed, 1);
    assert.equal(r.body.results[0].invalidToken, true);
    assert.equal(srv.store.tokensForUser("u1").length, 0);
  });

  it("keeps tokens on likely config errors", async () => {
    srv = await startServer();
    srv.store.upsert("u1", { token: ANDROID_TOKEN, platform: "android" });
    srv.fcm.respond = () => ({ ok: false, status: 403, error: "SENDER_ID_MISMATCH", invalidToken: false });
    await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "u1", ...msg } });
    const [t] = srv.store.tokensForUser("u1");
    assert.equal(t!.failureCount, 1);
    assert.equal(t!.lastError, "SENDER_ID_MISMATCH");
  });

  it("falls back to the other APNs environment on BadDeviceToken and remembers it", async () => {
    srv = await startServer();
    srv.store.upsert("u1", { token: IOS_TOKEN, platform: "ios" });
    srv.apns.respond = (_t, env) =>
      env === "production" ? { ok: true, status: 200, invalidToken: false }
        : { ok: false, status: 400, error: "BadDeviceToken", invalidToken: true };
    const r = await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "u1", ...msg } });
    assert.equal(r.body.sent, 1);
    assert.equal(r.body.results[0].environment, "production");
    assert.deepEqual(srv.apns.calls.map((c) => c.env), ["sandbox", "production"]);
    assert.equal(srv.store.tokensForUser("u1")[0]!.environment, "production");
  });

  it("deletes an iOS token only after both environments say BadDeviceToken", async () => {
    srv = await startServer();
    srv.store.upsert("u1", { token: IOS_TOKEN, platform: "ios" });
    srv.apns.respond = () => ({ ok: false, status: 400, error: "BadDeviceToken", invalidToken: true });
    await srv.request("POST", "/v1/send", { key: ADMIN_KEY, body: { userId: "u1", ...msg } });
    assert.equal(srv.apns.calls.length, 2);
    assert.equal(srv.store.tokensForUser("u1").length, 0);
  });
});

describe("client send", () => {
  const body = { userId: "u2", title: "Hi", body: "x" };

  it("is disabled by default", async () => {
    srv = await startServer();
    const r = await srv.request("POST", "/v1/send", { key: CLIENT_KEY, body });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "client_send_disabled");
  });

  it("works by userId when enabled, never with raw tokens", async () => {
    srv = await startServer({ allowClientSend: true });
    srv.store.upsert("u2", { token: IOS_TOKEN, platform: "ios" });
    assert.equal((await srv.request("POST", "/v1/send", { key: CLIENT_KEY, body })).body.sent, 1);
    const r = await srv.request("POST", "/v1/send", {
      key: CLIENT_KEY, body: { tokens: [{ token: IOS_TOKEN, platform: "ios" }], title: "x" },
    });
    assert.equal(r.status, 403);
  });

  it("is rate limited", async () => {
    srv = await startServer({ allowClientSend: true, clientSendRateLimit: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await srv.request("POST", "/v1/send", { key: CLIENT_KEY, body })).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});
