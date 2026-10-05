import { contactEmail, userAgent } from "./config.js";
import {
  capAuthors,
  doiUrl,
  forList,
  normalizeDoi,
  parseIdentifier,
  publishable,
  safeUrl,
  ScholarlyError,
  SOURCE_NOTE,
  textFromInvertedIndex,
  yearInRange,
  dedupeKey,
  type Paper,
  type PaperAuthor,
  type PaperSource
} from "./papers.js";

export interface SearchOptions {
  query: string;
  yearFrom?: number;
  yearTo?: number;
  field?: string;
  openAccess?: boolean;
  source?: PaperSource | "all";
  limit?: number;
}

export interface SearchResponse {
  papers: Paper[];
  warnings: string[];
  sources_consulted: PaperSource[];
  source_note: string;
  retrieved_at: string;
}

type Host = PaperSource;

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
const chains = new Map<Host, Promise<void>>();
const nextAt = new Map<Host, number>();
const cache = new Map<string, { exp: number; status: number; text: string }>();

const INTERVALS: Record<Host, number> = {
  openalex: 150,
  crossref: 250,
  pubmed: 350,
  arxiv: 3000,
  semantic_scholar: 1200
};

export function setScholarlyFetch(fn: typeof fetch | null): void {
  fetchImpl = fn ? fn.bind(globalThis) : globalThis.fetch.bind(globalThis);
  cache.clear();
}

export function resetScholarlyState(): void {
  cache.clear();
  nextAt.clear();
  chains.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intervalFor(host: Host): number {
  if (host === "pubmed" && process.env.NCBI_API_KEY) return 120;
  if (host === "semantic_scholar" && process.env.SEMANTIC_SCHOLAR_API_KEY) return 200;
  return INTERVALS[host];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function plainQuery(query: string): string {
  return query.replace(/[\[\]{}<>]/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 8;
  return Math.min(20, Math.max(1, limit));
}

function mailtoQuery(): string {
  const email = contactEmail();
  return email ? `&mailto=${encodeURIComponent(email)}` : "";
}

function ncbiQuery(): string {
  const email = contactEmail();
  const key = process.env.NCBI_API_KEY?.trim();
  const parts = ["tool=papers_ouroboros"];
  if (email) parts.push(`email=${encodeURIComponent(email)}`);
  if (key) parts.push(`api_key=${encodeURIComponent(key)}`);
  return parts.join("&");
}

async function schedule<T>(host: Host, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(host) ?? Promise.resolve();
  const run = previous.then(task, task);
  chains.set(host, run.then(() => undefined, () => undefined));
  return run;
}

async function scholarlyFetch(host: Host, url: string, accept: string): Promise<{ status: number; text: string }> {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return { status: hit.status, text: hit.text };
  return schedule(host, async () => {
    const cached = cache.get(url);
    if (cached && cached.exp > Date.now()) return { status: cached.status, text: cached.text };
    let last: { status: number; text: string; retryAfter: string | null } | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wait = (nextAt.get(host) ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      nextAt.set(host, Date.now() + intervalFor(host));
      const headers: Record<string, string> = { Accept: accept, "User-Agent": userAgent() };
      const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
      if (host === "semantic_scholar" && key) headers["x-api-key"] = key;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(host === "semantic_scholar" ? 12000 : 20000)
        });
      } catch {
        throw new ScholarlyError(`${label(host)} could not be reached.`, "upstream");
      }
      const text = await response.text();
      last = { status: response.status, text, retryAfter: response.headers.get("retry-after") };
      if (response.status !== 429 || attempt === 1) break;
      const retrySec = Number(last.retryAfter);
      const delay = Number.isFinite(retrySec) && retrySec > 0 ? Math.min(retrySec * 1000, 4000) : 1500;
      await sleep(delay);
    }
    if (!last) throw new ScholarlyError(`${label(host)} could not be reached.`, "upstream");
    if (last.status === 200 && cache.size > 150) cache.clear();
    if (last.status === 200) cache.set(url, { exp: Date.now() + 60_000, status: last.status, text: last.text });
    return { status: last.status, text: last.text };
  });
}

function label(host: Host): string {
  switch (host) {
    case "openalex": return "OpenAlex";
    case "semantic_scholar": return "Semantic Scholar";
    case "pubmed": return "PubMed";
    case "crossref": return "Crossref";
    case "arxiv": return "arXiv";
  }
}

