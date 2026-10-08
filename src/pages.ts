import type { Express, Request } from "express";
import { isBillingConfigured, PRODUCT, PUBLIC_BRAND, PUBLIC_SITE, publicBase, resourceUrl, supportEmail } from "./config.js";
import { escapeHtml, page } from "./html.js";
import { accountIdFromRequest } from "./auth.js";
import { billingStatusText } from "./billing.js";
import { isCompAccount } from "./reviewer.js";
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
        <p class="eyebrow">${escapeHtml(PUBLIC_BRAND)}</p>
        <h1>Answers with papers you can open.</h1>
        <p class="lede">${escapeHtml(PUBLIC_BRAND)} searches OpenAlex, Semantic Scholar, PubMed, Crossref, and arXiv, then gives your assistant the abstract, identifiers, and a citation. If those APIs did not return a paper, ${escapeHtml(PUBLIC_BRAND)} will not invent one.</p>
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
    </section>
    <section class="section">
      <h2>Support and privacy</h2>
      <p class="lede">${PUBLIC_BRAND} lives at <a href="${escapeHtml(PUBLIC_SITE)}">ouroborosapps.com</a>. Email <a href="mailto:${escapeHtml(supportEmail())}">${escapeHtml(supportEmail())}</a> for support, privacy, export, or deletion. Read the <a href="/privacy">privacy policy</a>, <a href="/terms">terms</a>, and <a href="/support">support</a> notes.</p>
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
      <h1>Bring ${escapeHtml(PUBLIC_BRAND)} into the assistant you already use.</h1>
      <p class="lede">Papers speaks Streamable HTTP and OAuth. It works with ChatGPT, Claude, Gemini, Grok, Cursor, and any other client that can register itself and use PKCE. Leave the client id blank so dynamic registration can run.</p>
      <section class="card"><h3>Cursor</h3><p>Add this to <code>~/.cursor/mcp.json</code> or a project <code>.cursor/mcp.json</code>.</p><pre>${escapeHtml(cursor)}</pre></section>
      <section class="card" style="margin-top:14px"><h3>Claude Code</h3><pre>claude mcp add --transport http papers ${escapeHtml(mcp)}</pre></section>
      <section class="card" style="margin-top:14px"><h3>ChatGPT, Claude, Gemini, and Grok</h3><p>Add <code>${escapeHtml(mcp)}</code> as a remote MCP server and choose OAuth when asked. Approve the consent screen. Tool calls need that sign-in. When billing is configured, they also need a trial or Pro subscription.</p></section>`;
    res.type("html").send(shell(req, PUBLIC_BRAND, body));
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
    const comped = Boolean(userId && isCompAccount(userId));
    const status = comped
      ? "Complimentary access is active. No trial and no card are required."
      : userId
        ? billingStatusText(record, configured)
        : "Connect an assistant first. That creates the Papers account this trial is attached to.";
    const actions = comped
      ? ""
      : configured && userId
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
    const body = `<p class="eyebrow">Trial</p><h1>Your ${escapeHtml(PUBLIC_BRAND)} account</h1>
      ${notice}
      <section class="card"><p>${escapeHtml(status)}</p>${userId ? `<p>Account reference ${escapeHtml(userId.slice(0, 8))}</p>` : ""}</section>
      ${actions}
      <p class="lede">${comped
        ? "Tool calls on this connection are already entitled."
        : "The 14-day trial starts at Stripe Checkout. Papers does not print an amount on this page."}</p>`;
    res.set("Cache-Control", "no-store").type("html").send(shell(req, PUBLIC_BRAND, body));
  });

  app.get("/privacy", (req, res) => {
    res.type("html").send(shell(req, "Privacy policy", privacyBody()));
  });

  app.get("/terms", (req, res) => {
    res.type("html").send(shell(req, "Terms of service", termsBody()));
  });

  app.get("/support", (req, res) => {
    res.type("html").send(shell(req, "Support", supportBody(resourceUrl(publicBase(req)))));
  });
}

function mailLink(): string {
  const email = supportEmail();
  return `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;
}

