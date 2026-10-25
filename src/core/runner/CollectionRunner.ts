import { CookieJar } from "tough-cookie";
import { SecretRedactor } from "../security/SecretRedactor.js";
const reportSecrets = new WeakMap<RunResult, SecretRedactor>();
import { ApiCollection, Environment, HttpResponse } from "../models/types.js";
import { collectionRequests } from "../models/CollectionContext.js";
import { HttpExecutor } from "../engine/HttpExecutor.js";
export interface RunOptions {
  environment?: Environment;
  data?: Record<string, any>[];
  iterations?: number;
  folder?: string;
  delayMs?: number;
  timeoutMs?: number;
  stopOnFailure?: boolean;
  maxRequests?: number;
  maxResultBytes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: {
    completed: number;
    iteration: number;
    name: string;
  }) => void;
}
export interface RunExecution {
  name: string;
  requestId: string;
  iteration: number;
  path: string[];
  response: HttpResponse;
}
export interface RunResult {
  id: string;
  status: "passed" | "failed" | "cancelled";
  startedAt: string;
  durationMs: number;
  executions: RunExecution[];
  summary: {
    requests: number;
    assertions: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
  };
  environment: Environment;
  collectionVariables: Record<string, string>;
  error?: string;
  retention?: {
    maxBytes: number;
    retainedBytes: number;
    stopped: boolean;
    omittedExecutions: number;
    stateOmitted: boolean;
  };
}
export class CollectionRunner {
  static async run(
    collection: ApiCollection,
    options: RunOptions = {},
  ): Promise<RunResult> {
    let items = collectionRequests(collection);
    if (options.folder) {
      const matching = items.filter(
        (i) =>
          i.path.slice(1, -1).includes(options.folder) ||
          i.request.id === options.folder,
      );
      if (!matching.length) throw new Error("Folder/request was not found");
      items = matching;
    }
    if (!items.length) throw new Error("Collection has no runnable requests");
    const data = options.data || [{}];
    if (
      !Array.isArray(data) ||
      !data.length ||
      data.length > 1000 ||
      data.some((row) => !row || Array.isArray(row) || typeof row !== "object")
    )
      throw new Error("Data must contain 1–1000 object rows");
    const iterations = options.iterations ?? data.length;
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000)
      throw new Error("Iterations must be between 1 and 1000");
    const maxRequests = options.maxRequests ?? 1000;
    if (
      !Number.isInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > 10000
    )
      throw new Error("Request budget must be between 1 and 10000");
    const delay = options.delayMs ?? 0;
    if (!Number.isInteger(delay) || delay < 0 || delay > 30000)
      throw new Error("Delay must be between 0 and 30000 ms");
    const maxResultBytes = options.maxResultBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxResultBytes) ||
      maxResultBytes < 16 * 1024 ||
      maxResultBytes > 16 * 1024 * 1024
    )
      throw new Error("Run result budget must be between 16 KiB and 16 MiB");
    const started = Date.now();
    const result: RunResult = {
      id: crypto.randomUUID(),
      status: "passed",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      executions: [],
      summary: {
        requests: 0,
        assertions: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        skipped: 0,
      },
      environment: structuredClone(
        options.environment || {
          id: "run",
          name: "Run environment",
          values: [],
        },
      ),
      retention: {
        maxBytes: maxResultBytes,
        retainedBytes: 0,
        stopped: false,
        omittedExecutions: 0,
        stateOmitted: false,
      },
      collectionVariables: Object.fromEntries(
        collection.variables
          .filter((v) => v.enabled !== false)
          .map((v) => [v.key, v.value]),
      ),
    };
    const secrets = new SecretRedactor();
    secrets.observeParameters(result.environment.values);
    secrets.observeParameters(collection.variables);
    reportSecrets.set(result, secrets);
    const jar = new CookieJar();
    let local = {},
      globals = {};
    let retainedBytes = 0;
    let executionBytes = 0;
    const serializedBytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value));
    const resultBytes = (extra?: RunExecution) =>
      serializedBytes({ ...result, executions: [] }) +
      executionBytes +
      (extra ? serializedBytes(extra) : 0) +
      Math.max(0, result.executions.length + (extra ? 1 : 0) - 1);
    const updateRetainedBytes = () => {
      for (let i = 0; i < 3; i++)
        result.retention.retainedBytes = resultBytes();
    };
    const stopForRetention = (execution?: RunExecution) => {
      result.status = "failed";
      result.error =
        "Run result retention budget reached; execution stopped. Previously sent requests must not be retried automatically.";
      result.retention.stopped = true;
      result.retention.stateOmitted = true;
      result.environment = {
        id: String(result.environment.id).slice(0, 200),
        name: String(result.environment.name).slice(0, 128),
        values: [],
      };
      result.collectionVariables = {};
      if (execution) {
        const response = execution.response;
        const omitted: RunExecution = {
          name: execution.name.slice(0, 256),
          requestId: execution.requestId.slice(0, 200),
          iteration: execution.iteration,
          path: execution.path.slice(0, 8).map((part) => part.slice(0, 64)),
          response: {
            status: response.status,
            statusText: response.statusText.slice(0, 64),
            timings: response.timings,
            sizeBytes: response.sizeBytes,
            headers: {},
            body: "[Details omitted: run result retention budget]",
            testResults: [],
            skipRequest: response.skipRequest,
          },
        };
        result.executions.push(omitted);
        executionBytes += serializedBytes(omitted);
        result.retention.omittedExecutions++;
      }
    };
    const mutations = new Map<string, string | undefined>();
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);
    if (resultBytes() > maxResultBytes - 4096) {
      stopForRetention();
      result.durationMs = Date.now() - started;
      updateRetainedBytes();
      return result;
    }
    try {
      outer: for (let iteration = 0; iteration < iterations; iteration++) {
        for (let index = 0; index < items.length; index++) {
          signal.throwIfAborted();
          if (result.executions.length >= maxRequests)
            throw new Error(
              `Run exceeded its ${maxRequests} request budget; possible request-chain loop`,
            );
          if (delay)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
              }, delay);
              const abort = () => {
                clearTimeout(timer);
                reject(new Error("Run cancelled"));
              };
              signal.addEventListener("abort", abort, { once: true });
            });
          const item = items[index];
          const variables = item.variables
            .filter(
              (v) =>
                !mutations.has(v.key) || mutations.get(v.key) !== undefined,
            )
            .map((v) => ({
              ...v,
              value: mutations.has(v.key) ? mutations.get(v.key) : v.value,
            }));
          for (const [key, value] of mutations)
            if (value !== undefined && !variables.some((v) => v.key === key))
              variables.push({ key, value, enabled: true });
          const response = await HttpExecutor.execute(
            {
              ...item.request,
              timeoutMs: options.timeoutMs ?? item.request.timeoutMs,
            },
            variables,
            result.environment.values,
            {
              signal,
              cookieJar: jar,
              secrets,
              localVariables: local,
              globals,
              iterationData: Object.fromEntries(
                Object.entries(data[iteration % data.length]).map(([k, v]) => [
                  k,
                  String(v),
                ]),
              ),
              info: {
                iteration,
                iterationCount: iterations,
                requestId: item.request.id,
                requestName: item.request.name,
                eventName: "request",
              },
            },
          );
          local = response.updatedLocalVariables || local;
          globals = response.updatedGlobals || globals;
          for (const [key, value] of Object.entries(
            response.updatedCollectionVariables || {},
          )) {
            if (value !== variables.find((v) => v.key === key)?.value) {
              result.collectionVariables[key] = value;
              mutations.set(key, value);
            }
          }
          for (const variable of variables)
            if (
              response.updatedCollectionVariables &&
              !(variable.key in response.updatedCollectionVariables)
            ) {
              delete result.collectionVariables[variable.key];
              mutations.set(variable.key, undefined);
            }
          const responseBytes =
            Buffer.byteLength(response.body || "") +
            Buffer.byteLength(response.bodyBase64 || "");
          if (
            responseBytes > 256 * 1024 ||
            retainedBytes + responseBytes > 16 * 1024 * 1024
          ) {
            response.body =
              "[Response omitted from run history: retention limit]";
            delete response.bodyBase64;
          } else retainedBytes += responseBytes;
          const old = new Map(result.environment.values.map((v) => [v.key, v]));
          result.environment.values = [
            ...result.environment.values.filter(
              (v) =>
                v.enabled === false &&
                !Object.hasOwn(response.updatedEnvironment || {}, v.key),
            ),
            ...Object.entries(response.updatedEnvironment || {}).map(
              ([key, value]) => ({
                ...old.get(key),
                key,
                value,
                enabled: old.get(key)?.enabled !== false,
              }),
            ),
          ];
          // Scope snapshots have already updated the run-local state; never duplicate them in every history entry.
          delete response.updatedVariables;
          delete response.updatedEnvironment;
          delete response.updatedCollectionVariables;
          delete response.updatedGlobals;
          delete response.updatedLocalVariables;
          const execution: RunExecution = {
            name: item.request.name || item.request.url,
            requestId: item.request.id || "",
            iteration,
            path: item.path,
            response,
          };
          const tests = response.testResults || [];
          result.summary.requests++;
          result.summary.assertions += tests.length;
          result.summary.passed += tests.filter((t) => t.passed).length;
          result.summary.failed += tests.filter((t) => !t.passed).length;
          if (response.skipRequest) result.summary.skipped++;
          else if (response.error || response.status === 0)
            result.summary.errors++;
          if (resultBytes(execution) > maxResultBytes - 4096) {
            stopForRetention(execution);
            break outer;
          }
          result.executions.push(execution);
          executionBytes += serializedBytes(execution);
          options.onProgress?.(
            secrets.redact({
              completed: result.executions.length,
              iteration,
              name: item.request.name || item.request.url,
            }),
          );
          if (
            options.stopOnFailure &&
            (response.error || tests.some((t) => !t.passed))
          )
            break outer;
          if (response.nextRequest === null) break;
          if (response.nextRequest !== undefined) {
            const matching = items
              .map((next, i) => ({ next, i }))
              .filter(
                ({ next }) =>
                  next.request.id === response.nextRequest ||
                  next.request.name === response.nextRequest,
              );
            if (matching.length !== 1)
              throw new Error(
                "setNextRequest must identify exactly one request by ID or name",
              );
            index = matching[0].i - 1;
          }
        }
      }
    } catch (error) {
      result.error = error.message;
      result.status = options.signal?.aborted ? "cancelled" : "failed";
    }
    if (signal.aborted && options.signal?.aborted) result.status = "cancelled";
    if (
      result.status === "passed" &&
      (result.summary.errors || result.summary.failed)
    )
      result.status = "failed";
    result.durationMs = Date.now() - started;
    updateRetainedBytes();
    return result;
  }
}
const xml = (value: any) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
export function junitReport(result: RunResult): string {
  result = reportWithoutBodies(result) as RunResult;
  const cases = result.executions.flatMap((execution) => {
    const tests = execution.response.testResults || [];
    const prefix = `${execution.path.join("/")} [iteration ${execution.iteration + 1}]`;
    const rows = tests.map(
      (test) =>
        `<testcase name="${xml(prefix + ": " + test.name)}">${test.passed ? "" : `<failure message="${xml(test.error || "Assertion failed")}"/>`}</testcase>`,
    );
    if (execution.response.error)
      rows.push(
        `<testcase name="${xml(prefix)}"><error message="${xml(execution.response.error.message)}"/></testcase>`,
      );
    if (execution.response.skipRequest)
      rows.push(`<testcase name="${xml(prefix)}"><skipped/></testcase>`);
    if (!rows.length) rows.push(`<testcase name="${xml(prefix)}"/>`);
    return rows;
  });
  if (result.error)
    cases.push(
      `<testcase name="Run execution"><error message="${xml(result.error)}"/></testcase>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="Rea API Studio" tests="${cases.length}" failures="${result.summary.failed}" errors="${result.summary.errors + (result.error ? 1 : 0)}" skipped="${result.summary.skipped}" time="${result.durationMs / 1000}">${cases.join("")}</testsuite></testsuites>`;
}
export function reportWithoutBodies(result: RunResult) {
  const report = {
    ...result,
    environment: undefined,
    collectionVariables: undefined,
    executions: result.executions.map((e) => ({
      ...e,
      response: {
        status: e.response.status,
        statusText: e.response.statusText,
        timings: e.response.timings,
        sizeBytes: e.response.sizeBytes,
        testResults: e.response.testResults,
        error: e.response.error,
        skipRequest: e.response.skipRequest,
        transportAttempted: e.response.transportAttempted,
      },
    })),
  };
  const filtered = reportSecrets.get(result)?.redact(report) || report;
  // These fields are generated by the host, not script text; preserve their schema.
  filtered.id = result.id;
  filtered.status = result.status;
  filtered.startedAt = result.startedAt;
  const byteLength = () => Buffer.byteLength(JSON.stringify(filtered));
  const maxBytes = result.retention?.maxBytes ?? 16 * 1024 * 1024;
  if (byteLength() > maxBytes - 256) {
    filtered.status = "failed";
    filtered.error =
      "Sanitized report exceeded its retention budget; details withheld. Previously attempted requests must not be retried automatically.";
    filtered.retention = {
      maxBytes,
      retainedBytes: 0,
      stopped: true,
      omittedExecutions: result.executions.length,
      stateOmitted: true,
    };
    filtered.executions = [];
  }
  if (filtered.retention)
    for (let i = 0; i < 3; i++) filtered.retention.retainedBytes = byteLength();
  return filtered;
}

export type RunReport = ReturnType<typeof reportWithoutBodies>;
