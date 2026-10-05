import crypto from "node:crypto";

let ephemeralSecret: string | null = null;

export function authSecret(): string {
  const configured = process.env.AUTH_SIGNING_SECRET?.trim();
  if (configured) return configured;
  if (!ephemeralSecret) ephemeralSecret = crypto.randomBytes(32).toString("hex");
  return ephemeralSecret;
}

export interface TokenPayload {
  typ: string;
  exp: number;
  iat: number;
  [key: string]: unknown;
}

function b64(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const data = b64(JSON.stringify(body));
  const sig = b64(crypto.createHmac("sha256", authSecret()).update(data).digest());
  return `v1.${data}.${sig}`;
}

export function verifyToken<T extends TokenPayload>(token: string, typ?: string): T {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Malformed token");
  const [, data, sig] = parts;
  const expected = b64(crypto.createHmac("sha256", authSecret()).update(data).digest());
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error("Bad signature");
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error("Malformed token");
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Expired token");
  }
  if (typ && payload.typ !== typ) throw new Error("Unexpected token type");
  return payload;
}
