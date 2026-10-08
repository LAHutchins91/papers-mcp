import { BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlobStaleReadError,
  getStore,
  resetStoreForTests,
  setBlobClientForTests,
  storageBackendName,
  type BlobReadResult,
  type BlobStoreClient,
  type SubscriptionRecord
} from "../src/store.js";

const future = Math.floor(Date.now() / 1000) + 600;

function account(userId: string, status = "trialing"): SubscriptionRecord {
  return {
    userId,
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: status,
    currentPeriodEnd: null,
    plan: null,
    updatedAt: `2026-03-01T00:00:00.000Z`
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

const BLOB_URL = "https://store.private.blob.vercel-storage.com/papers/accounts.json";

class FakeBlob implements BlobStoreClient {
  body: string | null = null;
  etag = "etag-1";
  throwIfMissing = false;
  failuresLeft = 0;
  stealNext = false;
  onFailure: (() => void) | null = null;
  served: ((pathname: string) => { body: string; etag: string }) | null = null;
  puts: { pathname: string; body: string; options: {
    access: "private";
    allowOverwrite: true;
    addRandomSuffix: false;
    contentType: "application/json";
    ifMatch?: string;
  } }[] = [];
  gets: { pathname: string; access: "private"; useCache: false }[] = [];

  async head(): Promise<{ etag: string; url: string } | null> {
    if (this.body === null) return null;
    return { etag: this.etag, url: BLOB_URL };
  }

  async get(pathname: string, options: { access: "private"; useCache: false }): Promise<BlobReadResult | null> {
    this.gets.push({ pathname, access: options.access, useCache: options.useCache });
    if (this.body === null) {
      if (this.throwIfMissing) throw new BlobNotFoundError();
      return null;
    }
    const view = this.served ? this.served(pathname) : { body: this.body, etag: this.etag };
    return { statusCode: 200, stream: streamOf(view.body), blob: { etag: view.etag } };
  }

  async put(pathname: string, body: string, options: {
    access: "private";
    allowOverwrite: true;
    addRandomSuffix: false;
    contentType: "application/json";
    ifMatch?: string;
  }): Promise<{ etag: string }> {
    this.puts.push({ pathname, body, options });
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      this.onFailure?.();
      throw new BlobPreconditionFailedError();
    }
    if (this.body !== null && options.ifMatch !== this.etag) throw new BlobPreconditionFailedError();
    this.body = body;
    this.etag = `etag-${this.puts.length + 1}`;
    if (this.stealNext) {
      this.stealNext = false;
      const parsed = JSON.parse(body) as { accounts: Record<string, SubscriptionRecord>; usedCodes: Record<string, number> };
      parsed.usedCodes = {};
      parsed.accounts.other = account("other", "active");
      delete parsed.accounts["user-a"];
      this.body = JSON.stringify(parsed);
      this.etag = "etag-stolen";
    }
    return { etag: this.etag };
  }

  document(): { accounts: Record<string, SubscriptionRecord>; usedCodes: Record<string, number> } {
    return JSON.parse(this.body ?? "{}") as { accounts: Record<string, SubscriptionRecord>; usedCodes: Record<string, number> };
  }
}

function useBlob(fake: FakeBlob, pathname?: string) {
  resetStoreForTests();
  process.env.STORAGE_BACKEND = "blob";
  if (pathname) process.env.STORAGE_BLOB_PATH = pathname;
  else delete process.env.STORAGE_BLOB_PATH;
  setBlobClientForTests(fake);
  return getStore();
}

describe("vercel blob store", () => {
  afterEach(() => {
    delete process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_BLOB_PATH;
    resetStoreForTests();
  });

  it("treats a missing blob as empty and writes with a private conditional put", async () => {
    const fake = new FakeBlob();
    const store = useBlob(fake);
    expect(storageBackendName()).toBe("blob");
    expect(await store.get("user-a")).toBeNull();
    await store.save(account("user-a"));
    expect((await store.get("user-a"))?.subscriptionStatus).toBe("trialing");
    expect(fake.gets[0]).toEqual({ pathname: "papers/accounts.json", access: "private", useCache: false });
    expect(fake.puts[0].pathname).toBe("papers/accounts.json");
    expect(fake.puts[0].options).toEqual({
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
      ifMatch: undefined
    });
    expect(fake.document().accounts["user-a"].subscriptionStatus).toBe("trialing");
  });

  it("treats BlobNotFoundError as an empty document", async () => {
    const fake = new FakeBlob();
    fake.throwIfMissing = true;
    const store = useBlob(fake, "custom/accounts.json");
    expect(await store.get("missing")).toBeNull();
    await store.save(account("user-b"));
    expect(fake.puts[0].pathname).toBe("custom/accounts.json");
    expect(fake.document().accounts["user-b"].userId).toBe("user-b");
  });

  it("rejects a replayed authorization code across store instances and prunes expired ids", async () => {
    const fake = new FakeBlob();
    fake.body = JSON.stringify({
      accounts: {},
      usedCodes: { expired: future - 10_000, live: future }
    });
    fake.etag = "etag-seed";
    const first = useBlob(fake);
    expect(await first.consumeAuthorizationCode("expired", future)).toBe(true);
    expect(await first.consumeAuthorizationCode("live", future)).toBe(false);
    setBlobClientForTests(fake);
    const second = getStore();
    expect(await second.consumeAuthorizationCode("expired", future)).toBe(false);
    const saved = fake.document();
    expect(saved.usedCodes.expired).toBe(future);
    expect(saved.usedCodes.live).toBe(future);
    expect(fake.puts.at(-1)?.options.ifMatch).toBe("etag-seed");
  });

  it("retries a precondition failure and keeps a code another writer just stored", async () => {
    const fake = new FakeBlob();
    fake.failuresLeft = 1;
    fake.onFailure = () => {
      fake.body = JSON.stringify({ accounts: {}, usedCodes: { "code-a": future } });
      fake.etag = "etag-raced";
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      logged.push(String(line));
    });
    try {
      const store = useBlob(fake);
      expect(await store.consumeAuthorizationCode("code-a", future)).toBe(false);
      expect(fake.puts).toHaveLength(1);
      expect(fake.document().usedCodes["code-a"]).toBe(future);
      const failure = logged.map((line) => JSON.parse(line) as { event?: string; attempt?: number; name?: string; message?: string })
        .find((entry) => entry.event === "storage_write_failed");
      expect(failure).toMatchObject({
        event: "storage_write_failed",
        attempt: 0,
        name: "BlobPreconditionFailedError",
        message: "Vercel Blob: Precondition failed: ETag mismatch."
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("retries when the first put loses the race and then records the code", async () => {
    const fake = new FakeBlob();
    fake.failuresLeft = 1;
    fake.onFailure = () => {
      fake.body = JSON.stringify({ accounts: { kept: account("kept") }, usedCodes: {} });
      fake.etag = "etag-raced";
    };
    const store = useBlob(fake);
    expect(await store.consumeAuthorizationCode("code-b", future)).toBe(true);
    expect(fake.puts).toHaveLength(2);
    expect(fake.puts[1].options.ifMatch).toBe("etag-raced");
    const saved = fake.document();
    expect(saved.usedCodes["code-b"]).toBe(future);
    expect(saved.accounts.kept.userId).toBe("kept");
  });

  it("merges a subscription back in when a concurrent write overwrites the blob", async () => {
    const fake = new FakeBlob();
    fake.stealNext = true;
    const store = useBlob(fake);
    await store.save(account("user-a"));
    const saved = fake.document();
    expect(saved.accounts["user-a"].subscriptionStatus).toBe("trialing");
    expect(saved.accounts.other.userId).toBe("other");
    expect(fake.puts[1].options.ifMatch).toBe("etag-stolen");
  });

  it("drops expired authorization codes when a subscription is saved", async () => {
    const fake = new FakeBlob();
    fake.body = JSON.stringify({
      accounts: {},
      usedCodes: { expired: future - 10_000, live: future }
    });
    fake.etag = "etag-seed";
    const store = useBlob(fake);
    await store.save(account("user-a", "active"));
    const saved = fake.document();
    expect(saved.usedCodes.expired).toBeUndefined();
    expect(saved.usedCodes.live).toBe(future);
    expect(saved.accounts["user-a"].subscriptionStatus).toBe("active");
    expect(fake.puts[0].options.ifMatch).toBe("etag-seed");
  });

  it("writes with the API etag when the GET ETag header is quoted", async () => {
    const fake = new FakeBlob();
    fake.body = JSON.stringify({ accounts: { other: account("other", "active") }, usedCodes: {} });
    fake.etag = "etag-seed";
    fake.served = () => ({ body: fake.body ?? "", etag: `W/"${fake.etag}"` });
    const store = useBlob(fake);
    await store.save(account("user-a"));
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0].options.ifMatch).toBe("etag-seed");
    const saved = fake.document();
    expect(saved.accounts.other.userId).toBe("other");
    expect(saved.accounts["user-a"].subscriptionStatus).toBe("trialing");
  });

  it("re-reads a versioned URL when the plain GET is a stale cached copy", async () => {
    const stale = { body: JSON.stringify({ accounts: {}, usedCodes: {} }), etag: "etag-old" };
    const fake = new FakeBlob();
    fake.body = JSON.stringify({ accounts: { other: account("other", "active") }, usedCodes: {} });
    fake.etag = "etag-new";
    fake.served = (pathname) => (pathname.includes("?v=") ? { body: fake.body ?? "", etag: fake.etag } : stale);
    const store = useBlob(fake);
    await store.save(account("user-a"));
    expect(fake.gets[1]?.pathname).toBe(`${BLOB_URL}?v=etag-new`);
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0].options.ifMatch).toBe("etag-new");
    const saved = fake.document();
    expect(saved.accounts.other.userId).toBe("other");
    expect(saved.accounts["user-a"].userId).toBe("user-a");
  });

  it("refuses to write when every read is stale", async () => {
    const fake = new FakeBlob();
    fake.body = "{}";
    fake.etag = "etag-new";
    fake.served = () => ({ body: "{}", etag: "etag-old" });
    const store = useBlob(fake);
    await expect(store.save(account("user-a"))).rejects.toBeInstanceOf(BlobStaleReadError);
    expect(fake.puts).toHaveLength(0);
  });

  it("creates a missing blob without ifMatch", async () => {
    const fake = new FakeBlob();
    fake.throwIfMissing = true;
    const store = useBlob(fake);
    await store.save(account("user-a"));
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0].options.ifMatch).toBeUndefined();
    expect(fake.puts[0].pathname).toBe("papers/accounts.json");
    expect(fake.document().accounts["user-a"].userId).toBe("user-a");
  });
});