function failStatus(host: Host, status: number): never {
  if (status === 404) throw new ScholarlyError(`${label(host)} returned no record.`, "not_found");
  if (status === 429) throw new ScholarlyError(`${label(host)} rate limit reached. Retry shortly.`, "rate_limit");
  throw new ScholarlyError(`${label(host)} returned HTTP ${status}.`, "upstream");
}

async function getJson(host: Host, url: string): Promise<unknown> {
  const response = await scholarlyFetch(host, url, "application/json");
  if (response.status !== 200) failStatus(host, response.status);
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new ScholarlyError(`${label(host)} returned an unreadable response.`, "upstream");
  }
}

async function getText(host: Host, url: string, accept: string): Promise<string> {
  const response = await scholarlyFetch(host, url, accept);
  if (response.status !== 200) failStatus(host, response.status);
  return response.text;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, "&");
}

function textContent(xml: string): string {
  return decodeXml(xml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function pageRange(first: string | null, last: string | null): string | null {
  if (first && last && first !== last) return `${first}-${last}`;
  return first || last;
}

function pmidFrom(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d{1,9})/);
  return match ? match[1] : null;
}

function fieldToken(field: string | undefined): string | null {
  if (!field) return null;
  const clean = field.replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 80) : null;
}

const S2_FIELDS = new Map([
  ["computer science", "Computer Science"],
  ["medicine", "Medicine"],
  ["chemistry", "Chemistry"],
  ["biology", "Biology"],
  ["materials science", "Materials Science"],
  ["physics", "Physics"],
  ["geology", "Geology"],
  ["psychology", "Psychology"],
  ["art", "Art"],
  ["history", "History"],
  ["geography", "Geography"],
  ["sociology", "Sociology"],
  ["business", "Business"],
  ["political science", "Political Science"],
  ["economics", "Economics"],
  ["philosophy", "Philosophy"],
  ["mathematics", "Mathematics"],
  ["engineering", "Engineering"],
  ["environmental science", "Environmental Science"],
  ["agricultural and food sciences", "Agricultural and Food Sciences"],
  ["education", "Education"],
  ["law", "Law"],
  ["linguistics", "Linguistics"]
]);

function mapOpenAlex(raw: unknown): Paper | null {
  if (!isRecord(raw)) return null;
  const title = str(raw.display_name);
  if (!title) return null;
  const authors: PaperAuthor[] = [];
  for (const row of Array.isArray(raw.authorships) ? raw.authorships : []) {
    if (!isRecord(row)) continue;
    const author = isRecord(row.author) ? row.author : {};
    const name = str(author.display_name) ?? str(row.raw_author_name);
    if (name) authors.push({ name });
  }
  const capped = capAuthors(authors);
  const ids = isRecord(raw.ids) ? raw.ids : {};
  const doi = normalizeDoi(str(raw.doi) ?? str(ids.doi) ?? "");
  const openalex = str(raw.id);
  const location = isRecord(raw.primary_location) ? raw.primary_location : {};
  const source = isRecord(location.source) ? location.source : {};
  const access = isRecord(raw.open_access) ? raw.open_access : {};
  const best = isRecord(raw.best_oa_location) ? raw.best_oa_location : {};
  const biblio = isRecord(raw.biblio) ? raw.biblio : {};
  const sourceUrl = safeUrl(location.landing_page_url) ?? (doi ? doiUrl(doi) : safeUrl(openalex));
  if (!sourceUrl) return null;
  return publishable({
    title,
    authors: capped.authors,
    author_count: capped.author_count,
    year: int(raw.publication_year),
    venue: str(source.display_name),
    abstract: textFromInvertedIndex(raw.abstract_inverted_index),
    volume: str(biblio.volume),
    issue: str(biblio.issue),
    pages: pageRange(str(biblio.first_page), str(biblio.last_page)),
    identifiers: {
      doi: doi ?? undefined,
      pmid: pmidFrom(str(ids.pmid)) ?? undefined,
      openalex: openalex ?? undefined
    },
    source_url: sourceUrl,
    pdf_url: safeUrl(best.pdf_url) ?? safeUrl(location.pdf_url) ?? safeUrl(access.oa_url),
    open_access: typeof access.is_oa === "boolean" ? access.is_oa : null,
    cited_by_count: int(raw.cited_by_count),
    source: "openalex"
  });
}

const OPENALEX_SELECT = "id,doi,display_name,publication_year,authorships,primary_location,best_oa_location,open_access,abstract_inverted_index,cited_by_count,ids,biblio,type";

