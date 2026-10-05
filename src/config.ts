import type { Request } from "express";

export const SERVICE = "papers";
export const PRODUCT = "Papers by Ouroboros";
export const VERSION = "1.0.0";
export const TRIAL_DAYS = 14;
export const SCOPE = "papers";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function contactEmail(): string | null {
  const email = process.env.SCHOLARLY_CONTACT_EMAIL?.trim() ?? "";
  return EMAIL.test(email) ? email : null;
}

export function supportEmail(): string | null {
  const email = process.env.SUPPORT_EMAIL?.trim() || process.env.SCHOLARLY_CONTACT_EMAIL?.trim() || "";
  return EMAIL.test(email) ? email : null;
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
