import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCitation } from "../src/citations.js";
import { parseStripeEvent, recordFromSubscription } from "../src/billing.js";
import { parseIdentifier, publishable, textFromInvertedIndex, type Paper } from "../src/papers.js";
import { resetStoreForTests, getStore } from "../src/store.js";
import { signToken, verifyToken } from "../src/tokens.js";

const fixture: Paper = {
  title: "Deep learning",
  authors: [
    { name: "Yann LeCun" },
    { name: "Yoshua Bengio" },
    { name: "Geoffrey E. Hinton" }
  ],
  author_count: 3,
  year: 2015,
  venue: "Nature",
  abstract: null,
  volume: "521",
  issue: "7553",
  pages: "436-444",
  identifiers: { doi: "10.1038/nature14539" },
  source_url: "https://doi.org/10.1038/nature14539",
  pdf_url: null,
  open_access: false,
  cited_by_count: 1,
  source: "openalex"
};

describe("identifiers and citations", () => {
  it("parses DOI, PMID, arXiv, and OpenAlex ids", () => {
    expect(parseIdentifier("https://doi.org/10.1038/nature14539")).toEqual({ kind: "doi", value: "10.1038/nature14539" });
    expect(parseIdentifier("10.48550/arXiv.1706.03762")?.kind).toBe("doi");
    expect(parseIdentifier("pmid:26017442")).toEqual({ kind: "pmid", value: "26017442" });
    expect(parseIdentifier("https://pubmed.ncbi.nlm.nih.gov/26017442/")).toEqual({ kind: "pmid", value: "26017442" });
    expect(parseIdentifier("https://arxiv.org/abs/1706.03762v1")).toEqual({ kind: "arxiv", value: "1706.03762" });
    expect(parseIdentifier("https://openalex.org/W2919115771")).toEqual({ kind: "openalex", value: "W2919115771" });
    expect(parseIdentifier("not a paper")).toBeNull();
  });

  it("rebuilds an OpenAlex inverted abstract without adding words", () => {
    expect(textFromInvertedIndex({ Deep: [0], learning: [1], networks: [2] })).toBe("Deep learning networks");
    expect(textFromInvertedIndex(null)).toBeNull();
  });

  it("drops a record that has no identifier or source link", () => {
    expect(publishable({ ...fixture, identifiers: {}, source_url: "https://example.org/x" })).toBeNull();
    expect(publishable({ ...fixture, source_url: "notaurl", identifiers: { doi: "10.1038/nature14539" } })).toBeNull();
  });

  it("formats APA, MLA, Chicago, and BibTeX from supplied metadata", () => {
    const apa = formatCitation(fixture, "apa");
    expect(apa).toContain("LeCun, Y.");
    expect(apa).toContain("(2015)");
    expect(apa).toContain("https://doi.org/10.1038/nature14539");
    expect(formatCitation(fixture, "mla")).toContain("et al");
    expect(formatCitation(fixture, "chicago")).toContain("2015");
    const bib = formatCitation(fixture, "bibtex");
    expect(bib.startsWith("@article{")).toBe(true);
    expect(bib).toContain("doi = {10.1038/nature14539}");
    expect(formatCitation({ ...fixture, authors: [{ name: "LeCun Y" }], author_count: 1 }, "apa")).toContain("LeCun, Y.");
  });
});

describe("tokens and stripe events", () => {
  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_PATH;
    resetStoreForTests();
  });

  it("round-trips a signed access token and rejects tampering", () => {
    const token = signToken({ typ: "access", sub: "abc12345", aud: "http://localhost/mcp" }, 60);
    const payload = verifyToken<{ typ: string; exp: number; iat: number; sub: string }>(token, "access");
    expect(payload.sub).toBe("abc12345");
    expect(() => verifyToken(`${token}x`)).toThrow();
  });

  it("verifies a Stripe signature and stores the subscription snapshot", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const body = Buffer.from(JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test",
          customer: "cus_test",
          status: "trialing",
          metadata: { papers_user_id: "user-test-1234" },
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
          items: { data: [] }
        }
      }
    }));
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha256", "whsec_test").update(`${timestamp}.${body.toString("utf8")}`).digest("hex");
    const event = parseStripeEvent(body, `t=${timestamp},v1=${signature}`);
    expect(event.type).toBe("customer.subscription.updated");
    const record = recordFromSubscription("user-test-1234", event.data.object);
    expect(record.subscriptionStatus).toBe("trialing");
    expect(() => parseStripeEvent(body, `t=${timestamp},v1=${"0".repeat(signature.length)}`)).toThrow();
  });

  it("writes the file backend as one JSON object", async () => {
    const file = path.join(os.tmpdir(), `papers-accounts-${crypto.randomUUID()}.json`);
    process.env.STORAGE_BACKEND = "file";
    process.env.STORAGE_PATH = file;
    resetStoreForTests();
    await getStore().save({
      userId: "file-user-1",
      stripeCustomerId: null,
      subscriptionId: null,
      subscriptionStatus: "trialing",
      currentPeriodEnd: null,
      plan: null,
      updatedAt: new Date().toISOString()
    });
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { subscriptionStatus: string }>;
    expect(saved["file-user-1"].subscriptionStatus).toBe("trialing");
    fs.unlinkSync(file);
  });
});