function openalexUrl(path: string, query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  const encoded = params.toString().replace(/%2C/g, ",").replace(/%7C/g, "|");
  return `https://api.openalex.org/${path}?${encoded}${mailtoQuery()}`;
}

async function openalexWorks(query: Record<string, string>): Promise<Paper[]> {
  const body = await getJson("openalex", openalexUrl("works", { ...query, select: OPENALEX_SELECT }));
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  return body.results.map(mapOpenAlex).filter((paper): paper is Paper => Boolean(paper));
}

async function openalexByPath(path: string): Promise<{ paper: Paper; referenced: string[] } | null> {
  let body: unknown;
  try {
    body = await getJson("openalex", `https://api.openalex.org/works/${path}?select=${OPENALEX_SELECT},referenced_works${mailtoQuery()}`);
  } catch (error) {
    if (error instanceof ScholarlyError && error.code === "not_found") return null;
    throw error;
  }
  const paper = mapOpenAlex(body);
  if (!paper || !isRecord(body)) return null;
  const referenced = Array.isArray(body.referenced_works)
    ? body.referenced_works.filter((item): item is string => typeof item === "string")
    : [];
  return { paper, referenced };
}

async function searchOpenAlex(options: SearchOptions, limit: number): Promise<Paper[]> {
  const filters: string[] = [];
  const field = fieldToken(options.field);
  if (options.yearFrom && options.yearTo) filters.push(`publication_year:${options.yearFrom}-${options.yearTo}`);
  else if (options.yearFrom) filters.push(`publication_year:>${options.yearFrom - 1}`);
  else if (options.yearTo) filters.push(`publication_year:<${options.yearTo + 1}`);
  if (options.openAccess === true) filters.push("is_oa:true");
  if (options.openAccess === false) filters.push("is_oa:false");
  if (field) filters.push(`topics.field.display_name.search:${field.replace(/,/g, " ")}`);
  const query: Record<string, string> = {
    search: plainQuery(options.query),
    "per-page": String(limit)
  };
  if (filters.length) query.filter = filters.join(",");
  return openalexWorks(query);
}

function mapCrossref(item: unknown): Paper | null {
  if (!isRecord(item)) return null;
  const title = Array.isArray(item.title) ? str(item.title[0]) : str(item.title);
  const doi = normalizeDoi(str(item.DOI) ?? "");
  if (!title || !doi) return null;
  const authors: PaperAuthor[] = [];
  for (const row of Array.isArray(item.author) ? item.author : []) {
    if (!isRecord(row)) continue;
    const family = str(row.family);
    const given = str(row.given);
    const literal = str(row.name);
    const name = given && family ? `${given} ${family}` : family ?? literal;
    if (name) authors.push({ name, family: family ?? undefined, given: given ?? undefined });
  }
  const capped = capAuthors(authors);
  const issued = isRecord(item.issued) ? item.issued : {};
  const dateParts = Array.isArray(issued["date-parts"]) ? issued["date-parts"] as unknown[] : [];
  const yearRow = Array.isArray(dateParts[0]) ? dateParts[0] as unknown[] : [];
  const year = typeof yearRow[0] === "number" ? yearRow[0] : null;
  const venue = Array.isArray(item["container-title"]) ? str(item["container-title"][0]) : null;
  const licenses = Array.isArray(item.license) ? item.license : [];
  const licenseUrls = licenses.filter(isRecord).map((license) => str(license.URL)).filter((url): url is string => Boolean(url));
  const openAccess = licenseUrls.some((url) => /creativecommons\.org/i.test(url)) ? true : null;
  const links = Array.isArray(item.link) ? item.link : [];
  const pdf = links.filter(isRecord).map((link) => safeUrl(link.URL)).find((url) => url && /pdf/i.test(url)) ?? null;
  const abstract = str(item.abstract) ? textContent(str(item.abstract) as string) : null;
  return publishable({
    title,
    authors: capped.authors,
    author_count: capped.author_count,
    year,
    venue,
    abstract,
    volume: str(item.volume),
    issue: str(item.issue),
    pages: str(item.page),
    identifiers: { doi },
    source_url: safeUrl(item.URL) ?? doiUrl(doi),
    pdf_url: pdf,
    open_access: openAccess,
    cited_by_count: int(item["is-referenced-by-count"]),
    source: "crossref"
  });
}