function privacyBody(): string {
  const site = `<a href="${escapeHtml(PUBLIC_SITE)}">ouroborosapps.com</a>`;
  return `<h1>Privacy policy</h1>
    <p>Effective October 8, 2026. ${escapeHtml(PUBLIC_BRAND)} (${site}) is operated by Ouroboros Apps. Privacy, export, and deletion requests go to ${mailLink()}.</p>
    <h2>Information we process</h2>
    <p>Connecting an assistant does not ask for your name or email. Papers creates a random account id. Tool calls send the arguments the assistant submitted, and only those arguments. Do not put passwords, payment card details, or unrelated personal information in a query.</p>
    <h3>Anonymous account id</h3>
    <p>A random id is stored in a signed HttpOnly cookie and in the OAuth access and refresh tokens. Papers uses it to tell one connection from another and to attach a trial or subscription. The cookie lasts 90 days. An access token lasts 1 hour. A refresh token lasts 30 days. Papers does not keep a separate copy of the token beyond the signature check.</p>
    <h3>OAuth client registration</h3>
    <p>The client name and redirect addresses are carried inside a signed client id so the connection can finish. That registration lasts 1 year. It is not a database row.</p>
    <h3>Authorization codes</h3>
    <p>Each authorization code is single-use. Papers stores the code id until it expires so the code cannot be replayed. The code lasts 5 minutes. The stored id is dropped on the next store write after it expires.</p>
    <h3>Connection form cookie</h3>
    <p>A CSRF cookie lasts 30 minutes and is cleared when you approve, cancel, or submit reviewer sign-in. It exists so the connection form cannot be posted from another site.</p>
    <h3>Queries, identifiers, and citation styles</h3>
    <p>A search, a DOI, PMID, arXiv id, or OpenAlex work id, and a citation style are sent to the scholarly source that answers the tool. Papers uses them to return the record that source actually sent. Papers does not keep a database of queries. There is no query history to export later.</p>
    <h3>Scholarly polite-use address</h3>
    <p>If the operator set a scholarly contact address, that address is sent to OpenAlex, Crossref, and PubMed in the User-Agent or mailto parameter, because those services ask for one. It is an operational header. It is not the public support address, and this page does not print it. Optional API keys for PubMed and Semantic Scholar stay on the server and are sent only to those services.</p>
    <h3>Subscription snapshot</h3>
    <p>When you start a trial, Papers stores the account id, Stripe customer id, subscription id, status, current period end, and plan interval (monthly or yearly). Stripe receives the account id as metadata and collects the payment method. Papers does not receive or store a full card number. The snapshot is how Papers decides whether a tool call is entitled.</p>
    <h3>Rate-limit counters</h3>
    <p>The request IP and a count are held in memory for the limit window, about one minute for tool calls and about ten minutes for sign-in and token requests, then discarded. They are there to slow abuse. They are not written to the account store.</p>
    <h3>Reviewer sign-in</h3>
    <p>When the operator has configured store-reviewer sign-in, the reviewer email and password hash are read from the server environment. They are not written to the account store and they are not in the source repository. A successful sign-in uses a stable account id derived from that email. Complimentary access has no end date. The environment values remain until the operator removes them.</p>
    <h3>Email you send us</h3>
    <p>A message you send to the public contact includes the reply address and whatever you write. Papers uses it to answer support, billing, privacy, export, and deletion requests.</p>
    <h2>Why and where</h2>
    <p>We use this information to run Papers, complete OAuth, enforce a trial or subscription, answer support, prevent abuse, and meet legal obligations. We do not sell it, and we do not use queries to train our own models. These pages do not include advertising trackers.</p>
    <h2>Third parties</h2>
    <p>OpenAlex, Semantic Scholar, PubMed (NCBI), Crossref, and arXiv receive the query or identifier needed to answer the tool. Stripe processes the subscription. Vercel hosts the service and, when blob storage is selected, holds the private account snapshot. The MCP client you connect, including ChatGPT, Claude, Gemini, Grok, Cursor, and any other host you authorize, receives the tool results it asked for and applies its own terms. Service providers may process information outside your country.</p>
    <h2>Control and retention</h2>
    <ul>
      <li>Anonymous account id: cookie 90 days, access token 1 hour, refresh token 30 days.</li>
      <li>OAuth client registration: 1 year.</li>
      <li>Authorization code ids: 5 minutes, then dropped on the next store write.</li>
      <li>Connection form cookie: 30 minutes.</li>
      <li>Queries, identifiers, and citation styles: not retained by Papers after the response is sent.</li>
      <li>Scholarly polite-use address and server API keys: kept in the operator’s environment until the operator removes them. Papers does not store a copy in the account snapshot.</li>
      <li>Subscription snapshot: kept until you ask us to delete it or a newer Stripe event replaces it. Stripe may keep billing records for accounting and dispute handling under Stripe’s own schedule.</li>
      <li>Rate-limit counters: about one to ten minutes, in memory only.</li>
      <li>Reviewer email and password hash: server environment only, until the operator removes them. The complimentary entitlement does not expire.</li>
      <li>Support email: kept while we resolve the request, and longer when security or a legal obligation requires it.</li>
    </ul>
    <p>Email ${mailLink()} to export, correct, or delete what we hold. Include the account reference from the trial page if you have one. An export is the subscription snapshot: account id, Stripe customer id, subscription id, status, period end, and plan interval. Papers has no query log to include. Deletion removes that snapshot from the store we operate. Backups held by a provider, Stripe’s records, logs at the scholarly sources, and the copy your AI host kept follow those providers’ retention. Disconnecting the assistant stops new tool calls. Canceling a subscription does not by itself delete the snapshot.</p>
    <h2>Children's privacy</h2>
    <p>Papers is not directed to children under 13, and we do not knowingly collect personal information from them. A connection creates a random account id and does not ask for a date of birth. If you believe a child has used Papers, email ${mailLink()} and we will delete the snapshot we can tie to that request.</p>
    <h2>Security and changes</h2>
    <p>Tokens are signed, and the account cookie is HttpOnly. No service can promise absolute security. We publish changes to this policy on this page with a new effective date. If local privacy law gives you additional rights, you may exercise them by emailing ${mailLink()}.</p>
    <h2>Contact</h2>
    <p>${escapeHtml(PUBLIC_BRAND)}<br>${site}<br>${mailLink()}</p>`;
}

