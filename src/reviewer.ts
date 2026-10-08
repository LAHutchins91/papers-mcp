import crypto from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Password hash format, one line:
 * `scrypt$16384$8$1$<salt-base64url>$<hash-base64url>`
 * salt is 16 bytes, hash is 32 bytes, scrypt params N=16384, r=8, p=1.
 */
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export function configuredReviewerEmail(): string {
  return (process.env.REVIEWER_LOGIN_EMAIL ?? "").trim().toLowerCase();
}

export function reviewerLoginConfigured(): boolean {
  return configuredReviewerEmail().length > 0 && (process.env.REVIEWER_LOGIN_PASSWORD_HASH ?? "").trim().length > 0;
}

/** Stable account id for a reviewer email. Not a secret. */
export function reviewerAccountId(email: string): string {
  const normalized = email.trim().toLowerCase();
  return crypto.createHash("sha256").update(`papers-reviewer\0${normalized}`).digest("hex").slice(0, 32);
}

export function hashReviewerPassword(password: string, salt = crypto.randomBytes(SALT_BYTES)): string {
  if (salt.length !== SALT_BYTES) throw new Error("Reviewer password salt must be 16 bytes.");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === b.length) return crypto.timingSafeEqual(a, b);
  crypto.timingSafeEqual(a, a);
  return false;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const match = HASH_PATTERN.exec(stored.trim());
  if (!match) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  const salt = Buffer.from(match[4], "base64url");
  const hash = Buffer.from(match[5], "base64url");
  if (salt.length !== SALT_BYTES || hash.length !== SCRYPT_KEYLEN) return null;
  return { N, r, p, salt, hash };
}

function dummyScrypt(): Buffer {
  return crypto.scryptSync("papers-reviewer", Buffer.alloc(SALT_BYTES, 1), SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
}

/** Constant-time password check. A malformed hash still runs scrypt and timingSafeEqual. */
export function reviewerPasswordMatches(password: string, stored: string): boolean {
  const parsed = parseHash(stored);
  const usable = password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
  let actual: Buffer;
  try {
    actual = parsed && usable
      ? crypto.scryptSync(password, parsed.salt, SCRYPT_KEYLEN, { N: parsed.N, r: parsed.r, p: parsed.p })
      : dummyScrypt();
  } catch {
    actual = Buffer.alloc(SCRYPT_KEYLEN);
  }
  const expected = parsed?.hash ?? Buffer.alloc(SCRYPT_KEYLEN);
  if (actual.length !== expected.length) {
    crypto.timingSafeEqual(Buffer.alloc(SCRYPT_KEYLEN), Buffer.alloc(SCRYPT_KEYLEN));
    return false;
  }
  const equal = crypto.timingSafeEqual(actual, expected);
  return parsed !== null && usable && equal;
}

export function reviewerCredentialsMatch(email: string, password: string): boolean {
  const expected = configuredReviewerEmail();
  const given = email.trim().toLowerCase().slice(0, 254);
  const emailOk = expected.length > 0 && timingSafeEqualText(given, expected);
  const passwordOk = reviewerPasswordMatches(password, (process.env.REVIEWER_LOGIN_PASSWORD_HASH ?? "").trim());
  return emailOk && passwordOk;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Permanent complimentary entitlement. Ids match the account id; emails match reviewerAccountId(email). */
export function isCompAccount(userId: string): boolean {
  if (!userId) return false;
  for (const id of envList("COMP_ACCOUNT_IDS")) {
    if (timingSafeEqualText(id, userId)) return true;
  }
  for (const email of envList("COMP_ACCOUNT_EMAILS")) {
    if (timingSafeEqualText(reviewerAccountId(email), userId)) return true;
  }
  return false;
}
