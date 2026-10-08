import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userMayUseTools } from "../src/billing.js";
import {
  hashReviewerPassword,
  isCompAccount,
  reviewerAccountId,
  reviewerCredentialsMatch,
  reviewerPasswordMatches
} from "../src/reviewer.js";
import { app } from "../src/server.js";
import { resetStoreForTests } from "../src/store.js";

const EMAIL = "reviewer@example.com";
const PASSWORD = "reviewer-test-password";
const KNOWN_HASH = "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$QOAt4tmm5of9ig_Qv_yVkb3n3E4NB3pDAjnTxFdR2Gg";
const KNOWN_ID = "2989dae97874ec6271e9f7acddbd9e59";
const ENV_KEYS = [
  "REVIEWER_LOGIN_EMAIL",
  "REVIEWER_LOGIN_PASSWORD_HASH",
  "COMP_ACCOUNT_IDS",
  "COMP_ACCOUNT_EMAILS",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_MONTHLY",
  "STRIPE_PRICE_YEARLY"
] as const;

function clearReviewerEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function enableBilling(): void {
  process.env.STRIPE_SECRET_KEY = "sk_test_reviewer";
  process.env.STRIPE_PRICE_MONTHLY = "price_monthly_test";
  process.env.STRIPE_PRICE_YEARLY = "price_yearly_test";
}

