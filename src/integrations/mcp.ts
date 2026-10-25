import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpath, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SecretRedactor } from "../core/security/SecretRedactor.js";
import { parseJsonDocument } from "../core/models/JsonDocument.js";
import {
  CollectionRunner,
  reportWithoutBodies,
} from "../core/runner/CollectionRunner.js";
import { HttpExecutor } from "../core/engine/HttpExecutor.js";
import { collectionRequests } from "../core/models/CollectionContext.js";
const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(200);
export function createMcpServer(workspace: string): McpServer {
  const server = new McpServer(
    { name: "rea-api-studio", version: "1.1.0" },
    {
      instructions:
        "Local API development tools. Executing requests/collections can change remote services. Use only within the user-authorized API scope; collection scripts can send additional HTTP requests. No arbitrary file paths are accepted.",
    },
  );
  const reply = (data: any, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  });
  async function read(kind: "collections" | "environments", id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid identifier");
    const root = await realpath(workspace);
    const file = await realpath(
      path.join(root, ".rea-api", kind, id + ".json"),
    );
    if (!file.startsWith(root + path.sep))
      throw new Error("Workspace path escape rejected");
    if ((await stat(file)).size > 2 * 1024 * 1024)
      throw new Error("Workspace file exceeds 2 MiB");
    return parseJsonDocument(await readFile(file, "utf8"), kind);
  }
  server.registerTool(
    "list_collections",
    {
      description:
        "List local collection metadata. Does not execute scripts or return environment values.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const names = await readdir(
          path.join(workspace, ".rea-api", "collections"),
        );
        const files = names.filter((name) => name.endsWith(".json"));
        const items = [];
        for (const name of files.slice(0, 1000)) {
          const id = name.slice(0, -5);
          try {
            const col = await read("collections", id);
            items.push({
              id,
              name: col.name,
              requests: collectionRequests(col).length,
            });
          } catch (error) {
            items.push({ id, error: error.message });
          }
        }
        return reply({ collections: items, truncated: files.length > 1000 });
      } catch (error) {
        if (error.code === "ENOENT")
          return reply({
            collections: [],
            message:
              "Start the local studio and create/import a collection first.",
          });
        return reply({ error: error.message }, true);
      }
    },
  );
  server.registerTool(
    "run_collection",
    {
      description:
        "Execute a local collection and its scripts against its configured HTTP services. Can mutate remote systems. Runs are bounded and return a report without response bodies or environment values.",
      inputSchema: {
        collectionId: identifier,
        environmentId: identifier.optional(),
        iterations: z.number().int().min(1).max(100).default(1),
        stopOnFailure: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const collection = await read("collections", input.collectionId);
        const environment = input.environmentId
          ? await read("environments", input.environmentId)
          : undefined;
        const result = await CollectionRunner.run(collection, {
          environment,
          iterations: input.iterations,
          stopOnFailure: input.stopOnFailure,
          maxRequests: 100,
          signal: extra.signal,
        });
        return reply(reportWithoutBodies(result), result.status !== "passed");
      } catch (error) {
        return reply({ error: error.message }, true);
      }
    },
  );
  server.registerTool(
    "send_request",
    {
      description:
        "Send an HTTP request. This can change the target service; only use endpoints authorized by the user. Response bodies are omitted unless explicitly requested.",
      inputSchema: {
        url: z.string().url().max(8192),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
          .default("GET"),
        headers: z.record(z.string(), z.string().max(8192)).optional(),
        body: z
          .string()
          .max(1024 * 1024)
          .optional(),
        includeBody: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const secrets = new SecretRedactor();
      try {
        const response = await HttpExecutor.execute(
          {
            method: input.method,
            url: input.url,
            headers: Object.entries(input.headers || {}).map(
              ([key, value]) => ({ key, value, enabled: true }),
            ),
            queryParams: [],
            body:
              input.body === undefined
                ? { mode: "none" }
                : { mode: "raw-text", raw: input.body },
            auth: { type: "none" },
            maxResponseBytes: 1024 * 1024,
            timeoutMs: 30000,
          },
          [],
          [],
          { signal: extra.signal, secrets },
        );
        return reply(
          secrets.redact({
            status: response.status,
            statusText: response.statusText,
            sizeBytes: response.sizeBytes,
            timings: response.timings,
            error: response.error,
            ...(input.includeBody
              ? { body: response.body, bodyEncoding: response.bodyEncoding }
              : {}),
          }),
          !!response.error,
        );
      } catch (error) {
        return reply({ error: secrets.text(error.message) }, true);
      }
    },
  );
  return server;
}
export async function startMcp(workspace: string) {
  const server = createMcpServer(workspace);
  await server.connect(new StdioServerTransport());
}
