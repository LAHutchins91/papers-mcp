import type { Request } from "express";

export const SERVICE = "papers";
/** Product name shown to MCP clients, /health, and visitors. */
export const PRODUCT = "Papers by Ouroboros Apps";
export const PUBLIC_BRAND = PRODUCT;
export const PUBLIC_SITE = "https://ouroborosapps.com";
export const PUBLIC_CONTACT_EMAIL = "ouroborosplugins@gmail.com";
export const VERSION = "1.0.0";
export const TRIAL_DAYS = 14;
export const SCOPE = "papers";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function contactEmail(): string | null {
  const email = process.env.SCHOLARLY_CONTACT_EMAIL?.trim() ?? "";
  return EMAIL.test(email) ? email : null;
}

/** Public support and privacy mailbox. Not the scholarly polite-use address. */
export function supportEmail(): string {
  return PUBLIC_CONTACT_EMAIL;
}

export function publicBase(req: Pick<Request, "header" | "protocol">): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.header("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
  const host = (req.header("x-forwarded-host") ?? req.header("host") ?? "127.0.0.1").split(",")[0].trim();
  return `${proto}://${host}`;
}

export function resourceUrl(base: string): string {
  return `${base.replace(/\/$/, "")}/mcp`;
}

export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY && process.env.STRIPE_PRICE_YEARLY);
}

export function userAgent(): string {
  const email = contactEmail();
  return email ? `PapersByOuroboros/${VERSION} (mailto:${email})` : `PapersByOuroboros/${VERSION}`;
}
