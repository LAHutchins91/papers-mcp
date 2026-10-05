import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { accountIdFromRequest, bearerAccess, installOAuth } from "./auth.js";
import { handleStripeWebhook, installBilling, userMayUseTools } from "./billing.js";
import { contactEmail, isBillingConfigured, PRODUCT, publicBase, SERVICE, VERSION } from "./config.js";
import { MCP_CORS_HEADERS, mcpBrowserOriginAllowed } from "./mcp-clients.js";
import { installPages } from "./pages.js";
import { storageBackendName } from "./store.js";
import { createPapersServer } from "./tools.js";

export const app = express();
export default app;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store"
  });
  next();
});

const buckets = new Map<string, { count: number; end: number }>();
function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  for (const [name, value] of buckets) if (value.end <= now) buckets.delete(name);
  const current = buckets.get(key);
  if (current) {
    current.count += 1;
    return current.count <= limit;
  }
  if (buckets.size >= 10000) return false;
  buckets.set(key, { count: 1, end: now + windowMs });
  return true;
}

app.post("/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  void handleStripeWebhook(req, res);
});

app.use(express.json({ limit: "128kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

export function logoFile(): string {
  const candidates = [
    path.resolve(process.cwd(), "logo.jpg"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "logo.jpg"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "logo.jpg")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

app.get(["/logo.jpg", "/favicon.ico"], (_req, res) => {
  res.type("image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(logoFile());
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    name: PRODUCT,
    version: VERSION,
    billingConfigured: isBillingConfigured(),
    stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    storageBackend: storageBackendName(),
    contactEmailConfigured: Boolean(contactEmail())
  });
});

installPages(app);
installOAuth(app);
installBilling(app, accountIdFromRequest);

function guardMcpOrigin(req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (!mcpBrowserOriginAllowed(origin, publicBase(req))) {
    res.status(403).json({ error: "Origin is not allowed." });
    return false;
  }
  if (origin) res.set({ ...MCP_CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" });
  return true;
}

function unauthorized(req: Request, res: Response): void {
  const metadata = `${publicBase(req)}/.well-known/oauth-protected-resource/mcp`;
  res.set("WWW-Authenticate", `Bearer realm="Papers", resource_metadata="${metadata}"`);
  res.status(401).json({ error: "Sign in to Papers to use these tools." });
}

const publicMethods = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);

app.options("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  res.status(204).end();
});

app.get("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  const metadata = `${publicBase(req)}/.well-known/oauth-protected-resource/mcp`;
  res.set("WWW-Authenticate", `Bearer realm="Papers", resource_metadata="${metadata}"`);
  res.status(405).set("Allow", "POST, DELETE, OPTIONS").json({ error: "Use Streamable HTTP POST for Papers." });
});

app.delete("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  res.status(200).json({});
});

app.post("/mcp", async (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  if (!allow(`mcp:${req.ip}`, 300, 60_000)) {
    res.status(429).set("Retry-After", "60").json({ error: "Too many requests. Retry in one minute." });
    return;
  }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || typeof req.body.method !== "string") {
    res.status(400).json({ error: "Expected a single JSON-RPC request." });
    return;
  }
  if (!publicMethods.has(req.body.method)) {
    const access = bearerAccess(req);
    if (!access) return unauthorized(req, res);
    const gate = await userMayUseTools(access.sub);
    if (gate === "payment_required") {
      res.status(403).json({
        error: "A Papers trial or Pro subscription is required.",
        access_information: `${publicBase(req)}/account`
      });
      return;
    }
    if (gate === "unavailable") {
      res.status(503).json({ error: "Could not verify your subscription. Please retry." });
      return;
    }
  }
  const server = createPapersServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed");
    if (!res.headersSent) res.status(500).json({ error: "Unable to process the plugin request." });
  }
});

app.use((error: { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const status = error?.type === "entity.too.large" ? 413 : error?.status && error.status < 500 ? error.status : error?.type === "entity.parse.failed" ? 400 : 400;
  res.status(status).json({ error: status === 413 ? "Request is too large." : "Invalid request." });
});

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL && !process.env.VITEST && invokedDirectly) {
  const port = Number(process.env.PORT ?? 43127);
  app.listen(port, "0.0.0.0", () => {
    console.log(`${PRODUCT} listening on ${port}`);
  });
}
