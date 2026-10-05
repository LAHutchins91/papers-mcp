import fs from "node:fs";
import path from "node:path";
import { BlobNotFoundError, BlobPreconditionFailedError, get as blobGet, put as blobPut } from "@vercel/blob";

/** Subscription snapshot. Stripe remains the source of truth when billing is configured. */
export interface SubscriptionRecord {
  userId: string;
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  plan: "monthly" | "yearly" | null;
  updatedAt: string;
}

export interface AccountStore {
  get(userId: string): Promise<SubscriptionRecord | null>;
  save(record: SubscriptionRecord): Promise<void>;
  /** Record a single-use authorization code. False when that id was already used. */
  consumeAuthorizationCode(jti: string, expUnixSeconds: number): Promise<boolean>;
}

interface StoreDocument {
  accounts: Record<string, SubscriptionRecord>;
  usedCodes: Record<string, number>;
}

export interface BlobReadResult {
  statusCode?: number;
  stream: ReadableStream<Uint8Array> | null;
  blob: { etag: string };
}

export interface BlobStoreClient {
  get(pathname: string, options: { access: "private"; useCache: false }): Promise<BlobReadResult | null>;
  put(pathname: string, body: string, options: {
    access: "private";
    allowOverwrite: true;
    addRandomSuffix: false;
    contentType: "application/json";
    ifMatch?: string;
  }): Promise<{ etag: string }>;
}

const WRITE_ATTEMPTS = 5;

function emptyDocument(): StoreDocument {
  return { accounts: {}, usedCodes: {} };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function pruneUsedCodes(used: Record<string, number>, now = nowSeconds()): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [jti, exp] of Object.entries(used)) {
    if (typeof exp === "number" && Number.isFinite(exp) && exp >= now) next[jti] = exp;
  }
  return next;
}

function normalizeCodes(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, exp] of Object.entries(value as Record<string, unknown>)) {
    if (typeof exp === "number" && Number.isFinite(exp)) out[key] = exp;
  }
  return out;
}

function parseDocument(value: unknown): StoreDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDocument();
  const obj = value as Record<string, unknown>;
  if ("accounts" in obj || "usedCodes" in obj) {
    const accounts: Record<string, SubscriptionRecord> = {};
    if (obj.accounts && typeof obj.accounts === "object" && !Array.isArray(obj.accounts)) {
      for (const [key, entry] of Object.entries(obj.accounts as Record<string, unknown>)) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) accounts[key] = entry as SubscriptionRecord;
      }
    }
    return { accounts, usedCodes: normalizeCodes(obj.usedCodes) };
  }
  const accounts: Record<string, SubscriptionRecord> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as SubscriptionRecord).userId === "string") {
      accounts[key] = entry as SubscriptionRecord;
    }
  }
  return { accounts, usedCodes: {} };
}

function sameRecord(left: SubscriptionRecord | undefined, right: SubscriptionRecord): boolean {
  if (!left) return false;
  return left.userId === right.userId
    && left.stripeCustomerId === right.stripeCustomerId
    && left.subscriptionId === right.subscriptionId
    && left.subscriptionStatus === right.subscriptionStatus
    && left.currentPeriodEnd === right.currentPeriodEnd
    && left.plan === right.plan
    && left.updatedAt === right.updatedAt;
}

function notFound(error: unknown): boolean {
  return error instanceof BlobNotFoundError || (error instanceof Error && error.name === "BlobNotFoundError");
}

function preconditionFailed(error: unknown): boolean {
  return error instanceof BlobPreconditionFailedError || (error instanceof Error && error.name === "BlobPreconditionFailedError");
}

class MemoryStore implements AccountStore {
  private readonly rows = new Map<string, SubscriptionRecord>();
  private readonly usedCodes = new Map<string, number>();

