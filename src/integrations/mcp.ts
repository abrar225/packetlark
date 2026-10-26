import type { ExecutionOptions } from "../core/engine/HttpExecutor.js";
import type { WorkspaceExecution } from "../core/engine/WorkspaceExecution.js";
import { validateJsonBody } from "../core/engine/JsonBodyValidation.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WorkspaceRepository } from "../core/workspace/WorkspaceRepository.js";
import path from "node:path";
import { SecretRedactor } from "../core/security/SecretRedactor.js";
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
    { name: "packetlark", version: "1.1.0" },
    {
      instructions:
        "Local API development tools. Executing requests/collections can change remote services. Use only within the user-authorized API scope; collection scripts can send additional HTTP requests. No arbitrary file paths are accepted.",
    },
  );
  let execution:WorkspaceExecution|undefined;
  let pendingContext:Promise<WorkspaceExecution>|undefined;
  const context=async()=>{
    pendingContext??=import("../core/engine/WorkspaceExecution.js").then(({WorkspaceExecution})=>execution=new WorkspaceExecution(path.join(workspace,".packetlark")));
    return (await pendingContext).options();
  };
  const executionOptions:ExecutionOptions={
    resolveCredential:async(...args)=>(await context()).resolveCredential(...args),
    resolveOAuth:async(...args)=>(await context()).resolveOAuth(...args),
    resolveFile:async(...args)=>(await context()).resolveFile(...args),
    validateJsonBody:(raw,schema,signal)=>validateJsonBody(raw,schema,{signal}),
  };
  let cleanup:Promise<void>|undefined;
  const closeContext=()=>cleanup??=(async()=>{if(pendingContext)await pendingContext;await execution?.close();})();
  const onclose=server.server.onclose;
  server.server.onclose=()=>{onclose?.();void closeContext().catch(()=>{});};
  const close=server.close.bind(server);
  server.close=async()=>{try{await close();}finally{await closeContext();}};
  const reply = (data: any, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  });
  function snapshot() {
    const repository = new WorkspaceRepository(path.join(workspace, ".packetlark"), { readOnly: true });
    try { return repository.snapshot(); } finally { repository.close(); }
  }
  async function read(kind: "collections", id: string): Promise<import("../core/models/types.js").ApiCollection>;
  async function read(kind: "environments", id: string): Promise<import("../core/models/types.js").Environment>;
  async function read(kind: "collections" | "environments", id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid identifier");
    const value = snapshot()[kind].find((value) => value.id === id);
    if (!value) throw new Error("Workspace resource not found");
    return value;
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
        const data = snapshot();
        return reply({ collections: data.collections.map((col) => ({ id: col.id, name: col.name, requests: collectionRequests(col).length })), truncated: false });
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
          executionOptions,
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
          .string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/)
          .default("GET"),
        headers: z.union([z.record(z.string(), z.string().max(8192)), z.array(z.object({key:z.string().max(8192),value:z.string().max(8192),enabled:z.boolean().optional()})).max(1000)]).optional(),
        bodyMode: z.enum(["raw-text","raw-json"]).default("raw-text"),
        schema: z.record(z.string(),z.unknown()).optional(),
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
        if(input.schema && (input.bodyMode!=="raw-json" || input.body===undefined))throw new Error("JSON Schema requires a raw-json body");
        const response = await HttpExecutor.execute(
          {
            method: input.method,
            url: input.url,
            headers: Array.isArray(input.headers) ? input.headers : Object.entries(input.headers || {}).map(
              ([key, value]) => ({ key, value, enabled: true }),
            ),
            queryParams: [],
            body:
              input.body === undefined
                ? { mode: "none" }
                : { mode: input.bodyMode, raw: input.body, schema:input.schema },
            auth: { type: "none" },
            maxResponseBytes: 1024 * 1024,
            timeoutMs: 30000,
          },
          [],
          [],
          { ...executionOptions, signal: extra.signal, secrets },
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