async function searchCrossref(options: SearchOptions, limit: number): Promise<Paper[]> {
  const filters: string[] = [];
  if (options.yearFrom) filters.push(`from-pub-date:${options.yearFrom}-01-01`);
  if (options.yearTo) filters.push(`until-pub-date:${options.yearTo}-12-31`);
  const field = fieldToken(options.field);
  const query = [plainQuery(options.query), field ?? ""].filter(Boolean).join(" ");
  const fetchLimit = options.openAccess === true ? Math.min(20, limit * 3) : limit;
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${fetchLimit}${filters.length ? `&filter=${filters.join(",")}` : ""}${mailtoQuery()}`;
  const body = await getJson("crossref", url);
  const message = isRecord(body) ? body.message : null;
  const items = isRecord(message) && Array.isArray(message.items) ? message.items : [];
  let papers = items.map(mapCrossref).filter((paper): paper is Paper => Boolean(paper));
  if (options.openAccess === true) papers = papers.filter((paper) => paper.open_access === true);
  if (options.openAccess === false) papers = papers.filter((paper) => paper.open_access === false);
  return papers.slice(0, limit);
}

async function crossrefByDoi(doi: string): Promise<Paper | null> {
  try {
    const body = await getJson("crossref", `https://api.crossref.org/works/${encodeURIComponent(doi)}${mailtoQuery() ? `?${mailtoQuery().slice(1)}` : ""}`);
    const message = isRecord(body) ? body.message : null;
    return mapCrossref(message);
  } catch (error) {
    if (error instanceof ScholarlyError && error.code === "not_found") return null;
    throw error;
  }
}

function mapSemantic(raw: unknown): Paper | null {
  if (!isRecord(raw)) return null;
  const title = str(raw.title);
  const paperId = str(raw.paperId);
  if (!title || !paperId) return null;
  const authors: PaperAuthor[] = [];
  for (const row of Array.isArray(raw.authors) ? raw.authors : []) {
    if (isRecord(row) && str(row.name)) authors.push({ name: str(row.name) as string });
  }
  const capped = capAuthors(authors);
  const external = isRecord(raw.externalIds) ? raw.externalIds : {};
  const doi = normalizeDoi(str(external.DOI) ?? "");
  const pmid = pmidFrom(str(external.PubMed));
  const arxiv = str(external.ArXiv)?.replace(/^arxiv:/i, "").replace(/v\d+$/i, "") ?? null;
  const journal = isRecord(raw.journal) ? raw.journal : {};
  const pdf = isRecord(raw.openAccessPdf) ? safeUrl(raw.openAccessPdf.url) : null;
  const sourceUrl = safeUrl(raw.url) ?? (doi ? doiUrl(doi) : `https://www.semanticscholar.org/paper/${paperId}`);
  return publishable({
    title,
    authors: capped.authors,
    author_count: capped.author_count,
    year: int(raw.year),
    venue: str(journal.name) ?? str(raw.venue),
    abstract: str(raw.abstract),
    volume: str(journal.volume),
    issue: null,
    pages: str(journal.pages),
    identifiers: {
      doi: doi ?? undefined,
      pmid: pmid ?? undefined,
      arxiv: arxiv ?? undefined,
      semantic_scholar: paperId
    },
    source_url: sourceUrl,
    pdf_url: pdf,
    open_access: typeof raw.isOpenAccess === "boolean" ? raw.isOpenAccess : pdf ? true : null,
    cited_by_count: int(raw.citationCount),
    source: "semantic_scholar"
  });
}

const S2_PAPER_FIELDS = "title,abstract,year,authors,externalIds,url,openAccessPdf,citationCount,venue,journal,isOpenAccess";

async function searchSemantic(options: SearchOptions, limit: number): Promise<Paper[]> {
  const field = fieldToken(options.field);
  const known = field ? S2_FIELDS.get(field.toLowerCase()) : undefined;
  const query = known ? plainQuery(options.query) : [plainQuery(options.query), field ?? ""].filter(Boolean).join(" ");
  const params = new URLSearchParams({
    query,
    limit: String(options.openAccess == null ? limit : Math.min(20, limit * 3)),
    fields: S2_PAPER_FIELDS
  });
  if (options.yearFrom || options.yearTo) {
    params.set("year", `${options.yearFrom ?? ""}-${options.yearTo ?? ""}`);
  }
  if (known) params.set("fieldsOfStudy", known);
  const body = await getJson("semantic_scholar", `https://api.semanticscholar.org/graph/v1/paper/search?${params}`);
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  let papers = rows.map(mapSemantic).filter((paper): paper is Paper => Boolean(paper));
  if (options.openAccess === true) papers = papers.filter((paper) => paper.open_access === true);
  if (options.openAccess === false) papers = papers.filter((paper) => paper.open_access === false);
  return papers.slice(0, limit);
}

