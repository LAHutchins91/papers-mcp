import { afterEach, describe, expect, it } from "vitest";
import { ScholarlyError } from "../src/papers.js";
import { getPaper, resetScholarlyState, searchPapers, setScholarlyFetch } from "../src/scholar.js";

afterEach(() => {
  setScholarlyFetch(null);
  resetScholarlyState();
});

describe("search does not invent papers", () => {
  it("returns only the valid rows a mocked OpenAlex payload contained", async () => {
    setScholarlyFetch(async (input) => {
      const url = String(input);
      if (!url.includes("api.openalex.org/works")) return new Response("missing", { status: 404 });
      const body = {
        results: [
          { display_name: "", id: "https://openalex.org/W0000000001" },
          {
            display_name: "A real mocked record",
            id: "https://openalex.org/W123456789",
            doi: "https://doi.org/10.1000/mock-record",
            publication_year: 2021,
            authorships: [{ author: { display_name: "Ada Lovelace" } }],
            primary_location: { landing_page_url: "https://example.org/mock-record", source: { display_name: "Mock Journal" } },
            open_access: { is_oa: true },
            ids: { openalex: "https://openalex.org/W123456789", doi: "https://doi.org/10.1000/mock-record" },
            cited_by_count: 3
          }
        ]
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const found = await searchPapers({ query: "mocked topic", source: "openalex", limit: 5 });
    expect(found.papers).toHaveLength(1);
    expect(found.papers[0].title).toBe("A real mocked record");
    expect(found.papers[0].identifiers.doi).toBe("10.1000/mock-record");
    expect(found.papers[0].source_url).toBe("https://example.org/mock-record");
    expect(found.source_note).toMatch(/public API/);
  });

  it("surfaces an empty API list instead of a substitute paper", async () => {
    setScholarlyFetch(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const found = await searchPapers({ query: "nothing here", source: "openalex", limit: 3 });
    expect(found.papers).toEqual([]);
  });
});

describe("live scholarly APIs", () => {
  it("searches OpenAlex, PubMed, Crossref, and arXiv", async () => {
    process.env.SCHOLARLY_CONTACT_EMAIL = "papers-tests@example.com";
    const openalex = await searchPapers({ query: "crispr gene editing", source: "openalex", limit: 2, openAccess: true });
    expect(openalex.papers.length).toBeGreaterThan(0);
    for (const paper of openalex.papers) {
      expect(paper.source).toBe("openalex");
      expect(paper.open_access).toBe(true);
      expect(paper.source_url).toMatch(/^https?:\/\//);
      expect(paper.identifiers.doi || paper.identifiers.openalex || paper.identifiers.pmid).toBeTruthy();
    }

    const pubmed = await searchPapers({ query: "deep learning", source: "pubmed", limit: 1 });
    expect(pubmed.papers[0].identifiers.pmid).toMatch(/^\d+$/);
    expect(pubmed.papers[0].source_url).toContain("pubmed.ncbi.nlm.nih.gov");

    const crossref = await searchPapers({ query: "deep learning", source: "crossref", limit: 1, yearFrom: 2010, yearTo: 2024 });
    expect(crossref.papers[0].identifiers.doi).toMatch(/^10\./);
    expect(crossref.papers[0].year).toBeGreaterThanOrEqual(2010);
    expect(crossref.papers[0].year).toBeLessThanOrEqual(2024);

    const arxiv = await searchPapers({ query: "attention mechanism", source: "arxiv", limit: 1 });
    expect(arxiv.papers[0].identifiers.arxiv).toBeTruthy();
    expect(arxiv.papers[0].source_url).toContain("arxiv.org");
    expect(arxiv.papers[0].open_access).toBe(true);

    const mixed = await searchPapers({ query: "statins", source: "all", limit: 4, yearFrom: 2018, yearTo: 2024 });
    const sources = new Set(mixed.papers.map((paper) => paper.source));
    expect(sources.size).toBeGreaterThan(1);
    for (const paper of mixed.papers) {
      expect(paper.year).toBeGreaterThanOrEqual(2018);
      expect(paper.year).toBeLessThanOrEqual(2024);
      expect(paper.source_url).toMatch(/^https?:\/\//);
    }
  });

  it("resolves a known DOI and reports Semantic Scholar honestly", async () => {
    process.env.SCHOLARLY_CONTACT_EMAIL = "papers-tests@example.com";
    const paper = await getPaper("10.1038/nature14539");
    expect(paper.title.toLowerCase()).toContain("deep learning");
    expect(paper.year).toBe(2015);
    expect(paper.identifiers.doi?.toLowerCase()).toBe("10.1038/nature14539");
    expect(paper.source_url).toMatch(/^https?:\/\//);
    expect(paper.authors.some((author) => /lecun/i.test(author.name))).toBe(true);

    try {
      const semantic = await searchPapers({ query: "deep learning", source: "semantic_scholar", limit: 1 });
      expect(semantic.papers.length).toBeGreaterThan(0);
      expect(semantic.papers[0].source).toBe("semantic_scholar");
      expect(semantic.papers[0].source_url).toMatch(/^https?:\/\//);
    } catch (error) {
      expect(error).toBeInstanceOf(ScholarlyError);
      expect((error as ScholarlyError).code).toBe("rate_limit");
    }
  });
});
