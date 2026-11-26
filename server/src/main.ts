// Entry point: load config, verify credentials, start the HTTP server.

import { createServer } from "node:http";
import { ApnsClient } from "./apns.ts";
import { createApp } from "./app.ts";
import { Authenticator } from "./auth.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { FcmClient } from "./fcm.ts";
import { log, setLogLevel } from "./log.ts";
import { TokenStore } from "./store.ts";

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${e.message}\nSee .env.example for all variables.\n`);
    process.exit(1);
  }
  throw e;
}
setLogLevel(config.logLevel);

const apns = config.apns ? new ApnsClient(config.apns) : undefined;
const fcm = config.fcm ? new FcmClient(config.fcm) : undefined;

try {
  await apns?.verifyKey();
} catch (e) {
  log.error("APNs key could not be loaded, check APNS_KEY / APNS_KEY_PATH", { err: (e as Error).message });
  process.exit(1);
}
try {
  await fcm?.verifyCredentials();
} catch (e) {
  // Not fatal: Google might be unreachable at boot. Sends will retry the OAuth exchange.
  log.warn("FCM credentials could not be verified yet", { err: (e as Error).message });
}

const store = config.store.enabled ? new TokenStore(config.store.path) : undefined;

if (!apns && !fcm) log.warn("Neither APNs nor FCM is configured: every send will fail");
if (config.clientApiKey && !config.jwt) {
  log.warn("CLIENT_API_KEY without JWT verification: any app user can register tokens for any userId");
}
if (config.allowClientSend) {
  log.warn("ALLOW_CLIENT_SEND=true: the app key can send pushes to any userId (rate limited)", {
    perMinute: config.clientSendRateLimit,
  });
}

const server = createServer(
  createApp({
    config,
    auth: new Authenticator(config),
    apns,
    fcm,
    apnsDefaultEnvironment: config.apns?.defaultEnvironment ?? "sandbox",
    store,
  }),
);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

server.listen(config.port, config.host, () => {
  log.info("push server listening", {
    host: config.host,
    port: config.port,
    apns: apns ? { bundleId: config.apns!.bundleId, defaultEnvironment: config.apns!.defaultEnvironment } : false,
    fcm: fcm ? { projectId: config.fcm!.projectId, channel: config.fcm!.androidChannelId } : false,
    tokenStore: store ? config.store.path : false,
    clientKey: Boolean(config.clientApiKey),
    userJwt: config.jwt ? (config.jwt.secret ? "secret" : "jwks") : false,
    clientSend: config.allowClientSend,
  });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  server.close(() => {
    apns?.close();
    fcm?.close();
    store?.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