async function semanticById(id: string): Promise<Paper | null> {
  try {
    const body = await getJson("semantic_scholar", `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_PAPER_FIELDS}`);
    return mapSemantic(body);
  } catch (error) {
    if (error instanceof ScholarlyError && error.code === "not_found") return null;
    throw error;
  }
}

async function semanticRelated(id: string, relation: "cited_by" | "references", limit: number): Promise<Paper[]> {
  const edge = relation === "cited_by" ? "citations" : "references";
  const key = relation === "cited_by" ? "citingPaper" : "citedPaper";
  const body = await getJson("semantic_scholar", `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}/${edge}?limit=${limit}&fields=${S2_PAPER_FIELDS}`);
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return rows.map((row) => isRecord(row) ? mapSemantic(row[key]) : null).filter((paper): paper is Paper => Boolean(paper));
}

function pubmedTerm(options: SearchOptions): string {
  const parts = [plainQuery(options.query)];
  const field = fieldToken(options.field);
  if (field) parts.push(field);
  let term = parts.join(" ");
  if (options.yearFrom || options.yearTo) term += ` AND ${options.yearFrom ?? 1800}:${options.yearTo ?? 2100}[dp]`;
  if (options.openAccess === true) term += " AND free full text[filter]";
  if (options.openAccess === false) term += " AND NOT free full text[filter]";
  return term;
}

function mapSummary(uid: string, raw: unknown, openAccess: boolean | null): Paper | null {
  if (!isRecord(raw)) return null;
  const title = str(raw.title)?.replace(/\.$/, "");
  if (!title) return null;
  const authors: PaperAuthor[] = [];
  for (const row of Array.isArray(raw.authors) ? raw.authors : []) {
    if (isRecord(row) && str(row.name)) authors.push({ name: str(row.name) as string });
  }
  const capped = capAuthors(authors);
  const articleIds = Array.isArray(raw.articleids) ? raw.articleids : [];
  let doi: string | null = null;
  for (const row of articleIds) {
    if (isRecord(row) && row.idtype === "doi") doi = normalizeDoi(str(row.value) ?? "");
  }
  if (!doi && str(raw.elocationid)) doi = normalizeDoi(str(raw.elocationid) as string);
  const pubdate = str(raw.pubdate) ?? str(raw.sortpubdate) ?? "";
  const yearMatch = pubdate.match(/(\d{4})/);
  return publishable({
    title,
    authors: capped.authors,
    author_count: capped.author_count,
    year: yearMatch ? Number(yearMatch[1]) : null,
    venue: str(raw.fulljournalname) ?? str(raw.source),
    abstract: null,
    volume: str(raw.volume),
    issue: str(raw.issue),
    pages: str(raw.pages),
    identifiers: { doi: doi ?? undefined, pmid: uid },
    source_url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    pdf_url: null,
    open_access: openAccess,
    cited_by_count: int(raw.pmcrefcount),
    source: "pubmed"
  });
}

async function pubmedSummaries(ids: string[], openAccess: boolean | null): Promise<Paper[]> {
  if (!ids.length) return [];
  const body = await getJson("pubmed", `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}&${ncbiQuery()}`);
  const result = isRecord(body) ? body.result : null;
  if (!isRecord(result)) return [];
  const uids = Array.isArray(result.uids) ? result.uids.map(String) : ids;
  return uids.map((uid) => mapSummary(uid, result[uid], openAccess)).filter((paper): paper is Paper => Boolean(paper));
}