describe("reviewer credentials and complimentary access", () => {
  afterEach(() => {
    clearReviewerEnv();
    resetStoreForTests();
    vi.restoreAllMocks();
  });

  it("locks the scrypt hash format and the derived account id", () => {
    const salt = Buffer.from("0123456789abcdef");
    expect(hashReviewerPassword(PASSWORD, salt)).toBe(KNOWN_HASH);
    expect(reviewerAccountId(EMAIL)).toBe(KNOWN_ID);
    expect(reviewerAccountId(`  ${EMAIL.toUpperCase()}  `)).toBe(KNOWN_ID);
  });

  it("rejects a wrong reviewer password with a constant-time compare", () => {
    process.env.REVIEWER_LOGIN_EMAIL = EMAIL;
    process.env.REVIEWER_LOGIN_PASSWORD_HASH = KNOWN_HASH;
    const lengths: Array<[number, number]> = [];
    const original = crypto.timingSafeEqual;
    const spy = vi.spyOn(crypto, "timingSafeEqual").mockImplementation((left, right) => {
      lengths.push([left.byteLength, right.byteLength]);
      return original(left, right);
    });
    expect(reviewerPasswordMatches("wrong-reviewer-password", KNOWN_HASH)).toBe(false);
    expect(reviewerCredentialsMatch(EMAIL, "wrong-reviewer-password")).toBe(false);
    expect(reviewerCredentialsMatch("someone-else@example.com", PASSWORD)).toBe(false);
    expect(reviewerCredentialsMatch(EMAIL, PASSWORD)).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(lengths.some(([left, right]) => left === right && left === 32)).toBe(true);
    expect(lengths.every(([left, right]) => left === right)).toBe(true);
  });

  it("lets a comped account skip the trial and stops a normal account", async () => {
    enableBilling();
    process.env.COMP_ACCOUNT_IDS = ` ${KNOWN_ID} `;
    const stripeUrls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.stripe.com/")) {
        stripeUrls.push(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return original(input, init);
    };
    try {
      expect(await userMayUseTools(KNOWN_ID)).toBe("allowed");
      expect(stripeUrls).toEqual([]);
      expect(await userMayUseTools("normal-user-1234")).toBe("payment_required");
      expect(stripeUrls.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats COMP_ACCOUNT_EMAILS as a permanent entitlement for that reviewer id only", async () => {
    enableBilling();
    process.env.COMP_ACCOUNT_EMAILS = `other@example.com, ${EMAIL.toUpperCase()}`;
    expect(isCompAccount(reviewerAccountId(EMAIL))).toBe(true);
    expect(isCompAccount("normal-user-1234")).toBe(false);
    expect(await userMayUseTools(reviewerAccountId(EMAIL))).toBe("allowed");
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.stripe.com/")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return original(input, init);
    };
    try {
      expect(await userMayUseTools("normal-user-1234")).toBe("payment_required");
    } finally {
      globalThis.fetch = original;
    }
  });
});

function cookies(response: Response): Record<string, string> {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const out: Record<string, string> = {};
  for (const entry of list) {
    const [pair] = entry.split(";");
    const [key, ...rest] = pair.split("=");
    out[key] = decodeURIComponent(rest.join("="));
  }
  return out;
}

describe("reviewer sign-in over OAuth", () => {
  let server: Server;
  let base = "";
  const password = `pw-${crypto.randomBytes(12).toString("hex")}`;

  beforeAll(async () => {
    clearReviewerEnv();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    clearReviewerEnv();
    resetStoreForTests();
  });

  afterAll(async () => {
    clearReviewerEnv();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function beginAuthorize(): Promise<{
    clientId: string;
    verifier: string;
    challenge: string;
    csrf: string;
    jar: Record<string, string>;
    html: string;
  }> {
    const registered = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1/callback"],
        client_name: "Reviewer test",
        token_endpoint_auth_method: "none"
      })
    });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string };
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${base}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "review-state");
    authorize.searchParams.set("resource", `${base}/mcp`);
    const page = await fetch(authorize);
    expect(page.status).toBe(200);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    expect(csrf).toBeTruthy();
    return { clientId: client.client_id, verifier, challenge, csrf, jar: cookies(page), html };
  }

  function authorizeBody(flow: Awaited<ReturnType<typeof beginAuthorize>>, extra: Record<string, string>): URLSearchParams {
    return new URLSearchParams({
      response_type: "code",
      client_id: flow.clientId,
      redirect_uri: "http://127.0.0.1/callback",
      code_challenge: flow.challenge,
      code_challenge_method: "S256",
      state: "review-state",
      resource: `${base}/mcp`,
      scope: "papers",
      csrf: flow.csrf,
      ...extra
    });
  }

  async function exchange(flow: Awaited<ReturnType<typeof beginAuthorize>>, code: string): Promise<string> {
    const tokenResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1/callback",
        client_id: flow.clientId,
        code_verifier: flow.verifier
      })
    });
    expect(tokenResponse.status).toBe(200);
    const issued = await tokenResponse.json() as { access_token: string };
    return issued.access_token;
  }

  it("hides reviewer sign-in until the login env is set, and rejects a wrong password", async () => {
    const hidden = await beginAuthorize();
    expect(hidden.html).not.toContain("Reviewer sign-in");

    process.env.REVIEWER_LOGIN_EMAIL = EMAIL;
    process.env.REVIEWER_LOGIN_PASSWORD_HASH = hashReviewerPassword(password);
    const shown = await beginAuthorize();
    expect(shown.html).toContain("Reviewer sign-in");
    expect(shown.html).not.toContain(password);

    const rejected = await fetch(`${base}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `papers_csrf=${shown.jar.papers_csrf}`
      },
      body: authorizeBody(shown, {
        decision: "reviewer",
        reviewer_email: EMAIL,
        reviewer_password: "not-the-reviewer-password"
      })
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("location")).toBeNull();
    const rejection = await rejected.text();
    expect(rejection).toContain("Reviewer sign-in was rejected.");
    expect(rejection).not.toContain("not-the-reviewer-password");
  });

  it("signs the reviewer in through OAuth and bypasses billing while a normal account does not", async () => {
    process.env.REVIEWER_LOGIN_EMAIL = EMAIL;
    process.env.REVIEWER_LOGIN_PASSWORD_HASH = hashReviewerPassword(password);
    process.env.COMP_ACCOUNT_EMAILS = EMAIL;
    enableBilling();
    const stripeUrls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.stripe.com/")) {
        stripeUrls.push(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return original(input, init);
    };

    try {
      const reviewerFlow = await beginAuthorize();
      const approved = await fetch(`${base}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `papers_csrf=${reviewerFlow.jar.papers_csrf}`
        },
        body: authorizeBody(reviewerFlow, {
          decision: "reviewer",
          reviewer_email: EMAIL,
          reviewer_password: password
        })
      });
      expect(approved.status).toBe(302);
      const location = new URL(approved.headers.get("location") ?? "");
      const code = location.searchParams.get("code");
      expect(code).toBeTruthy();
      const reviewerToken = await exchange(reviewerFlow, code ?? "");
      const account = await fetch(`${base}/account`, { headers: { Cookie: cookies(approved).papers_account ? `papers_account=${cookies(approved).papers_account}` : "" } });
      const accountHtml = await account.text();
      expect(accountHtml).toContain("Complimentary access is active");
      expect(accountHtml).not.toContain("Start monthly trial");

      const reviewerCall = await original(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${reviewerToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_papers", arguments: { query: "crispr", source: "openalex", limit: 1 } }
        })
      });
      expect(reviewerCall.status).toBe(200);
      const reviewerJson = await reviewerCall.json() as { result?: { content?: { text: string }[]; isError?: boolean } };
      expect(JSON.stringify(reviewerJson)).not.toMatch(/trial or Pro/);
      const reviewerData = JSON.parse(reviewerJson.result?.content?.[0]?.text ?? "{}") as { papers?: { source_url?: string }[] };
      expect(reviewerJson.result?.isError).not.toBe(true);
      expect(reviewerData.papers?.length).toBeGreaterThan(0);
      expect(reviewerData.papers?.[0]?.source_url).toMatch(/^https?:\/\//);
      expect(stripeUrls).toEqual([]);

      const normalFlow = await beginAuthorize();
      const normalApproved = await fetch(`${base}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `papers_csrf=${normalFlow.jar.papers_csrf}`
        },
        body: authorizeBody(normalFlow, { decision: "approve" })
      });
      expect(normalApproved.status).toBe(302);
      const normalCode = new URL(normalApproved.headers.get("location") ?? "").searchParams.get("code");
      const normalToken = await exchange(normalFlow, normalCode ?? "");
      const normalCall = await original(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${normalToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_papers", arguments: { query: "crispr", source: "openalex", limit: 1 } }
        })
      });
      expect(normalCall.status).toBe(403);
      expect(await normalCall.json()).toMatchObject({ error: "A Papers trial or Pro subscription is required." });
      expect(stripeUrls.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
