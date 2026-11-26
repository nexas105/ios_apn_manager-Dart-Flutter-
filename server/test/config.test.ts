import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { ADMIN_KEY, CLIENT_KEY, ecKeyPem } from "./helpers.ts";

const base = { ADMIN_API_KEY: ADMIN_KEY };

describe("config", () => {
  it("requires a strong admin key", () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ ADMIN_API_KEY: "short" }), /24 characters/);
    assert.throws(() => loadConfig({ ADMIN_API_KEY: "change-me" }), /placeholder/);
    assert.throws(() => loadConfig({ ...base, CLIENT_API_KEY: ADMIN_KEY }), /differ/);
  });

  it("has sensible defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.port, 8080);
    assert.equal(c.allowClientSend, false);
    assert.equal(c.store.enabled, true);
    assert.equal(c.apns, undefined);
    assert.equal(c.fcm, undefined);
    assert.equal(c.jwt, undefined);
  });

  it("reads the APNs key inline (\\n escaped or base64) or from a file", () => {
    const pem = ecKeyPem();
    const apns = { APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_BUNDLE_ID: "com.x" };
    assert.equal(loadConfig({ ...base, ...apns, APNS_KEY: pem.replace(/\n/g, "\\n") }).apns!.key, pem.trim());
    assert.equal(loadConfig({ ...base, ...apns, APNS_KEY: Buffer.from(pem).toString("base64") }).apns!.key, pem.trim());
    const dir = mkdtempSync(join(tmpdir(), "pm-"));
    writeFileSync(join(dir, "AuthKey.p8"), pem);
    const c = loadConfig({ ...base, ...apns, APNS_KEY_PATH: join(dir, "AuthKey.p8"), APNS_ENVIRONMENT: "production" });
    assert.equal(c.apns!.defaultEnvironment, "production");
  });

  it("rejects partial APNs config", () => {
    assert.throws(() => loadConfig({ ...base, APNS_KEY_ID: "K" }), /missing: APNS_KEY or APNS_KEY_PATH, APNS_TEAM_ID/);
  });

  it("takes the FCM project id from the service account", () => {
    const sa = JSON.stringify({ client_email: "a@b", private_key: "k", project_id: "proj" });
    const c = loadConfig({ ...base, FCM_SERVICE_ACCOUNT_JSON: sa });
    assert.equal(c.fcm!.projectId, "proj");
    assert.equal(c.fcm!.androidChannelId, "erohub_default");
    assert.throws(() => loadConfig({ ...base, FCM_SERVICE_ACCOUNT_JSON: "{oops" }), /not valid JSON/);
  });

  it("configures JWT verification", () => {
    const c = loadConfig({ ...base, CLIENT_API_KEY: CLIENT_KEY, JWT_JWKS_URL: "https://example.com/jwks.json", JWT_USER_CLAIM: "uid" });
    assert.equal(c.jwt!.userClaim, "uid");
    assert.throws(() => loadConfig({ ...base, JWT_SECRET: "s", JWT_JWKS_URL: "https://x" }), /either/);
  });
});