function mapPubmedXml(article: string): Paper | null {
  const pmid = textContent(article.match(/<PMID[^>]*>([\s\S]*?)<\/PMID>/)?.[1] ?? "");
  const title = textContent(article.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? "");
  if (!pmid || !title) return null;
  const abstracts = [...article.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((match) => {
    const label = match[1].match(/Label="([^"]*)"/)?.[1];
    const text = textContent(match[2]);
    return label && text ? `${label}: ${text}` : text;
  }).filter(Boolean);
  const authors: PaperAuthor[] = [];
  for (const match of article.matchAll(/<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/g)) {
    const family = textContent(match[1].match(/<LastName[^>]*>([\s\S]*?)<\/LastName>/)?.[1] ?? "");
    const given = textContent(match[1].match(/<ForeName[^>]*>([\s\S]*?)<\/ForeName>/)?.[1] ?? "");
    const collective = textContent(match[1].match(/<CollectiveName[^>]*>([\s\S]*?)<\/CollectiveName>/)?.[1] ?? "");
    if (family) authors.push({ name: given ? `${given} ${family}` : family, family, given: given || undefined });
    else if (collective) authors.push({ name: collective });
  }
  const capped = capAuthors(authors);
  const doi = normalizeDoi(article.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/i)?.[1] ?? "")
    ?? normalizeDoi(article.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/i)?.[1] ?? "");
  const yearText = article.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1]
    ?? article.match(/<PubDate>[\s\S]*?<MedlineDate>([^<]+)<\/MedlineDate>/)?.[1]
    ?? "";
  const yearMatch = yearText.match(/(\d{4})/);
  const venue = textContent(article.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)?.[1] ?? "");
  const volume = textContent(article.match(/<Volume>([\s\S]*?)<\/Volume>/)?.[1] ?? "");
  const issue = textContent(article.match(/<Issue>([\s\S]*?)<\/Issue>/)?.[1] ?? "");
  const pages = textContent(article.match(/<MedlinePgn>([\s\S]*?)<\/MedlinePgn>/)?.[1] ?? "");
  return publishable({
    title,
    authors: capped.authors,
    author_count: capped.author_count,
    year: yearMatch ? Number(yearMatch[1]) : null,
    venue: venue || null,
    abstract: abstracts.join(" ") || null,
    volume: volume || null,
    issue: issue || null,
    pages: pages || null,
    identifiers: { doi: doi ?? undefined, pmid },
    source_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    pdf_url: null,
    open_access: null,
    cited_by_count: null,
    source: "pubmed"
  });
}

async function pubmedFetch(id: string): Promise<Paper | null> {
  const xml = await getText("pubmed", `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${encodeURIComponent(id)}&${ncbiQuery()}`, "application/xml");
  const article = xml.match(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/)?.[1];
  if (!article) return null;
  return mapPubmedXml(article);
}

async function searchPubmed(options: SearchOptions, limit: number): Promise<Paper[]> {
  const body = await getJson("pubmed", `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&sort=relevance&term=${encodeURIComponent(pubmedTerm(options))}&${ncbiQuery()}`);
  const result = isRecord(body) ? body.esearchresult : null;
  const ids = isRecord(result) && Array.isArray(result.idlist) ? result.idlist.map(String) : [];
  const openAccess = options.openAccess === true ? true : options.openAccess === false ? false : null;
  return pubmedSummaries(ids, openAccess);
}

async function pubmedRelated(pmid: string, relation: "cited_by" | "references", limit: number): Promise<Paper[]> {
  const linkname = relation === "cited_by" ? "pubmed_pubmed_citedin" : "pubmed_pubmed_refs";
  const body = await getJson("pubmed", `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&linkname=${linkname}&id=${encodeURIComponent(pmid)}&retmode=json&${ncbiQuery()}`);
  const linksets = isRecord(body) && Array.isArray(body.linksets) ? body.linksets : [];
  const ids: string[] = [];
  for (const set of linksets) {
    if (!isRecord(set) || !Array.isArray(set.linksetdbs)) continue;
    for (const db of set.linksetdbs) {
      if (!isRecord(db) || !Array.isArray(db.links)) continue;
      for (const link of db.links) ids.push(String(link));
    }
  }
  return pubmedSummaries([...new Set(ids)].slice(0, limit), null);
}

function mapArxiv(entry: string): Paper | null {
  const title = textContent(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
  const idUrl = textContent(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] ?? "");
  const modern = idUrl.match(/(\d{4}\.\d{4,5})/);
  const legacy = idUrl.match(/arxiv\.org\/abs\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i);
  const arxiv = modern?.[1] ?? legacy?.[1];
  if (!title || !arxiv || title === "ArXiv Query") return null;
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((match) => ({ name: textContent(match[1]) }));
  const capped = capAuthors(authors);
  const published = entry.match(/<published>(\d{4})/)?.[1];
  const doi = normalizeDoi(entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/)?.[1] ?? "");
  const pdf = safeUrl(entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/)?.[1] ?? entry.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/)?.[1] ?? null);
  const summary = textContent(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "");
  return publishable({
    title,
    authors: capped.authors,
    author_count: capped.author_count,
    year: published ? Number(published) : null,
    venue: "arXiv",
    abstract: summary || null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: { arxiv, doi: doi ?? undefined },
    source_url: `https://arxiv.org/abs/${arxiv}`,
    pdf_url: pdf,
    open_access: true,
    cited_by_count: null,
    source: "arxiv"
  });
}

