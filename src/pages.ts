import type { Express, Request } from "express";
import { isBillingConfigured, PRODUCT, publicBase, resourceUrl, supportEmail } from "./config.js";
import { escapeHtml, page } from "./html.js";
import { accountIdFromRequest } from "./auth.js";
import { billingStatusText } from "./billing.js";
import { getStore } from "./store.js";

function shell(req: Request, title: string, body: string): string {
  const base = publicBase(req);
  return page(title, body, `${base}/logo.jpg`);
}

export function installPages(app: Express): void {
  app.get("/", (req, res) => {
    const base = publicBase(req);
    const mcp = resourceUrl(base);
    const body = `<section class="hero">
      <div>
        <p class="eyebrow">Papers by Ouroboros</p>
        <h1>Answers with papers you can open.</h1>
        <p class="lede">Papers searches OpenAlex, Semantic Scholar, PubMed, Crossref, and arXiv, then gives your assistant the abstract, identifiers, and a citation. If those APIs did not return a paper, Papers will not invent one.</p>
        <div class="actions"><a class="btn primary" href="/connect">Connect an assistant</a><a class="btn secondary" href="/account">Start a 14-day trial</a></div>
      </div>
      <img class="logo" src="/logo.jpg" alt="Green ouroboros on black around a white paper and magnifying glass, with the word Papers">
    </section>
    <section class="section">
      <h2>Who it is for</h2>
      <p class="lede">Students checking a claim, researchers following a citation trail, writers who need a real source, and clinicians looking up a PMID.</p>
      <div class="grid four">
        <article class="card"><h3>Students</h3><p>Ask a question and keep the DOI with the sentence you quote.</p></article>
        <article class="card"><h3>Researchers</h3><p>See what cites a paper, and what that paper itself cites.</p></article>
        <article class="card"><h3>Writers</h3><p>Format APA, MLA, Chicago, or BibTeX from the record the API returned.</p></article>
        <article class="card"><h3>Clinicians</h3><p>Resolve a PMID or DOI to the abstract PubMed or OpenAlex actually has.</p></article>
      </div>
    </section>
    <section class="section">
      <h2>What the assistant can call</h2>
      <div class="grid">
        <article class="card"><h3><code>search_papers</code></h3><p>Question or keywords, with year, field, and open-access filters. Pick one source or search all five.</p></article>
        <article class="card"><h3><code>get_paper</code></h3><p>Details and abstract for a DOI, PMID, arXiv id, or OpenAlex work id.</p></article>
        <article class="card"><h3><code>find_related_papers</code></h3><p>Papers that cite a work, or the works that paper cites.</p></article>
        <article class="card"><h3><code>format_citation</code></h3><p>APA, MLA, Chicago author-date, or BibTeX built only from fetched metadata.</p></article>
      </div>
    </section>
    <section class="section" id="trial">
      <h2>14-day trial, then Pro</h2>
      <p class="lede">Connect an assistant, then start a monthly or yearly trial. Stripe Checkout is the only place the amount appears.</p>
      <div class="grid">
        <article class="card"><h3>Monthly</h3><p>A 14-day trial, then Pro billed each month through Stripe.</p><a class="btn secondary" href="/account">Start monthly trial</a></article>
        <article class="card"><h3>Yearly</h3><p>The same 14-day trial, then Pro on a yearly Stripe subscription.</p><a class="btn primary" href="/account">Start yearly trial</a></article>
      </div>
    </section>
    <section class="section">
      <h2>MCP address</h2>
      <pre>${escapeHtml(mcp)}</pre>
    </section>`;
    res.type("html").send(shell(req, PRODUCT, body));
  });

  app.get("/connect", (req, res) => {
    const mcp = resourceUrl(publicBase(req));
    const cursor = `{
  "mcpServers": {
    "papers": {
      "url": "${mcp}"
    }
  }
}`;
    const body = `<p class="eyebrow">Connect</p>
      <h1>Bring Papers into the assistant you already use.</h1>
      <p class="lede">Papers speaks Streamable HTTP and OAuth. It works with ChatGPT, Claude, Gemini, Grok, Cursor, and any other client that can register itself and use PKCE. Leave the client id blank so dynamic registration can run.</p>
      <section class="card"><h3>Cursor</h3><p>Add this to <code>~/.cursor/mcp.json</code> or a project <code>.cursor/mcp.json</code>.</p><pre>${escapeHtml(cursor)}</pre></section>
      <section class="card" style="margin-top:14px"><h3>Claude Code</h3><pre>claude mcp add --transport http papers ${escapeHtml(mcp)}</pre></section>
      <section class="card" style="margin-top:14px"><h3>ChatGPT, Claude, Gemini, and Grok</h3><p>Add <code>${escapeHtml(mcp)}</code> as a remote MCP server and choose OAuth when asked. Approve the consent screen. Tool calls need that sign-in. When billing is configured, they also need a trial or Pro subscription.</p></section>`;
    res.type("html").send(shell(req, "Connect Papers", body));
  });

  app.get("/account", async (req, res) => {
    const base = publicBase(req);
    const configured = isBillingConfigured();
    const userId = accountIdFromRequest(req);
    const checkout = String(req.query.checkout ?? "");
    const record = userId ? await getStore().get(userId) : null;
    const notice = checkout === "success"
      ? `<p class="notice">Checkout completed. Subscription status can take a moment to appear. Refresh this page.</p>`
      : checkout === "cancelled"
        ? `<p class="error">Checkout was cancelled. No subscription was started.</p>`
        : "";
    const status = userId
      ? billingStatusText(record, configured)
      : "Connect an assistant first. That creates the Papers account this trial is attached to.";
    const actions = configured && userId
      ? `<div class="actions">
          <button class="btn secondary" type="button" data-plan="monthly">Start monthly trial</button>
          <button class="btn primary" type="button" data-plan="yearly">Start yearly trial</button>
          <button class="btn secondary" type="button" id="portal">Manage billing</button>
        </div>
        <p id="billing-message" role="status"></p>
        <script>
          async function post(path, body) {
            const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
            const data = await response.json().catch(function(){ return {}; });
            if (!response.ok) throw new Error(data.error || "Request failed");
            return data;
          }
          document.querySelectorAll("[data-plan]").forEach(function(button){
            button.addEventListener("click", async function(){
              const message = document.getElementById("billing-message");
              button.disabled = true;
              try {
                const data = await post("/billing/checkout", { plan: button.getAttribute("data-plan") });
                location.href = data.url;
              } catch (error) {
                message.textContent = error.message;
                button.disabled = false;
              }
            });
          });
          document.getElementById("portal").addEventListener("click", async function(){
            const message = document.getElementById("billing-message");
            this.disabled = true;
            try {
              const data = await post("/billing/portal");
              location.href = data.url;
            } catch (error) {
              message.textContent = error.message;
              this.disabled = false;
            }
          });
        </script>`
      : configured
        ? `<p><a class="btn primary" href="/connect">Connect an assistant</a></p>`
        : "";
    const body = `<p class="eyebrow">Trial</p><h1>Your Papers account</h1>
      ${notice}
      <section class="card"><p>${escapeHtml(status)}</p>${userId ? `<p>Account reference ${escapeHtml(userId.slice(0, 8))}</p>` : ""}</section>
      ${actions}
      <p class="lede">The 14-day trial starts at Stripe Checkout. Papers does not print an amount on this page.</p>`;
    res.set("Cache-Control", "no-store").type("html").send(shell(req, "Papers trial", body));
  });

  app.get("/privacy", (req, res) => {
    const email = supportEmail();
    const body = `<h1>Privacy</h1>
      <p>Paper searches are sent to OpenAlex, Semantic Scholar, PubMed, Crossref, or arXiv so those services can answer them. Papers does not keep a database of your queries.</p>
      <p>Connecting an assistant creates a random account id stored in a signed cookie and in the OAuth tokens. When you start a trial, Stripe receives that id as metadata and handles payment details.</p>
      <p>The contact address configured for scholarly API polite-use headers is sent in the User-Agent or mailto parameter. ${email ? `Privacy questions can go to ${escapeHtml(email)}.` : "A support address has not been configured."}</p>`;
    res.type("html").send(shell(req, "Privacy", body));
  });

  app.get("/terms", (req, res) => {
    const body = `<h1>Terms</h1>
      <p>Papers returns records from public scholarly APIs and formats citations from that metadata. You are responsible for reading the paper and for how you cite it. A missing field means the API did not provide it.</p>
      <p>When billing is configured, tool calls require a Stripe subscription in a trial or active state. The trial lasts 14 days and is collected by Stripe Checkout. Cancel or change the subscription in the billing portal.</p>`;
    res.type("html").send(shell(req, "Terms", body));
  });

  app.get("/support", (req, res) => {
    const email = supportEmail();
    const body = `<h1>Support</h1>
      ${email
        ? `<p>Email <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a> and include the account reference from the trial page if you have one.</p>`
        : "<p>A support address has not been configured on this server.</p>"}
      <p>If a source is rate limiting, wait and retry. Papers will not fill the gap with a paper the API did not return.</p>`;
    res.type("html").send(shell(req, "Support", body));
  });
}
