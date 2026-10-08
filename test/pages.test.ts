import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/server.js";

let server: Server;
let base = "";

beforeAll(async () => {
  process.env.SCHOLARLY_CONTACT_EMAIL = "lawrence.a.hutchins@gmail.com";
  process.env.SUPPORT_EMAIL = "lawrence.a.hutchins@gmail.com";
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.SCHOLARLY_CONTACT_EMAIL;
  delete process.env.SUPPORT_EMAIL;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("public contact pages", () => {
  it("uses the shared mailbox on the landing page, privacy, terms, and support", async () => {
    for (const path of ["/", "/privacy", "/terms", "/support"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("ouroborosplugins@gmail.com");
      expect(html).toContain("Papers by Ouroboros Apps");
      expect(html).not.toContain("lawrence.a.hutchins@gmail.com");
      expect(html).not.toMatch(/\$\s?\d/);
      expect(html).not.toMatch(/\bUSD\b/);
    }
    const privacy = await (await fetch(`${base}/privacy`)).text();
    expect(privacy).toContain("https://ouroborosapps.com");
    expect(privacy).toContain("Information we process");
    expect(privacy).toContain("Third parties");
    expect(privacy).toContain("OpenAlex");
    expect(privacy).toContain("Semantic Scholar");
    expect(privacy).toContain("PubMed");
    expect(privacy).toContain("Crossref");
    expect(privacy).toContain("arXiv");
    expect(privacy).toContain("Stripe");
    expect(privacy).toContain("Children's privacy");
    expect(privacy).toContain("90 days");
    expect(privacy).toContain("1 hour");
    expect(privacy).toContain("30 days");
    expect(privacy).toContain("5 minutes");
    expect(privacy).toContain("1 year");
    expect(privacy).not.toContain("Virginia");
    const terms = await (await fetch(`${base}/terms`)).text();
    expect(terms).toContain("does not print an amount");
    expect(terms).not.toContain("Virginia");
    const support = await (await fetch(`${base}/support`)).text();
    expect(support).toContain("10.1038/nature14539");
    expect(support).toContain(`${base}/mcp`);
  });
});