function arxivSearchQuery(options: SearchOptions): string {
  const field = fieldToken(options.field);
  let query = `all:"${plainQuery(options.query).replace(/"/g, "")}"`;
  if (field && /^[a-z-]+(?:\.[A-Z]{2})?$/.test(field)) query = `cat:${field}+AND+${query}`;
  else if (field) query = `all:"${field.replace(/"/g, "")}"+AND+${query}`;
  if (options.yearFrom || options.yearTo) {
    const from = `${options.yearFrom ?? 1991}01010000`;
    const to = `${options.yearTo ?? 2100}12312359`;
    query += `+AND+submittedDate:[${from}+TO+${to}]`;
  }
  return query;
}

async function searchArxiv(options: SearchOptions, limit: number): Promise<Paper[]> {
  if (options.openAccess === false) return [];
  const xml = await getText("arxiv", `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(arxivSearchQuery(options)).replace(/%2B/g, "+")}&start=0&max_results=${limit}`, "application/atom+xml");
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => mapArxiv(match[1])).filter((paper): paper is Paper => Boolean(paper));
}

async function arxivById(id: string): Promise<Paper | null> {
  const xml = await getText("arxiv", `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, "application/atom+xml");
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry || /<title>\s*Error/i.test(entry)) return null;
  return mapArxiv(entry);
}

async function searchOne(source: PaperSource, options: SearchOptions, limit: number): Promise<Paper[]> {
  switch (source) {
    case "openalex": return searchOpenAlex(options, limit);
    case "crossref": return searchCrossref(options, limit);
    case "semantic_scholar": return searchSemantic(options, limit);
    case "pubmed": return searchPubmed(options, limit);
    case "arxiv": return searchArxiv(options, limit);
  }
}

function samePaper(left: Paper, right: Paper): boolean {
  if (left.identifiers.doi && right.identifiers.doi) return left.identifiers.doi.toLowerCase() === right.identifiers.doi.toLowerCase();
  if (left.identifiers.pmid && right.identifiers.pmid) return left.identifiers.pmid === right.identifiers.pmid;
  if (left.identifiers.arxiv && right.identifiers.arxiv) return left.identifiers.arxiv.toLowerCase() === right.identifiers.arxiv.toLowerCase();
  return false;
}

function mergeAbstract(primary: Paper, extra: Paper | null): Paper {
  if (!extra || primary.abstract || !extra.abstract || !samePaper(primary, extra)) return primary;
  return { ...primary, abstract: extra.abstract };
}

export async function searchPapers(options: SearchOptions): Promise<SearchResponse> {
  const query = plainQuery(options.query);
  if (query.length < 2) throw new ScholarlyError("Enter at least two characters to search.", "bad_identifier");
  const limit = clampLimit(options.limit);
  const source = options.source ?? "all";
  const sources: PaperSource[] = source === "all"
    ? ["openalex", "pubmed", "crossref", "arxiv", "semantic_scholar"]
    : [source];
  const settled = await Promise.all(sources.map(async (name) => {
    try {
      const papers = (await searchOne(name, { ...options, query }, limit))
        .filter((paper) => yearInRange(paper, options.yearFrom, options.yearTo))
        .filter((paper) => options.openAccess == null || paper.open_access === options.openAccess)
        .slice(0, limit)
        .map(forList);
      return { name, papers, warning: null as string | null };
    } catch (error) {
      const message = error instanceof ScholarlyError ? error.message : `${label(name)} could not be reached.`;
      if (source !== "all") throw error instanceof ScholarlyError ? error : new ScholarlyError(message, "upstream");
      return { name, papers: [] as Paper[], warning: message };
    }
  }));
  const warnings = settled.flatMap((row) => {
    const notes = row.warning ? [row.warning] : [];
    if (row.name === "arxiv" && options.openAccess === false) notes.push("arXiv records are open access, so a closed-access filter excludes them.");
    return notes;
  });
  const buckets = settled.map((row) => [...row.papers]);
  const papers: Paper[] = [];
  const seen = new Set<string>();
  let progressed = true;
  while (papers.length < limit && progressed) {
    progressed = false;
    for (const bucket of buckets) {
      while (bucket.length) {
        const next = bucket.shift();
        if (!next) break;
        const key = dedupeKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        papers.push(next);
        progressed = true;
        break;
      }
      if (papers.length >= limit) break;
    }
  }
  if (!papers.length && warnings.length && warnings.length === sources.length) {
    throw new ScholarlyError(warnings.join(" "), "upstream");
  }
  return {
    papers,
    warnings,
    sources_consulted: sources,
    source_note: SOURCE_NOTE,
    retrieved_at: new Date().toISOString()
  };
}

export async function getPaper(identifier: string): Promise<Paper> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) throw new ScholarlyError("Identifier must be a DOI, PMID, arXiv id, or OpenAlex work id.", "bad_identifier");
  let paper: Paper | null = null;
  if (parsed.kind === "doi") {
    const found = await openalexByPath(`https://doi.org/${parsed.value}`);
    paper = found?.paper ?? await crossrefByDoi(parsed.value);
    if (paper?.identifiers.pmid && !paper.abstract) paper = mergeAbstract(paper, await pubmedFetch(paper.identifiers.pmid).catch(() => null));
  } else if (parsed.kind === "pmid") {
    const pubmed = await pubmedFetch(parsed.value);
    const openalex = await openalexByPath(`pmid:${parsed.value}`).catch(() => null);
    paper = openalex?.paper && pubmed && samePaper(openalex.paper, pubmed)
      ? mergeAbstract(openalex.paper, pubmed)
      : pubmed ?? openalex?.paper ?? null;
  } else if (parsed.kind === "arxiv") {
    const arxiv = await arxivById(parsed.value);
    const openalex = arxiv?.identifiers.doi ? await openalexByPath(`https://doi.org/${arxiv.identifiers.doi}`).catch(() => null) : null;
    paper = openalex?.paper && arxiv && samePaper(openalex.paper, arxiv) ? mergeAbstract({ ...openalex.paper, identifiers: { ...openalex.paper.identifiers, arxiv: arxiv.identifiers.arxiv } }, arxiv) : arxiv;
  } else if (parsed.kind === "openalex") {
    const found = await openalexByPath(parsed.value);
    paper = found?.paper ?? null;
    if (paper?.identifiers.pmid && !paper.abstract) paper = mergeAbstract(paper, await pubmedFetch(paper.identifiers.pmid).catch(() => null));
  } else {
    paper = await semanticById(parsed.value);
  }
  if (!paper) throw new ScholarlyError("No paper was returned for that identifier.", "not_found");
  return paper;
}