  private prune(): void {
    const now = nowSeconds();
    for (const [jti, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(jti);
  }

  async get(userId: string): Promise<SubscriptionRecord | null> {
    return this.rows.get(userId) ?? null;
  }

  async save(record: SubscriptionRecord): Promise<void> {
    this.rows.set(record.userId, record);
    this.prune();
  }

  async consumeAuthorizationCode(jti: string, expUnixSeconds: number): Promise<boolean> {
    if (!jti) return false;
    this.prune();
    if (this.usedCodes.has(jti)) return false;
    this.usedCodes.set(jti, expUnixSeconds);
    return true;
  }

  clear(): void {
    this.rows.clear();
    this.usedCodes.clear();
  }
}

class FileStore implements AccountStore {
  constructor(private readonly file: string) {}

  private read(): StoreDocument {
    try {
      return parseDocument(JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown);
    } catch {
      return emptyDocument();
    }
  }

  private write(doc: StoreDocument): void {
    const body: StoreDocument = { accounts: doc.accounts, usedCodes: pruneUsedCodes(doc.usedCodes) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, this.file);
  }

  async get(userId: string): Promise<SubscriptionRecord | null> {
    return this.read().accounts[userId] ?? null;
  }

  async save(record: SubscriptionRecord): Promise<void> {
    const doc = this.read();
    doc.accounts[record.userId] = record;
    this.write(doc);
  }

  async consumeAuthorizationCode(jti: string, expUnixSeconds: number): Promise<boolean> {
    if (!jti) return false;
    const doc = this.read();
    const usedCodes = pruneUsedCodes(doc.usedCodes);
    if (usedCodes[jti]) return false;
    usedCodes[jti] = expUnixSeconds;
    this.write({ accounts: doc.accounts, usedCodes });
    return true;
  }
}

const vercelBlobClient: BlobStoreClient = {
  get: (pathname, options) => blobGet(pathname, options),
  put: (pathname, body, options) => blobPut(pathname, body, options)
};

class BlobStore implements AccountStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly pathname: string, private readonly client: BlobStoreClient) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async load(): Promise<{ doc: StoreDocument; etag?: string }> {
    try {
      const result = await this.client.get(this.pathname, { access: "private", useCache: false });
      if (!result) return { doc: emptyDocument() };
      if (result.statusCode !== undefined && result.statusCode !== 200) {
        throw new Error("Blob store read did not return the account document.");
      }
      if (!result.stream) return { doc: emptyDocument(), etag: result.blob.etag || undefined };
      const text = await new Response(result.stream).text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Blob store document is not valid JSON.");
      }
      return { doc: parseDocument(parsed), etag: result.blob.etag || undefined };
    } catch (error) {
      if (notFound(error)) return { doc: emptyDocument() };
      throw error;
    }
  }

  private async mutate(apply: (doc: StoreDocument) => StoreDocument | null, confirm: (doc: StoreDocument) => boolean): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const loaded = await this.load();
      const current: StoreDocument = {
        accounts: loaded.doc.accounts,
        usedCodes: pruneUsedCodes(loaded.doc.usedCodes)
      };
      const next = apply(current);
      if (!next) return false;
      const body: StoreDocument = { accounts: next.accounts, usedCodes: pruneUsedCodes(next.usedCodes) };
      try {
        await this.client.put(this.pathname, JSON.stringify(body), {
          access: "private",
          allowOverwrite: true,
          addRandomSuffix: false,
          contentType: "application/json",
          ifMatch: loaded.etag
        });
      } catch (error) {
        if (!preconditionFailed(error)) throw error;
        lastError = error;
        continue;
      }
      const checked = await this.load();
      if (confirm(checked.doc)) return true;
      lastError = new Error("Blob store write was overwritten.");
    }
    throw lastError instanceof Error ? lastError : new Error("Could not update the blob store.");
  }

  get(userId: string): Promise<SubscriptionRecord | null> {
    return this.run(async () => (await this.load()).doc.accounts[userId] ?? null);
  }

  save(record: SubscriptionRecord): Promise<void> {
    return this.run(async () => {
      const saved = await this.mutate(
        (doc) => ({ accounts: { ...doc.accounts, [record.userId]: record }, usedCodes: doc.usedCodes }),
        (doc) => sameRecord(doc.accounts[record.userId], record)
      );
      if (!saved) throw new Error("Could not save the subscription snapshot.");
    });
  }

  consumeAuthorizationCode(jti: string, expUnixSeconds: number): Promise<boolean> {
    if (!jti) return Promise.resolve(false);
    return this.run(() => this.mutate(
      (doc) => doc.usedCodes[jti] ? null : { accounts: doc.accounts, usedCodes: { ...doc.usedCodes, [jti]: expUnixSeconds } },
      (doc) => doc.usedCodes[jti] === expUnixSeconds
    ));
  }
}

const memory = new MemoryStore();
let singleton: AccountStore | null = null;
let blobClientOverride: BlobStoreClient | null = null;

function backendName(): string {
  const backend = (process.env.STORAGE_BACKEND ?? "memory").trim().toLowerCase();
  return backend === "file" || backend === "blob" ? backend : "memory";
}

export function blobPath(): string {
  return process.env.STORAGE_BLOB_PATH?.trim() || "papers/accounts.json";
}

export function getStore(): AccountStore {
  if (singleton) return singleton;
  const backend = backendName();
  if (backend === "file") {
    const file = process.env.STORAGE_PATH?.trim() || path.resolve(process.cwd(), "data", "accounts.json");
    singleton = new FileStore(file);
    return singleton;
  }
  if (backend === "blob") {
    singleton = new BlobStore(blobPath(), blobClientOverride ?? vercelBlobClient);
    return singleton;
  }
  const requested = (process.env.STORAGE_BACKEND ?? "memory").trim().toLowerCase();
  if (requested !== "memory") console.error(`Unknown STORAGE_BACKEND "${requested}", using memory`);
  singleton = memory;
  return singleton;
}

export function storageBackendName(): string {
  return backendName();
}

export function setBlobClientForTests(client: BlobStoreClient | null): void {
  blobClientOverride = client;
  singleton = null;
}

export function resetStoreForTests(): void {
  memory.clear();
  singleton = null;
  blobClientOverride = null;
}
