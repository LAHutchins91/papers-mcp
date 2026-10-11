import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStripeEvent, isPapersSubscription } from "../src/billing.js";
import { getStore, resetStoreForTests } from "../src/store.js";

const USER = "google-sub-1234567890";
const originalFetch = globalThis.fetch;
const papersItems = { data: [{ price: { id: "price_papers_month" } }] };
let fetched: string[] = [];

function stubStripe(subscription: Record<string, unknown>) {
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(subscription), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  delete process.env.STORAGE_BACKEND;
  resetStoreForTests();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PRICE_MONTHLY = "price_papers_month";
  process.env.STRIPE_PRICE_YEARLY = "price_papers_year";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_MONTHLY;
  delete process.env.STRIPE_PRICE_YEARLY;
  resetStoreForTests();
});

const checkout = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "checkout.session.completed",
  data: { object: { client_reference_id: USER, customer: "cus_1", subscription: "sub_1", metadata, ...extra } }
});

describe("shared Stripe account: Papers ignores other apps' events", () => {
  it("ignores a Rank-style checkout with the same user id in client_reference_id", async () => {
    stubStripe({ id: "sub_1", status: "active", customer: "cus_1", items: { data: [{ price: { id: "price_rank_month" } }] } });
    expect(await applyStripeEvent(checkout({ rank_user_id: USER }))).toBe("ignored");
    expect(await getStore().get(USER)).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("ignores a marked checkout whose subscription is not a Papers price", async () => {
    stubStripe({ id: "sub_1", status: "active", customer: "cus_1", items: { data: [{ price: { id: "price_other" } }] } });
    expect(await applyStripeEvent(checkout({ app: "papers", papers_user_id: USER }))).toBe("ignored");
    expect(await getStore().get(USER)).toBeNull();
  });

  it("needs papers_user_id; client_reference_id alone is not enough", async () => {
    stubStripe({ id: "sub_1", status: "active", customer: "cus_1", items: papersItems });
    expect(await applyStripeEvent(checkout({ app: "papers" }))).toBe("ignored");
    expect(await getStore().get(USER)).toBeNull();
  });

  it("applies its own checkout", async () => {
    stubStripe({ id: "sub_1", status: "trialing", customer: "cus_1", items: papersItems });
    expect(await applyStripeEvent(checkout({ app: "papers", papers_user_id: USER }))).toBe("applied");
    const saved = await getStore().get(USER);
    expect(saved?.subscriptionStatus).toBe("trialing");
    expect(saved?.plan).toBe("monthly");
  });

  it("ignores another app's subscription events and mixed prices, applies its own", async () => {
    await getStore().save({ userId: USER, stripeCustomerId: "cus_1", subscriptionId: "sub_1", subscriptionStatus: "active", currentPeriodEnd: null, plan: "monthly", updatedAt: new Date().toISOString() });
    const sub = (items: unknown, metadata: Record<string, unknown>) => ({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_x", customer: "cus_1", status: "canceled", items, metadata } }
    });
    expect(await applyStripeEvent(sub({ data: [{ price: { id: "price_rank_month" } }] }, { rank_user_id: USER, papers_user_id: USER }))).toBe("ignored");
    expect(await applyStripeEvent(sub({ data: [{ price: "price_papers_month" }, { price: "price_other" }] }, { papers_user_id: USER }))).toBe("ignored");
    expect(await applyStripeEvent(sub(undefined, { papers_user_id: USER }))).toBe("ignored");
    expect(await applyStripeEvent(sub(papersItems, { user_id: USER }))).toBe("ignored");
    expect((await getStore().get(USER))?.subscriptionStatus).toBe("active");
    expect(await applyStripeEvent(sub(papersItems, { papers_user_id: USER }))).toBe("applied");
    expect((await getStore().get(USER))?.subscriptionStatus).toBe("canceled");
  });

  it("treats nothing as Papers when prices are not configured", () => {
    delete process.env.STRIPE_PRICE_MONTHLY;
    delete process.env.STRIPE_PRICE_YEARLY;
    expect(isPapersSubscription({ items: papersItems })).toBe(false);
  });
});
