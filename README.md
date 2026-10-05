# Papers by Ouroboros

Papers is a remote MCP server for students, researchers, writers, and clinicians who want an assistant to search and cite real papers. It is a lighter, independent alternative to Consensus, SciSpace, and Elicit.

The assistant can search OpenAlex, Semantic Scholar, PubMed, Crossref, and arXiv, open a paper by DOI, PMID, or arXiv id, see what cites a paper or what that paper cites, and format APA, MLA, Chicago, or BibTeX. Every result includes a source link and an identifier that came back from one of those APIs. If an API returns nothing, Papers returns nothing. It does not fill gaps with invented citations.

- MCP endpoint: `https://<your-host>/mcp`
- Works with ChatGPT, Claude, Gemini, Grok, Cursor, and any client that speaks Streamable HTTP plus OAuth 2.1 (dynamic client registration and PKCE)

`server.json` is the MCP Registry manifest (`io.github.LAHutchins91/papers-mcp`). Its `remotes[0].url` is a placeholder (`https://papers-mcp.vercel.app/mcp`). Change it to the origin you actually deploy, and set `APP_BASE_URL` to that same origin.

## Connect

Leave the client id and secret empty so the client can register itself.

Cursor, in `~/.cursor/mcp.json` or a project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "papers": {
      "url": "https://<your-host>/mcp"
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http papers https://<your-host>/mcp
```

Other clients: add the same URL and choose OAuth. The consent screen names the assistant and the `papers` scope. Tool discovery (`initialize`, `tools/list`, `ping`) does not require a token. Calling a tool does.

## Tools

- `search_papers` — question or keywords, with optional year range, field, open-access flag, and source (`openalex`, `semantic_scholar`, `pubmed`, `crossref`, `arxiv`, or `all`)
- `get_paper` — one record and its abstract, by DOI, PMID, arXiv id, or OpenAlex work id
- `find_related_papers` — `cited_by` or `references` for that identifier
- `format_citation` — `apa`, `mla`, `chicago`, or `bibtex` from the fetched metadata

Titles are kept as the source wrote them. Author names are split from display names, so particles such as “van” can land in the wrong part and deserve a look before you publish the citation.

## Trial and billing

Start a 14-day trial from the account page after you connect an assistant. Stripe Checkout is the only place an amount is shown. Monthly and yearly plans use the price ids you configure. Papers does not create Stripe products.

When `STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY`, and `STRIPE_PRICE_YEARLY` are all set, tool calls require a Stripe subscription in `trialing` or `active` status. When they are not set, `GET /health` reports `billingConfigured: false` and an OAuth-signed caller can use the tools. Set the Stripe variables before you expose a deployment publicly.

## Storage

Paper search is stateless. The only persisted record is a subscription snapshot, behind one store:

| `STORAGE_BACKEND` | Behavior |
| --- | --- |
| `memory` (default) | Process-local map. Fine for tests and a single Node process. |
| `file` | One JSON object at `STORAGE_PATH` (default `data/accounts.json`), keyed by account id. For a single Docker host. |

Each value is `{ userId, stripeCustomerId, subscriptionId, subscriptionStatus, currentPeriodEnd, plan, updatedAt }`. There is no separate database schema. When billing is configured, Stripe is the source of truth: a cold process looks the customer up by `metadata.papers_user_id` if the snapshot is missing.

OAuth access tokens and client registrations are signed tokens, not rows. Authorization codes are remembered in process memory for five minutes so the same process can reject a replay. Two serverless instances can both accept one code during that window. Set `AUTH_SIGNING_SECRET` in production so tokens survive a restart.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_BASE_URL` | Production | Public origin, no trailing slash. OAuth issuer and MCP audience. |
| `AUTH_SIGNING_SECRET` | Production | HMAC secret for OAuth tokens and the account cookie. |
| `SCHOLARLY_CONTACT_EMAIL` | Production | Mailto address in User-Agent and polite-pool parameters for OpenAlex, Crossref, and PubMed. |
| `SUPPORT_EMAIL` | No | Shown on the support page. Falls back to the scholarly contact address. |
| `NCBI_API_KEY` | No | Higher PubMed rate limit. |
| `SEMANTIC_SCHOLAR_API_KEY` | No | Higher Semantic Scholar rate limit. Sent as `x-api-key`. |
| `STRIPE_SECRET_KEY` | To charge | Stripe secret key. |
| `STRIPE_PRICE_MONTHLY` | To charge | Existing monthly price id. |
| `STRIPE_PRICE_YEARLY` | To charge | Existing yearly price id. |
| `STRIPE_WEBHOOK_SECRET` | To charge | Webhook signature secret. Point Stripe at `POST /billing/webhook`. |
| `STORAGE_BACKEND` | No | `memory` or `file`. |
| `STORAGE_PATH` | No | JSON file used when the backend is `file`. |
| `PORT` | No | Defaults to `43127`. |

Do not commit secrets. Copy what you need into the host’s environment, not into the repo.

## Run locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43127](http://127.0.0.1:43127). Health is `GET /health`.

```bash
npm test
npm run typecheck
```

Tests call the public APIs that do not need keys. Stripe is not called. Semantic Scholar often answers `429` from shared IP space; the tool reports that rate limit and does not substitute a made-up paper.

## Deploy

Vercel: this repo includes `vercel.json` and `api/index.ts`. Set the environment variables above, set `APP_BASE_URL` to the deployment origin, and update `server.json` `remotes[0].url` to `https://<that-host>/mcp`.

Docker:

```bash
docker build -t papers-mcp .
docker run --rm -p 43127:43127 -e APP_BASE_URL=http://127.0.0.1:43127 -e AUTH_SIGNING_SECRET=replace-me -e SCHOLARLY_CONTACT_EMAIL=you@example.com papers-mcp
```

The container listens on `43127`.

## Rate limits

Requests are spaced per host: OpenAlex about 10/s, Crossref about 4/s, PubMed about 3/s without an NCBI key, Semantic Scholar about 1/s without a key, and arXiv at least 3 seconds between calls. A descriptive User-Agent is always sent. The contact email is included only when `SCHOLARLY_CONTACT_EMAIL` is set.

## License

MIT. Copyright Lawrence Hutchins. See [LICENSE](LICENSE).
