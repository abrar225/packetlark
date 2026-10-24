import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { StudioServer } from "../src/server/StudioServer.js";

describe("Local studio origin and web boundaries", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rea-web-"));
  const studio = new StudioServer(4498, 8498, workspace);
  beforeAll(() => studio.start());
  afterAll(async () => {
    await studio.stop();
    rmSync(workspace, { recursive: true, force: true });
  });
  it("serves distinct homepage/workbench and local assets", async () => {
    const home = await fetch("http://localhost:4498/");
    expect(await home.text()).toContain("Make sense");
    const workbench = await fetch("http://localhost:4498/studio");
    expect(await workbench.text()).toContain('id="req-url"');
    const css = await fetch("http://localhost:4498/studio.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    const app = await fetch("http://localhost:4498/app.js");
    expect(app.headers.get("content-type")).toContain("javascript");
    const missing = await fetch("http://localhost:4498/not-an-asset.woff2");
    expect(missing.status).toBe(404);
  });
  it("denies a foreign browser origin before revealing environment values or executing scripts", async () => {
    for (const endpoint of [
      "environments",
      "health",
      "collections",
      "execute",
    ]) {
      const response = await fetch(`http://localhost:4498/api/${endpoint}`, {
        headers: { Origin: "https://untrusted.example" },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    const response = await fetch("http://localhost:4498/api/health", {
      headers: { Origin: "null" },
    });
    expect(response.status).toBe(403);
  });
  it("allows its exact local browser origin, rejects a different port", async () => {
    const good = await fetch("http://localhost:4498/api/health", {
      headers: { Origin: "http://localhost:4498" },
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:4498",
    );
    const bad = await fetch("http://localhost:4498/api/health", {
      headers: { Origin: "http://localhost:4499" },
    });
    expect(bad.status).toBe(403);
  });
  it("rejects DNS-rebinding hosts and encoded static path traversal", async () => {
    const request = (path: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.get(
          { hostname: "127.0.0.1", port: 4498, path, headers: { Host: host } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on("error", reject);
      });
    expect(await request("/api/health", "foreign.example:4498")).toBe(403);
    expect(await request("/..%2fpackage.json", "localhost:4498")).toBe(404);
    expect(await request("/%zz", "localhost:4498")).toBe(400);
  });
  it("accepts standard absolute-form HTTP proxy requests with the target Host", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get({hostname:'127.0.0.1',port:8498,path:'http://localhost:4498/api/health',headers:{Host:'localhost:4498'}}, response => {
        response.resume(); resolve(response.statusCode!);
      }); request.on('error',reject);
    });
    expect(status).toBe(200);
  });
  it("refuses browser origins and foreign hosts on the traffic proxy", async () => {
    const response = await fetch(
      "http://localhost:8498/http://localhost:4498/api/health",
      { headers: { Origin: "https://untrusted.example" } },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
