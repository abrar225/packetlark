import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseJsonDocument } from "./core/models/JsonDocument.js";
import { StudioServer } from "./server/StudioServer.js";
import { WorkspaceLease } from "./core/workspace/WorkspaceLease.js";
import { PostmanConverter } from "./core/models/PostmanConverter.js";
import {
  CollectionRunner,
  junitReport,
  reportWithoutBodies,
} from "./core/runner/CollectionRunner.js";
import { parseCsv } from "./core/runner/DataFile.js";
import type { ApiCollection } from "./core/models/types.js";
async function readDocument(file: string) {
  if ((await stat(file)).size > 2 * 1024 * 1024)
    throw new Error("Input file exceeds 2 MiB");
  return readFile(file, "utf8");
}
export async function main(args: string[]): Promise<number> {
  if (args[0] === "workspace") {
    if (!["status", "recover"].includes(args[1]))
      throw new Error("Use workspace status or workspace recover");
    args = [`workspace-${args[1]}`, ...args.slice(2)];
  }
  const command = args[0] || "studio";
  if (["--help", "-h", "help"].includes(command)) {
    console.log(
      `Rea API Studio\n\nrea-api studio [--port 4040] [--sniffer-port 8085] [--workspace directory]\nrea-api run collection.json [--environment env.json] [--data rows.json|rows.csv]\n  [--iterations count] [--folder name-or-request-id] [--timeout milliseconds]\n  [--bail] [--reporter cli|json|junit] [--report-file path]\nrea-api mcp --workspace directory\nrea-api workspace status --workspace directory\nrea-api workspace recover --workspace directory --token reviewed-owner-token\n\nRuns imported scripts in the bounded interpreter. Run only collections whose network behavior you trust.\nJSON/JUnit reports omit bodies, headers and environment values by default.`,
    );
    return 0;
  }
  const flags: Record<string, string | boolean> = {};
  let file: string | undefined;
  const valued = new Set([
    "port",
    "sniffer-port",
    "workspace",
    "environment",
    "data",
    "iterations",
    "folder",
    "timeout",
    "reporter",
    "report-file",
    "token",
  ]);
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (token === "--bail") flags.bail = true;
    else if (token.startsWith("--") && valued.has(token.slice(2))) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${token}`);
      flags[token.slice(2)] = value;
    } else if (!token.startsWith("-") && !file) file = token;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  const allowed: Record<string, string[]> = {
    "workspace-status": ["workspace"],
    "workspace-recover": ["workspace", "token"],
    studio: ["port", "sniffer-port", "workspace"],
    mcp: ["workspace"],
    run: [
      "environment",
      "data",
      "iterations",
      "folder",
      "timeout",
      "bail",
      "reporter",
      "report-file",
    ],
  };
  if (!allowed[command]) throw new Error(`Unknown command ${command}`);
  for (const key of Object.keys(flags))
    if (!allowed[command].includes(key))
      throw new Error(`--${key} is not valid for ${command}`);
  if (file && command !== "run")
    throw new Error(`${command} does not accept a positional file`);
  const reporter = String(flags.reporter || "cli");
  if (!["cli", "json", "junit"].includes(reporter))
    throw new Error("Reporter must be cli, json, or junit");
  if (
    flags.timeout &&
    (!Number.isInteger(Number(flags.timeout)) ||
      Number(flags.timeout) < 1 ||
      Number(flags.timeout) > 300000)
  )
    throw new Error("Timeout must be 1–300000 ms");
  if (command === "workspace-status") {
    console.log(
      JSON.stringify(
        WorkspaceLease.inspect(
          path.resolve(String(flags.workspace || process.cwd()), ".rea-api"),
        ),
      ),
    );
    return 0;
  }
  if (command === "workspace-recover") {
    console.log(
      JSON.stringify(
        WorkspaceLease.recover(
          path.resolve(String(flags.workspace || process.cwd()), ".rea-api"),
          flags.token as string,
        ),
      ),
    );
    return 0;
  }
  if (command === "studio") {
    const port = Number(flags.port ?? process.env.PORT ?? 4040),
      sniffer = Number(
        flags["sniffer-port"] ?? process.env.SNIFFER_PORT ?? 8085,
      );
    for (const value of [port, sniffer])
      if (!Number.isInteger(value) || value < 0 || value > 65535)
        throw new Error("Ports must be between 0 and 65535");
    const workspace = path.resolve(
      String(flags.workspace || process.cwd()),
      ".rea-api",
    );
    let server: StudioServer;
    const shutdown = async () => {
      try {
        await server?.stop();
        process.exit(0);
      } catch (error) {
        console.error("Rea: " + error.message);
        process.exit(2);
      }
    };
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of signals) process.once(signal, shutdown);
    try {
      server = new StudioServer(port, sniffer, workspace);
      const actual = await server.start();
      console.log(`Rea API Studio: http://127.0.0.1:${actual}/studio`);
      return 0;
    } catch (error) {
      for (const signal of signals) process.removeListener(signal, shutdown);
      throw error;
    }
  }
  if (command === "mcp") {
    const { startMcp } = await import("./integrations/mcp.js");
    await startMcp(path.resolve(String(flags.workspace || process.cwd())));
    return 0;
  }
  if (command !== "run") throw new Error(`Unknown command ${command}`);
  if (!file) throw new Error("Specify a collection JSON file");
  const source = parseJsonDocument(await readDocument(file), "collection");
  const collection: ApiCollection = Array.isArray(source.items)
    ? source
    : PostmanConverter.fromPostman(source);
  const environment = flags.environment
    ? parseJsonDocument(
        await readDocument(String(flags.environment)),
        "environment",
      )
    : undefined;
  let data;
  if (flags.data) {
    const content = await readDocument(String(flags.data));
    data = String(flags.data).toLowerCase().endsWith(".csv")
      ? parseCsv(content)
      : parseJsonDocument(content, "data");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await CollectionRunner.run(collection, {
      environment,
      data,
      iterations: flags.iterations ? Number(flags.iterations) : undefined,
      folder: flags.folder ? String(flags.folder) : undefined,
      timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
      stopOnFailure: !!flags.bail,
      signal: controller.signal,
    });
    const filtered = reportWithoutBodies(result);
    let output: string;
    if (reporter === "json") output = JSON.stringify(filtered, null, 2);
    else if (reporter === "junit") output = junitReport(result);
    else if (reporter === "cli")
      output = `${result.status.toUpperCase()}: ${result.summary.requests} requests, ${result.summary.passed} assertions passed, ${result.summary.failed} failed, ${result.summary.errors} errors${filtered.error ? "\n" + filtered.error : ""}`;
    else throw new Error("Reporter must be cli, json, or junit");
    if (flags["report-file"])
      await writeFile(String(flags["report-file"]), output + "\n");
    else console.log(output);
    return result.status === "cancelled"
      ? 130
      : result.status === "passed"
        ? 0
        : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
