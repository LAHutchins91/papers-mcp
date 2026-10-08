import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCitation } from "../src/citations.js";
import { getPaper, findRelatedPapers } from "../src/scholar.js";
import { app } from "../src/server.js";
import { getStore, resetStoreForTests } from "../src/store.js";

let server: Server;
let base = "";
let token = "";

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

type RpcJson = {
  result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: unknown;
};

async function rpc(body: unknown, auth = false): Promise<{ status: number; json: RpcJson }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (auth) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

function toolText(payload: { result?: { content?: { text: string }[] } }): unknown {
  const text = payload.result?.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

beforeAll(async () => {
  process.env.SCHOLARLY_CONTACT_EMAIL = "papers-tests@example.com";
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_MONTHLY;
  delete process.env.STRIPE_PRICE_YEARLY;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/callback"],
      client_name: "Papers test",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
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
  authorize.searchParams.set("state", "state-1");
  authorize.searchParams.set("resource", `${base}/mcp`);
  const page = await fetch(authorize);
  expect(page.status).toBe(200);
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();
  const jar = cookies(page);
  const approved = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `papers_csrf=${jar.papers_csrf}`
    },
    body: new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-1",
      resource: `${base}/mcp`,
      scope: "papers",
      csrf: csrf ?? "",
      decision: "approve"
    })
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("location") ?? "");
  expect(location.searchParams.get("state")).toBe("state-1");
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: "http://127.0.0.1/callback",
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${base}/mcp`
    })
  });
  expect(tokenResponse.status).toBe(200);
  const issued = await tokenResponse.json() as { access_token: string; token_type: string };
  expect(issued.token_type).toBe("Bearer");
  token = issued.access_token;

  const replay = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: "http://127.0.0.1/callback",
      client_id: client.client_id,
      code_verifier: verifier
    })
  });
  expect(replay.status).toBe(400);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("Papers over Streamable HTTP", () => {
  it("serves health, the logo, and a landing page without a price", async () => {
    const health = await fetch(`${base}/health`);
    const healthBody = await health.json() as { ok: boolean; name: string; service: string; billingConfigured: boolean };
    expect(healthBody).toMatchObject({ ok: true, service: "papers", name: "Papers by Ouroboros Apps", billingConfigured: false });
    expect(Object.keys(healthBody).sort()).toEqual(["billingConfigured", "contactEmailConfigured", "name", "ok", "service", "storageBackend", "stripeWebhookConfigured", "version"]);
    const logo = await fetch(`${base}/logo.jpg`);
    expect(logo.headers.get("content-type")).toMatch(/image\/jpeg/);
    const bytes = new Uint8Array(await logo.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/src/server.ts`)).status).toBe(404);
    const home = await fetch(`${base}/`);
    const html = await home.text();
    expect(html).toContain("Papers by Ouroboros Apps");
    expect(html).not.toContain("Papers by Ouroboros<");
    const listedName = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "papers-name-check", version: "0.0.0" }
        }
      })
    });
    const initialized = await listedName.json() as { result?: { serverInfo?: { name?: string; version?: string }; instructions?: string } };
    expect(initialized.result?.serverInfo).toEqual({ name: "Papers by Ouroboros Apps", version: "1.0.0" });
    expect(initialized.result?.instructions?.startsWith("Papers by Ouroboros Apps ")).toBe(true);
    expect(html).toContain("/logo.jpg");
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toMatch(/\bUSD\b/);
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const resource = await metadata.json() as { resource: string; resource_name?: string; authorization_servers: string[] };
    expect(resource.resource_name).toBe("Papers by Ouroboros Apps");
    expect(resource.resource).toBe(`${base}/mcp`);
    expect(resource.authorization_servers).toEqual([base]);
  });


  it("serves the OpenAI apps challenge from OPENAI_APPS_CHALLENGE", async () => {
    const previous = process.env.OPENAI_APPS_CHALLENGE;
    delete process.env.OPENAI_APPS_CHALLENGE;
    try {
      const missing = await fetch(`${base}/.well-known/openai-apps-challenge`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toMatch(/text\/plain/);
      expect(await missing.text()).toBe("Verification is not configured.");

      process.env.OPENAI_APPS_CHALLENGE = "challenge-token-value";
      const present = await fetch(`${base}/.well-known/openai-apps-challenge`);
      expect(present.status).toBe(200);
      expect(present.headers.get("content-type")).toMatch(/text\/plain/);
      expect(await present.text()).toBe("challenge-token-value");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_APPS_CHALLENGE;
      else process.env.OPENAI_APPS_CHALLENGE = previous;
    }
  });

  it("rejects a non-loopback http redirect and a tool call without a token", async () => {
    const rejected = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/callback"], client_name: "nope" })
    });
    expect(rejected.status).toBe(400);
    const missing = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_papers", arguments: { query: "crispr" } } });
    expect(missing.status).toBe(401);
  });

  it("lists tools and runs each one", async () => {
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.status).toBe(200);
    const names = (listed.json.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(names).toEqual(["search_papers", "get_paper", "find_related_papers", "format_citation"]);

    const search = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_papers", arguments: { query: "crispr gene editing", source: "openalex", limit: 2, open_access: true } }
    }, true);
    expect(search.status).toBe(200);
    const searchData = toolText(search.json) as { papers: { title: string; source_url: string; identifiers: { doi?: string; openalex?: string } }[]; source_note: string };
    expect(searchData.papers.length).toBeGreaterThan(0);
    expect(searchData.source_note).toMatch(/public API/);
    expect(searchData.papers[0].source_url).toMatch(/^https?:\/\//);
    expect(searchData.papers[0].identifiers.doi || searchData.papers[0].identifiers.openalex).toBeTruthy();

    const detail = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_paper", arguments: { identifier: "10.1038/nature14539" } }
    }, true);
    const detailData = toolText(detail.json) as { paper: { title: string; identifiers: { doi?: string }; source_url: string } };
    expect(detailData.paper.title.toLowerCase()).toContain("deep learning");
    expect(detailData.paper.identifiers.doi?.toLowerCase()).toBe("10.1038/nature14539");

    const related = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "find_related_papers", arguments: { identifier: "10.1038/nature14539", relation: "cited_by", limit: 2 } }
    }, true);
    const relatedData = toolText(related.json) as { papers: { source_url: string; identifiers: Record<string, string> }[]; relation: string };
    expect(relatedData.relation).toBe("cited_by");
    expect(relatedData.papers.length).toBeGreaterThan(0);
    expect(relatedData.papers.length).toBeLessThanOrEqual(2);
    expect(Object.keys(relatedData.papers[0].identifiers).length).toBeGreaterThan(0);

    const citation = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "format_citation", arguments: { identifier: "10.1038/nature14539", style: "apa" } }
    }, true);
    const citationData = toolText(citation.json) as { citation: string; style: string };
    expect(citationData.style).toBe("apa");
    expect(citationData.citation).toContain("10.1038/nature14539");
    expect(citationData.citation).toMatch(/LeCun/);

    const missing = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_paper", arguments: { identifier: "10.1234/this-doi-should-not-exist-papers-ouroboros" } }
    }, true);
    const missingData = toolText(missing.json) as { error: string };
    expect(missing.json.result?.isError).toBe(true);
    expect(missingData.error).toMatch(/No paper was returned|returned no record|HTTP/);
    expect(JSON.stringify(missingData)).not.toMatch(/Deep learning/);
  });

  it("formats every style from the live Nature paper and lists references", async () => {
    const paper = await getPaper("10.1038/nature14539");
    for (const style of ["apa", "mla", "chicago", "bibtex"] as const) {
      const citation = formatCitation(paper, style);
      expect(citation).toContain("10.1038/nature14539");
    }
    const references = await findRelatedPapers("10.1038/nature14539", "references", 2);
    expect(references.papers.length).toBeGreaterThan(0);
    expect(references.anchor.identifiers.doi?.toLowerCase()).toBe("10.1038/nature14539");
  });

  it("accepts a signed webhook and refuses checkout when Stripe is unset", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_http";
    const payload = JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_http",
          customer: "cus_http",
          status: "trialing",
          metadata: { papers_user_id: "user-http-1234" },
          current_period_end: Math.floor(Date.now() / 1000) + 3600,
          items: { data: [] }
        }
      }
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha256", "whsec_http").update(`${timestamp}.${payload}`).digest("hex");
    const response = await fetch(`${base}/billing/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload
    });
    expect(response.status).toBe(200);
    expect((await getStore().get("user-http-1234"))?.subscriptionStatus).toBe("trialing");
    const checkout = await fetch(`${base}/billing/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: "monthly" })
    });
    expect(checkout.status).toBe(503);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    resetStoreForTests();
  });
});
