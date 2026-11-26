// API-key auth (admin/client) plus optional end-user JWT verification.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config, JwtConfig } from "./config.ts";

export type Principal =
  | { role: "admin" }
  /** userId is set when JWT verification is configured (it is then the only id the client may act for). */
  | { role: "client"; userId?: string };

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time compare that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export class Authenticator {
  private readonly adminKey: string;
  private readonly clientKey: string | undefined;
  private readonly jwt: JwtConfig | undefined;
  private readonly jwtKey: Uint8Array | JWTVerifyGetKey | undefined;

  constructor(config: Pick<Config, "adminApiKey" | "clientApiKey" | "jwt">) {
    this.adminKey = config.adminApiKey;
    this.clientKey = config.clientApiKey;
    this.jwt = config.jwt;
    if (config.jwt?.secret) this.jwtKey = new TextEncoder().encode(config.jwt.secret);
    else if (config.jwt?.jwksUrl) this.jwtKey = createRemoteJWKSet(new URL(config.jwt.jwksUrl));
  }

  async authenticate(req: IncomingMessage): Promise<Principal> {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) throw new AuthError(401, "missing_api_key", "Authorization: Bearer <api key> required");
    const key = match[1]!.trim();

    if (safeEqual(key, this.adminKey)) return { role: "admin" };
    if (this.clientKey && safeEqual(key, this.clientKey)) {
      if (!this.jwt) return { role: "client" };
      return { role: "client", userId: await this.verifyUserToken(req) };
    }
    throw new AuthError(401, "invalid_api_key", "Invalid API key");
  }

  private async verifyUserToken(req: IncomingMessage): Promise<string> {
    const raw = req.headers["x-user-token"];
    const token = (Array.isArray(raw) ? raw[0] : raw)?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new AuthError(401, "missing_user_token", "X-User-Token header with the user's JWT required");
    const jwt = this.jwt!;
    try {
      const options = {
        issuer: jwt.issuer,
        audience: jwt.audience,
        ...(jwt.secret ? { algorithms: ["HS256", "HS384", "HS512"] } : {}),
      };
      const { payload } =
        this.jwtKey instanceof Uint8Array
          ? await jwtVerify(token, this.jwtKey, options)
          : await jwtVerify(token, this.jwtKey as JWTVerifyGetKey, options);
      const userId = payload[jwt.userClaim];
      if (typeof userId !== "string" || !userId) {
        throw new AuthError(401, "invalid_user_token", `JWT has no string claim "${jwt.userClaim}"`);
      }
      return userId;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(401, "invalid_user_token", "User JWT is invalid or expired");
    }
  }
}
