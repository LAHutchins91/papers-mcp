export const SOURCE_NOTE = "Every paper here was returned by the named public API. No paper, author, identifier, or abstract was added from memory.";

export type PaperSource = "openalex" | "semantic_scholar" | "pubmed" | "crossref" | "arxiv";

export interface PaperAuthor {
  name: string;
  family?: string;
  given?: string;
}

export interface PaperIdentifiers {
  doi?: string;
  pmid?: string;
  arxiv?: string;
  openalex?: string;
  semantic_scholar?: string;
}

export interface Paper {
  title: string;
  authors: PaperAuthor[];
  author_count: number;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  abstract_truncated?: boolean;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  identifiers: PaperIdentifiers;
  source_url: string;
  pdf_url: string | null;
  open_access: boolean | null;
  cited_by_count: number | null;
  source: PaperSource;
}

export type ParsedId =
  | { kind: "doi"; value: string }
  | { kind: "pmid"; value: string }
  | { kind: "arxiv"; value: string }
  | { kind: "openalex"; value: string }
  | { kind: "semantic_scholar"; value: string };

const DOI_RE = /10\.\d{4,9}\/[^\s?#]+/i;
const MODERN_ARXIV = /(\d{4}\.\d{4,5})(?:v\d+)?/i;
const LEGACY_ARXIV = /((?:[a-z-]+(?:\.[A-Z]{2})?)\/\d{7})(?:v\d+)?/;

export function normalizeDoi(raw: string): string | null {
  const match = raw.trim().match(DOI_RE);
  if (!match) return null;
  return match[0].replace(/[.)\],;]+$/, "");
}

export function doiUrl(doi: string): string {
  return `https://doi.org/${normalizeDoi(doi) ?? doi}`;
}

export function parseIdentifier(input: string): ParsedId | null {
  const text = input.trim();
  if (!text) return null;
  const openalex = text.match(/openalex\.org\/(W\d+)\b/i) ?? text.match(/^(W\d{8,})$/);
  if (openalex) return { kind: "openalex", value: openalex[1].toUpperCase() };
  if (/^pmid\s*:?\s*\d+$/i.test(text) || /pubmed\.ncbi\.nlm\.nih\.gov\/\d+/i.test(text)) {
    const pmid = text.match(/(\d+)/);
    if (pmid) return { kind: "pmid", value: pmid[1] };
  }
  if (DOI_RE.test(text) && (/doi\.org/i.test(text) || /^doi:/i.test(text) || /^10\./.test(text))) {
    const doi = normalizeDoi(text);
    if (doi) return { kind: "doi", value: doi };
  }
  if (/arxiv\.org/i.test(text) || /^arxiv:/i.test(text)) {
    const modern = text.match(MODERN_ARXIV);
    if (modern) return { kind: "arxiv", value: modern[1] };
    const legacy = text.match(LEGACY_ARXIV);
    if (legacy) return { kind: "arxiv", value: legacy[1] };
  }
  if (MODERN_ARXIV.test(text) && text.replace(MODERN_ARXIV, "").replace(/v\d+$/i, "").trim() === "") {
    const modern = text.match(MODERN_ARXIV);
    if (modern) return { kind: "arxiv", value: modern[1] };
  }
  if (/^[a-f0-9]{40}$/i.test(text)) return { kind: "semantic_scholar", value: text.toLowerCase() };
  if (/^\d{1,9}$/.test(text)) return { kind: "pmid", value: text };
  return null;
}

export function textFromInvertedIndex(index: unknown): string | null {
  if (!index || typeof index !== "object" || Array.isArray(index)) return null;
  const placed: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === "number" && Number.isInteger(pos) && pos >= 0 && pos < 20000) placed[pos] = word;
    }
  }
  const text = placed.map((word) => word ?? "").join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:" && /(^|\.)arxiv\.org$/i.test(url.hostname)) {
      url.protocol = "https:";
      return url.toString();
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function capAuthors(authors: PaperAuthor[]): { authors: PaperAuthor[]; author_count: number } {
  const clean = authors.filter((author) => author.name.trim());
  if (clean.length <= 25) return { authors: clean, author_count: clean.length };
  return { authors: [...clean.slice(0, 19), clean[clean.length - 1]], author_count: clean.length };
}

export function publishable(paper: Paper | null): Paper | null {
  if (!paper) return null;
  const title = paper.title.trim();
  const sourceUrl = safeUrl(paper.source_url);
  const ids = paper.identifiers;
  const hasId = Boolean(ids.doi || ids.pmid || ids.arxiv || ids.openalex || ids.semantic_scholar);
  if (!title || !sourceUrl || !hasId) return null;
  return {
    ...paper,
    title,
    source_url: sourceUrl,
    pdf_url: safeUrl(paper.pdf_url),
    abstract: paper.abstract?.trim() || null,
    authors: paper.authors.filter((author) => author.name.trim())
  };
}

export function forList(paper: Paper): Paper {
  if (!paper.abstract || paper.abstract.length <= 1200) return paper;
  return { ...paper, abstract: `${paper.abstract.slice(0, 1200).trimEnd()}…`, abstract_truncated: true };
}

export function dedupeKey(paper: Paper): string {
  if (paper.identifiers.doi) return `doi:${paper.identifiers.doi.toLowerCase()}`;
  if (paper.identifiers.pmid) return `pmid:${paper.identifiers.pmid}`;
  if (paper.identifiers.arxiv) return `arxiv:${paper.identifiers.arxiv.toLowerCase()}`;
  if (paper.identifiers.openalex) return `openalex:${paper.identifiers.openalex}`;
  return `s2:${paper.identifiers.semantic_scholar}`;
}

export function yearInRange(paper: Paper, yearFrom?: number, yearTo?: number): boolean {
  if (yearFrom == null && yearTo == null) return true;
  if (paper.year == null) return false;
  if (yearFrom != null && paper.year < yearFrom) return false;
  if (yearTo != null && paper.year > yearTo) return false;
  return true;
}

export class ScholarlyError extends Error {
  constructor(message: string, readonly code: "rate_limit" | "not_found" | "upstream" | "bad_identifier") {
    super(message);
    this.name = "ScholarlyError";
  }
}