export async function findRelatedPapers(identifier: string, relation: "cited_by" | "references", limitInput?: number): Promise<{
  relation: "cited_by" | "references";
  anchor: Paper;
  papers: Paper[];
  source_note: string;
  retrieved_at: string;
}> {
  const limit = clampLimit(limitInput);
  const anchor = await getPaper(identifier);
  const openalex = anchor.identifiers.openalex?.match(/W\d+/)?.[0];
  let papers: Paper[] = [];
  if (openalex) {
    if (relation === "cited_by") {
      papers = await openalexWorks({ filter: `cites:${openalex}`, "per-page": String(limit), sort: "cited_by_count:desc" });
    } else {
      const full = await openalexByPath(openalex);
      const ids = (full?.referenced ?? []).map((item) => item.match(/W\d+/)?.[0]).filter((id): id is string => Boolean(id)).slice(0, limit);
      if (ids.length) {
        const fetched = await openalexWorks({ filter: `openalex:${ids.join("|")}`, "per-page": String(ids.length) });
        const byId = new Map(fetched.map((paper) => [paper.identifiers.openalex?.match(/W\d+/)?.[0], paper]));
        papers = ids.map((id) => byId.get(id)).filter((paper): paper is Paper => Boolean(paper));
      }
    }
  } else if (anchor.identifiers.pmid) {
    papers = await pubmedRelated(anchor.identifiers.pmid, relation, limit);
  } else if (anchor.identifiers.doi || anchor.identifiers.arxiv || anchor.identifiers.semantic_scholar) {
    const id = anchor.identifiers.doi
      ? `DOI:${anchor.identifiers.doi}`
      : anchor.identifiers.arxiv
        ? `ARXIV:${anchor.identifiers.arxiv}`
        : anchor.identifiers.semantic_scholar as string;
    papers = await semanticRelated(id, relation, limit);
  } else {
    throw new ScholarlyError("No citation graph was returned for this record.", "not_found");
  }
  return {
    relation,
    anchor: forList(anchor),
    papers: papers.slice(0, limit).map(forList),
    source_note: SOURCE_NOTE,
    retrieved_at: new Date().toISOString()
  };
}
