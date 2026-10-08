import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/server.js";

let server: Server;
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("tools/list contract", () => {
  it("returns the same four tools and schemas", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { tools?: unknown[] } };
    const tools = body.result?.tools;
    const expected = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/tools-list.json"), "utf8")) as unknown[];
    expect(tools).toHaveLength(4);
    expect((tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      "search_papers",
      "get_paper",
      "find_related_papers",
      "format_citation"
    ]);
    expect(tools).toEqual(expected);
  });
});
