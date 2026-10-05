import { doiUrl, type Paper, type PaperAuthor } from "./papers.js";

export type CitationStyle = "apa" | "mla" | "chicago" | "bibtex";

interface NameParts {
  family: string;
  given: string;
}

function partsOf(author: PaperAuthor): NameParts {
  if (author.family) return { family: author.family, given: author.given ?? "" };
  const tokens = author.name.trim().split(/\s+/);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1].replace(/\./g, "");
    if (/^[A-Z]{1,3}$/.test(last)) {
      return { family: tokens.slice(0, -1).join(" "), given: last.split("").join(" ") };
    }
  }
  if (tokens.length === 1) return { family: tokens[0], given: "" };
  return { family: tokens[tokens.length - 1], given: tokens.slice(0, -1).join(" ") };
}

function initials(given: string): string {
  return given.split(/[\s.]+/).filter(Boolean).map((part) => {
    return part.split("-").map((piece) => (piece ? `${piece[0].toUpperCase()}.` : "")).join("-");
  }).filter(Boolean).join(" ");
}

function sentence(value: string): string {
  const text = value.trim();
  if (!text) return text;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function pages(value: string | null, dash: string): string | null {
  if (!value) return null;
  return value.replace(/\s*-\s*/, dash);
}

function locator(paper: Paper): string | null {
  if (paper.identifiers.doi) return doiUrl(paper.identifiers.doi);
  return paper.source_url;
}

function apaAuthors(paper: Paper): string {
  const formatted = paper.authors.map((author) => {
    const name = partsOf(author);
    const ini = initials(name.given);
    return ini ? `${name.family}, ${ini}` : name.family;
  });
  if (!formatted.length) return "";
  if (paper.author_count > 20) return `${formatted.slice(0, 19).join(", ")}, ... ${formatted[formatted.length - 1]}`;
  if (formatted.length === 1) return formatted[0];
  return `${formatted.slice(0, -1).join(", ")}, & ${formatted[formatted.length - 1]}`;
}

function givenFamily(author: PaperAuthor): string {
  const name = partsOf(author);
  return name.given ? `${name.given} ${name.family}` : name.family;
}

function familyGiven(author: PaperAuthor): string {
  const name = partsOf(author);
  return name.given ? `${name.family}, ${name.given}` : name.family;
}

function proseAuthors(paper: Paper, limit: number): string {
  const authors = paper.authors;
  if (!authors.length) return "";
  if (paper.author_count > limit) return `${familyGiven(authors[0])}, et al`;
  if (authors.length === 1) return familyGiven(authors[0]);
  if (authors.length === 2) return `${familyGiven(authors[0])}, and ${givenFamily(authors[1])}`;
  return `${authors.slice(0, -1).map(familyGiven).join(", ")}, and ${givenFamily(authors[authors.length - 1])}`;
}

function venueBits(paper: Paper): { volumeIssue: string; pages: string } {
  const volume = paper.volume ? paper.volume : "";
  const issue = paper.issue ? `(${paper.issue})` : "";
  return { volumeIssue: `${volume}${issue}`, pages: pages(paper.pages, "–") ?? "" };
}

export function formatCitation(paper: Paper, style: CitationStyle): string {
  switch (style) {
    case "apa": return formatApa(paper);
    case "mla": return formatMla(paper);
    case "chicago": return formatChicago(paper);
    case "bibtex": return formatBibtex(paper);
  }
}

function formatApa(paper: Paper): string {
  const authors = apaAuthors(paper);
  const year = paper.year ?? "n.d.";
  const title = sentence(paper.title);
  const bits = venueBits(paper);
  const where = locator(paper);
  const venue = paper.venue ? `${sentence(paper.venue).replace(/\.$/, "")}${bits.volumeIssue ? `, ${bits.volumeIssue}` : ""}${bits.pages ? `, ${bits.pages}` : ""}.` : "";
  return [authors ? `${authors} (${year}).` : `(${year}).`, title, venue, where].filter(Boolean).join(" ");
}

function formatMla(paper: Paper): string {
  const authors = paper.author_count >= 3 && paper.authors[0]
    ? `${familyGiven(paper.authors[0])}, et al`
    : proseAuthors(paper, 2);
  const title = `"${paper.title.trim().replace(/[.?!]$/, "")}."`;
  const venue = paper.venue ?? "";
  const vol = paper.volume ? `vol. ${paper.volume}` : "";
  const issue = paper.issue ? `no. ${paper.issue}` : "";
  const year = paper.year ? String(paper.year) : "";
  const pg = pages(paper.pages, "-");
  const tail = [venue, vol, issue, year, pg ? `pp. ${pg}` : ""].filter(Boolean).join(", ");
  const where = locator(paper);
  return [authors ? `${authors}.` : "", title, tail ? `${tail}.` : "", where].filter(Boolean).join(" ");
}

function formatChicago(paper: Paper): string {
  const authors = proseAuthors(paper, 10);
  const year = paper.year ? String(paper.year) : "n.d.";
  const title = `"${paper.title.trim().replace(/[.?!]$/, "")}."`;
  const bits = venueBits(paper);
  const venue = paper.venue
    ? `${paper.venue}${bits.volumeIssue ? ` ${bits.volumeIssue}` : ""}${bits.pages ? `: ${bits.pages}` : ""}.`
    : "";
  const where = locator(paper);
  return [authors ? `${authors}.` : "", `${year}.`, title, venue, where].filter(Boolean).join(" ");
}

function bibtexEscape(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[&%$#_]/g, (char) => `\\${char}`)
    .replace(/[{}]/g, (char) => `\\${char}`);
}

function bibKey(paper: Paper): string {
  const family = paper.authors[0] ? partsOf(paper.authors[0]).family : "anon";
  const word = (paper.title.match(/[A-Za-z0-9]+/) ?? ["paper"])[0];
  const year = paper.year ?? "nd";
  return `${family}${year}${word}`.replace(/[^A-Za-z0-9]/g, "") || "paper";
}

function bibField(name: string, value: string | null | undefined): string | null {
  if (!value) return null;
  return `  ${name} = {${bibtexEscape(value)}}`;
}

function formatBibtex(paper: Paper): string {
  const type = paper.venue ? "article" : "misc";
  const authors = paper.authors.map((author) => {
    const name = partsOf(author);
    return name.given ? `${name.family}, ${name.given}` : name.family;
  }).join(" and ");
  const fields = [
    bibField("author", authors || null),
    bibField("title", paper.title),
    bibField("journal", paper.venue),
    bibField("year", paper.year ? String(paper.year) : null),
    bibField("volume", paper.volume),
    bibField("number", paper.issue),
    bibField("pages", pages(paper.pages, "--")),
    bibField("doi", paper.identifiers.doi ?? null),
    bibField("pmid", paper.identifiers.pmid ?? null),
    bibField("eprint", paper.identifiers.arxiv ?? null),
    bibField("url", paper.source_url)
  ].filter((field): field is string => Boolean(field));
  return `@${type}{${bibKey(paper)},\n${fields.join(",\n")}\n}`;
}