function termsBody(): string {
  const site = `<a href="${escapeHtml(PUBLIC_SITE)}">ouroborosapps.com</a>`;
  return `<h1>Terms of service</h1>
    <p>Effective October 8, 2026. These terms govern ${escapeHtml(PUBLIC_BRAND)}, offered by Ouroboros Apps (${site}). Questions and requests go to ${mailLink()}.</p>
    <h2>The records</h2>
    <p>Papers returns records from public scholarly APIs and formats citations from that metadata. You are responsible for reading the paper and for how you cite it. A missing field means the API did not provide it. Submit only queries you have the right to send. Do not use the service unlawfully, attempt unauthorized access, or disrupt other users.</p>
    <h2>Accounts and paid access</h2>
    <p>Connecting an assistant creates an anonymous Papers account. There is no separate sign-up form for that account. When billing is configured, calling a tool requires a Stripe subscription in a trial or active state. A new subscription includes a 14-day trial. Billing interval, trial end, and payment terms are shown by Stripe before you confirm. This site does not print an amount. The trial may convert to a recurring subscription as disclosed at checkout. Manage cancellation in the billing portal. Cancellation does not delete the account snapshot. Email support about a billing mistake. Applicable consumer rights continue to apply.</p>
    <h2>Papers has limits</h2>
    <p>The assistant chooses when to call a tool. Papers returns only records those APIs returned and will not invent a paper, author, identifier, or abstract to fill a gap. It cannot promise that every host will call the tools, or that a source will answer. Review a citation before you publish it. Author particles can land in the wrong part of a formatted name because display names are split mechanically.</p>
    <h2>Service operation</h2>
    <p>We may change features or restrict access to address abuse, security issues, nonpayment, or legal obligations. We aim to provide reliable access but cannot guarantee uninterrupted operation or error-free assistant output. These terms do not remove rights or remedies that applicable law does not permit us to exclude.</p>
    <h2>Leaving</h2>
    <p>You can disconnect the assistant, cancel billing in the portal, and email ${mailLink()} to export or delete the account snapshot. Those are separate steps. The privacy policy describes what an export contains.</p>`;
}

function supportBody(mcp: string): string {
  return `<h1>Support</h1>
    <p>Email ${mailLink()} for product help, billing, privacy, export, or deletion. Include the account reference from the trial page if you have one. Do not send passwords, tokens, or payment card details.</p>
    <h2>Connect an assistant</h2>
    <p>Add <code>${escapeHtml(mcp)}</code> as a remote MCP server and choose OAuth when asked. Leave the client id blank so dynamic registration can run. Full steps are on <a href="/connect">Connect</a>.</p>
    <h2>A record you can try</h2>
    <p><code>search_papers</code> accepts a short query. <code>get_paper</code>, <code>find_related_papers</code>, and <code>format_citation</code> accept DOI 10.1038/nature14539. The tools return the live record from OpenAlex, Semantic Scholar, PubMed, Crossref, or arXiv. If a source is rate limiting, wait and retry. Papers will not fill the gap with a paper the API did not return.</p>
    <p>${escapeHtml(PUBLIC_BRAND)} · <a href="${escapeHtml(PUBLIC_SITE)}">ouroborosapps.com</a></p>`;
}
