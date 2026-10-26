import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SdkGenerator } from "../src/core/sniffing/SdkGenerator.js";
import { SchemaInferrer } from "../src/core/sniffing/SchemaInferrer.js";
import { OpenApiGenerator } from "../src/core/sniffing/OpenApiGenerator.js";
const traffic = (origin: string, body: any, extra: any = {}) => ({
  id: origin,
  timestamp: new Date().toISOString(),
  url: origin + "/items",
  pathname: "/items",
  method: "GET" as const,
  queryParams: {},
  requestHeaders: {},
  responseStatus: 200,
  responseHeaders: { "Content-Type": "application/json" },
  responseBody: body,
  durationMs: 1,
  ...extra,
});
describe("Observed contracts and executable SDKs", () => {
  it("retains false, zero, null and empty string payloads with actual media types", () => {
    for (const body of [false, 0, null, ""]) {
      const spec = OpenApiGenerator.generate([
        traffic("https://one.example", body),
      ]);
      expect(
        spec.paths["/items"].get.responses["200"].content["application/json"]
          .schema,
      ).toEqual(SchemaInferrer.infer(body));
    }
    const text = OpenApiGenerator.generate([
      traffic("https://one.example", "hello", {
        responseHeaders: { "content-type": "text/plain" },
      }),
    ]);
    expect(
      text.paths["/items"].get.responses["200"].content["text/plain"].schema
        .type,
    ).toBe("string");
  });
  it("rejects ambiguous host collisions and can emit one document per origin", () => {
    const samples = [
      traffic("https://one.example", {}),
      traffic("https://two.example", {}),
    ];
    expect(() => OpenApiGenerator.generate(samples)).toThrow(
      "Select an origin",
    );
    const specs = OpenApiGenerator.generateAll(samples);
    expect(Object.keys(specs)).toHaveLength(2);
    expect(specs["https://one.example"].paths["/items"].get.servers).toEqual([
      { url: "https://one.example" },
    ]);
  });
  it("uses JSON Schema null unions, property presence and all array samples", () => {
    expect(SchemaInferrer.infer({ nullable: null }).required).toEqual([
      "nullable",
    ]);
    expect(
      SchemaInferrer.mergeSchemas({ type: "string" }, { type: "null" }).type,
    ).toEqual(["string", "null"]);
    const values = Array.from({ length: 12 }, (_, i) =>
      i === 11 ? "text" : i,
    );
    expect(
      SchemaInferrer.infer(values).items?.anyOf?.some(
        (s) => s.type === "string",
      ),
    ).toBe(true);
    expect(SchemaInferrer.infer([]).items).toEqual({});
  });
  it("generates semantically type-checked code for primitives, arrays, reserved IDs, duplicate names and hostile strings", async () => {
    const spec = {
      info: { title: "123 Client */ injected" },
      servers: [{ url: "https://default.example" }],
      paths: {
        "/items/{class}/{bad-id}": {
          get: {
            operationId: "constructor",
            parameters: [
              { in: "path", name: "class" },
              { in: "path", name: "bad-id" },
              { in: "query", name: "tag" },
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
          },
        },
        "/other": {
          get: {
            operationId: "constructor",
            servers: [{ url: "https://second.example" }],
            responses: {
              "200": {
                content: {
                  "application/json": { schema: { type: "boolean" } },
                },
              },
            },
          },
        },
        "/empty": {
          head: { responses: { "200": {} } },
          delete: { responses: { "204": {} } },
        },
        "/text": {
          post: {
            requestBody: {
              content: { "text/plain": { schema: { type: "string" } } },
            },
            responses: {
              "200": {
                content: { "text/plain": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };
    const code = SdkGenerator.generateTypeScript(spec);
    const dir = mkdtempSync(path.join(tmpdir(), "packetlark-sdk-"));
    try {
      writeFileSync(path.join(dir, "sdk.ts"), code);
      execFileSync(process.execPath, [
        path.resolve("node_modules/typescript/bin/tsc"),
        path.join(dir, "sdk.ts"),
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "ES2022",
        "--lib",
        "ES2022,DOM,DOM.Iterable",
        "--skipLibCheck",
        "--outDir",
        path.join(dir, "out"),
      ]);
      const generated = await import(
        "data:text/javascript;base64," +
          Buffer.from(readFileSync(path.join(dir, "out/sdk.js"))).toString(
            "base64",
          )
      );
      const Client = Object.values(generated).find(
        (value) => typeof value === "function",
      ) as any;
      const client = new Client();
      expect(typeof client.constructorOperation).toBe("function");
      expect(typeof client.constructorOperation2).toBe("function");
      expect(code).toContain("encodeURIComponent");
      expect(code).toContain("https://second.example");
      expect(code).not.toMatch(/export interface \w+ (boolean|string|\()/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
