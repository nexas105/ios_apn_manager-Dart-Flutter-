import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "../src/app.ts";
import { Authenticator } from "../src/auth.ts";
import type { Config } from "../src/config.ts";
import { setLogLevel } from "../src/log.ts";
import { TokenStore } from "../src/store.ts";
import type { ApnsSender, DeliveryResult, FcmSender, PushMessage } from "../src/types.ts";

setLogLevel("error");

export const ADMIN_KEY = "admin-key-0123456789abcdefghijkl";
export const CLIENT_KEY = "client-key-0123456789abcdefghijk";
export const JWT_SECRET = "jwt-secret-for-tests-0123456789abcdef";
export const IOS_TOKEN = "a".repeat(64);
export const IOS_TOKEN_2 = "b".repeat(64);
export const ANDROID_TOKEN = "fcm-token_abc:def-1234567890";

export function ecKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export function rsaKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

type Responder = (token: string, env?: string) => DeliveryResult;
const OK: DeliveryResult = { ok: true, status: 200, invalidToken: false };

export class FakeApns implements ApnsSender {
  calls: Array<{ token: string; env: string; msg: PushMessage }> = [];
  respond: Responder = () => OK;
  async send(token: string, env: "sandbox" | "production", msg: PushMessage) {
    this.calls.push({ token, env, msg });
    return this.respond(token, env);
  }
  close() {}
}

export class FakeFcm implements FcmSender {
  calls: Array<{ token: string; msg: PushMessage }> = [];
  respond: Responder = () => OK;
  async send(token: string, msg: PushMessage) {
    this.calls.push({ token, msg });
    return this.respond(token);
  }
  close() {}
}

export interface TestServer {
  url: string;
  store: TokenStore;
  apns: FakeApns;
  fcm: FakeFcm;
  close(): Promise<void>;
  request(method: string, path: string, opts?: { key?: string; body?: unknown; userToken?: string }): Promise<{
    status: number;
    body: any;
    headers: Headers;
  }>;
}

export async function startServer(
  overrides: Partial<Pick<Config, "allowClientSend" | "clientSendRateLimit" | "jwt">> & { noStore?: boolean } = {},
): Promise<TestServer> {
  const store = new TokenStore(":memory:");
  const apns = new FakeApns();
  const fcm = new FakeFcm();
  const deps: AppDeps = {
    config: {
      allowClientSend: overrides.allowClientSend ?? false,
      clientSendRateLimit: overrides.clientSendRateLimit ?? 30,
      trustProxy: false,
      maxBodyBytes: 64 * 1024,
    },
    auth: new Authenticator({ adminApiKey: ADMIN_KEY, clientApiKey: CLIENT_KEY, jwt: overrides.jwt }),
    apns,
    fcm,
    apnsDefaultEnvironment: "sandbox",
    store: overrides.noStore ? undefined : store,
  };
  const server: Server = createServer(createApp(deps));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    store,
    apns,
    fcm,
    close: () =>
      new Promise((r) => {
        store.close();
        server.close(() => r());
        server.closeAllConnections();
      }),
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.key) headers.authorization = `Bearer ${opts.key}`;
      if (opts.userToken) headers["x-user-token"] = opts.userToken;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(url + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
    },
  };
}
