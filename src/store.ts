import fs from "node:fs";
import path from "node:path";

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
}

class MemoryStore implements AccountStore {
  private readonly rows = new Map<string, SubscriptionRecord>();
  async get(userId: string): Promise<SubscriptionRecord | null> {
    return this.rows.get(userId) ?? null;
  }
  async save(record: SubscriptionRecord): Promise<void> {
    this.rows.set(record.userId, record);
  }
  clear(): void {
    this.rows.clear();
  }
}

class FileStore implements AccountStore {
  constructor(private readonly file: string) {}
  private read(): Record<string, SubscriptionRecord> {
    try {
      const text = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as Record<string, SubscriptionRecord>;
    } catch {
      return {};
    }
  }
  async get(userId: string): Promise<SubscriptionRecord | null> {
    return this.read()[userId] ?? null;
  }
  async save(record: SubscriptionRecord): Promise<void> {
    const all = this.read();
    all[record.userId] = record;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, this.file);
  }
}

const memory = new MemoryStore();
let singleton: AccountStore | null = null;

export function getStore(): AccountStore {
  if (singleton) return singleton;
  const backend = (process.env.STORAGE_BACKEND ?? "memory").trim().toLowerCase();
  if (backend === "file") {
    const file = process.env.STORAGE_PATH?.trim() || path.resolve(process.cwd(), "data", "accounts.json");
    singleton = new FileStore(file);
    return singleton;
  }
  if (backend !== "memory") {
    console.error(`Unknown STORAGE_BACKEND "${backend}", using memory`);
  }
  singleton = memory;
  return singleton;
}

export function storageBackendName(): string {
  return (process.env.STORAGE_BACKEND ?? "memory").trim().toLowerCase() === "file" ? "file" : "memory";
}

export function resetStoreForTests(): void {
  memory.clear();
  singleton = null;
}
