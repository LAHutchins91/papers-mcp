import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { isBillingConfigured, publicBase, TRIAL_DAYS } from "./config.js";
import { getStore, type SubscriptionRecord } from "./store.js";

function stripeSecret(): string {
  const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!secret) throw new Error("Stripe is not configured");
  return secret;
}

async function stripeRequest(path: string, method: "GET" | "POST", body?: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeSecret()}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body: body?.toString(),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Stripe ${response.status}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export function parseStripeEvent(raw: Buffer, signatureHeader: string): { type: string; data: { object: Record<string, unknown> } } {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) throw new Error("Webhook secret is not configured");
  const fields = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new Error("Malformed Stripe signature");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error("Expired Stripe signature");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw.toString("utf8")}`).digest("hex");
  const valid = signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });
  if (!valid) throw new Error("Invalid Stripe signature");
  return JSON.parse(raw.toString("utf8")) as { type: string; data: { object: Record<string, unknown> } };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function planForPrice(priceId: string | null): "monthly" | "yearly" | null {
  if (priceId && priceId === process.env.STRIPE_PRICE_YEARLY) return "yearly";
  if (priceId && priceId === process.env.STRIPE_PRICE_MONTHLY) return "monthly";
  return null;
}

function priceIdOf(object: Record<string, unknown>): string | null {
  const items = object.items;
  if (!items || typeof items !== "object") return null;
  const data = (items as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") return null;
  const price = (data[0] as { price?: unknown }).price;
  if (!price || typeof price !== "object") return null;
  return asString((price as { id?: unknown }).id);
}

export function recordFromSubscription(userId: string, object: Record<string, unknown>, customerId?: string | null): SubscriptionRecord {
  const periodEnd = typeof object.current_period_end === "number"
    ? new Date(object.current_period_end * 1000).toISOString()
    : null;
  return {
    userId,
    stripeCustomerId: customerId ?? asString(object.customer),
    subscriptionId: asString(object.id),
    subscriptionStatus: asString(object.status),
    currentPeriodEnd: periodEnd,
    plan: planForPrice(priceIdOf(object)),
    updatedAt: new Date().toISOString()
  };
}

function userIdOf(object: Record<string, unknown>): string | null {
  const metadata = object.metadata;
  if (metadata && typeof metadata === "object") {
    const fromMeta = asString((metadata as { papers_user_id?: unknown }).papers_user_id);
    if (fromMeta) return fromMeta;
  }
  return asString(object.client_reference_id);
}

export async function applyStripeEvent(event: { type: string; data: { object: Record<string, unknown> } }): Promise<void> {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    const userId = userIdOf(object);
    if (!userId) return;
    const customerId = asString(object.customer);
    const subscriptionId = asString(object.subscription);
    let record: SubscriptionRecord = {
      userId,
      stripeCustomerId: customerId,
      subscriptionId,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      plan: null,
      updatedAt: new Date().toISOString()
    };
    if (subscriptionId && process.env.STRIPE_SECRET_KEY) {
      try {
        const subscription = await stripeRequest(`subscriptions/${subscriptionId}`, "GET");
        record = recordFromSubscription(userId, subscription, customerId);
      } catch (error) {
        console.error("Stripe subscription lookup failed");
      }
    }
    await getStore().save(record);
    return;
  }
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const userId = userIdOf(object);
    if (!userId) return;
    await getStore().save(recordFromSubscription(userId, object));
  }
}

function subscriptionActive(record: SubscriptionRecord | null): boolean {
  if (!record?.subscriptionStatus || !["active", "trialing"].includes(record.subscriptionStatus)) return false;
  if (!record.currentPeriodEnd) return true;
  return Date.parse(record.currentPeriodEnd) > Date.now() - 60_000;
}

export async function lookupStripe(userId: string): Promise<SubscriptionRecord | null> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId)) return null;
  const stored = await getStore().get(userId);
  let customerId = stored?.stripeCustomerId ?? null;
  if (!customerId) {
    const query = `metadata['papers_user_id']:'${userId}'`;
    const found = await stripeRequest(`customers/search?query=${encodeURIComponent(query)}&limit=1`, "GET");
    const data = Array.isArray(found.data) ? found.data : [];
    const customer = data[0];
    customerId = customer && typeof customer === "object" ? asString((customer as { id?: unknown }).id) : null;
  }
  if (!customerId) return stored;
  const subs = await stripeRequest(`subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=5`, "GET");
  const rows = Array.isArray(subs.data) ? subs.data.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null) : [];
  const preferred = rows.find((row) => row.status === "active") ?? rows.find((row) => row.status === "trialing") ?? rows[0];
  if (!preferred) {
    return stored ? { ...stored, stripeCustomerId: customerId, updatedAt: new Date().toISOString() } : null;
  }
  return recordFromSubscription(userId, preferred, customerId);
}

export async function userMayUseTools(userId: string): Promise<"allowed" | "payment_required" | "unavailable"> {
  if (!isBillingConfigured()) return "allowed";
  try {
    const local = await getStore().get(userId);
    if (subscriptionActive(local)) return "allowed";
    const live = await lookupStripe(userId);
    if (live) await getStore().save(live);
    return subscriptionActive(live) ? "allowed" : "payment_required";
  } catch (error) {
    console.error("Subscription check failed");
    return "unavailable";
  }
}

export async function createCheckout(userId: string, plan: "monthly" | "yearly", base: string): Promise<string> {
  if (!isBillingConfigured()) throw new Error("Billing is not configured");
  const price = plan === "yearly" ? process.env.STRIPE_PRICE_YEARLY ?? "" : process.env.STRIPE_PRICE_MONTHLY ?? "";
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("automatic_tax[enabled]", "true");
  params.set("line_items[0][price]", price);
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", userId);
  params.set("metadata[papers_user_id]", userId);
  params.set("subscription_data[metadata][papers_user_id]", userId);
  params.set("subscription_data[trial_period_days]", String(TRIAL_DAYS));
  params.set("payment_method_collection", "always");
  params.set("success_url", `${base}/account?checkout=success`);
  params.set("cancel_url", `${base}/account?checkout=cancelled`);
  const existing = await getStore().get(userId);
  if (existing?.stripeCustomerId) {
    params.set("customer", existing.stripeCustomerId);
    params.set("customer_update[address]", "auto");
  }
  const session = await stripeRequest("checkout/sessions", "POST", params);
  const url = asString(session.url);
  if (!url) throw new Error("Checkout did not return a URL");
  return url;
}

export async function createPortal(userId: string, base: string): Promise<string> {
  const existing = await getStore().get(userId);
  const customer = existing?.stripeCustomerId ?? (await lookupStripe(userId))?.stripeCustomerId;
  if (!customer) throw new Error("No Stripe customer");
  const session = await stripeRequest("billing_portal/sessions", "POST", new URLSearchParams({
    customer,
    return_url: `${base}/account`
  }));
  const url = asString(session.url);
  if (!url) throw new Error("Billing portal did not return a URL");
  return url;
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  try {
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).send("Missing Stripe signature");
      return;
    }
    const event = parseStripeEvent(req.body, signature);
    await applyStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook request failed");
    res.status(400).send("Webhook could not be processed");
  }
}

export function installBilling(app: Express, accountId: (req: Request) => string | null): void {
  app.post("/billing/checkout", async (req, res) => {
    try {
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Sign in by connecting an assistant, then start a trial." });
      const plan = req.body?.plan === "yearly" || req.body?.plan === "annual" ? "yearly" : req.body?.plan === "monthly" ? "monthly" : null;
      if (!plan) return res.status(400).json({ error: "Choose a monthly or yearly trial." });
      const url = await createCheckout(userId, plan, publicBase(req));
      res.json({ url });
    } catch (error) {
      const message = error instanceof Error && error.message === "Billing is not configured"
        ? "Billing is not configured on this server."
        : "Unable to start checkout. Retry shortly.";
      res.status(503).json({ error: message });
    }
  });

  app.post("/billing/portal", async (req, res) => {
    try {
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Sign in by connecting an assistant first." });
      const url = await createPortal(userId, publicBase(req));
      res.json({ url });
    } catch (error) {
      res.status(400).json({ error: "Billing management is available after a trial starts." });
    }
  });
}

export function billingStatusText(record: SubscriptionRecord | null, configured: boolean): string {
  if (!configured) return "Billing is not configured on this server, so a trial cannot be started here.";
  if (record?.subscriptionStatus === "trialing") return "Trial in progress.";
  if (record?.subscriptionStatus === "active") return record.plan === "yearly" ? "Pro is active on the yearly plan." : "Pro is active on the monthly plan.";
  if (record?.subscriptionStatus) return `Subscription status: ${record.subscriptionStatus}.`;
  return "No trial yet. Start one below. Stripe Checkout is where the amount appears.";
}
