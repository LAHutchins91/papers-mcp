import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app, handleRouteError } from "../src/server.js";

describe("route errors", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("logs a body-parser failure and keeps 400 without request secrets", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      logged.push(String(line));
    });
    try {
      const response = await fetch(`${base}/register?code=secret-code`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token"
        },
        body: "{"
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request." });
      const entry = logged.map((line) => JSON.parse(line) as Record<string, unknown>).find((item) => item.event === "route_error");
      expect(entry).toMatchObject({ event: "route_error", method: "POST", path: "/register" });
      expect(typeof entry?.message).toBe("string");
      expect(String(entry?.message).length).toBeLessThanOrEqual(300);
      expect(JSON.stringify(entry)).not.toContain("secret-token");
      expect(JSON.stringify(entry)).not.toContain("secret-code");
      expect(Object.keys(entry ?? {}).sort()).toEqual(["event", "message", "method", "name", "path"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 413 when the body is too large", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "x".repeat(200_000) })
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "Request is too large." });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 for an unexpected error and truncates the logged message", () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      logged.push(String(line));
    });
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      }
    };
    try {
      handleRouteError(
        new Error(`${"x".repeat(400)} secret-token`),
        { method: "POST", path: "/token" } as Request,
        res as unknown as Response,
        (() => undefined) as NextFunction
      );
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: "Something went wrong. Try again in a moment." });
      const entry = JSON.parse(logged[0] ?? "{}") as { event: string; message: string; name: string };
      expect(entry).toMatchObject({ event: "route_error", name: "Error" });
      expect(entry.message).toHaveLength(300);
      expect(entry.message).not.toContain("secret-token");
    } finally {
      spy.mockRestore();
    }
  });
});
