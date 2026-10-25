import {
  getQuickJS,
  QuickJSContext,
  QuickJSDeferredPromise,
} from "quickjs-emscripten";
import { readFileSync } from "node:fs";
import type { TestAssertionResult, HttpRequest } from "../models/types.js";
const QuickJS = await getQuickJS();
const bootstrap = readFileSync(
  new URL("../../../sandbox/bootstrap.js", import.meta.url),
  "utf8",
);
export interface SandboxExecutionResult {
  updatedVariables: Record<string, string>;
  updatedEnvironment: Record<string, string>;
  updatedCollectionVariables: Record<string, string>;
  updatedGlobals: Record<string, string>;
  updatedLocalVariables: Record<string, string>;
  testResults: TestAssertionResult[];
  logs: string[];
  nextRequest?: string | null;
  skipRequest?: boolean;
  pending?: number;
}
export interface ResponseContext {
  code: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  responseTimeMs: number;
}
export interface SandboxOptions {
  environment?: Record<string, string>;
  collection?: Record<string, string>;
  globals?: Record<string, string>;
  local?: Record<string, string>;
  data?: Record<string, string>;
  info?: Record<string, any>;
  request?: HttpRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  sendRequest?: (request: any, signal: AbortSignal) => Promise<ResponseContext>;
}
function failure(
  variables: Record<string, string>,
  message: string,
  options: SandboxOptions = {},
): SandboxExecutionResult {
  return {
    updatedVariables: { ...variables },
    updatedEnvironment: { ...(options.environment ?? variables) },
    updatedCollectionVariables: { ...options.collection },
    updatedGlobals: { ...options.globals },
    updatedLocalVariables: { ...options.local },
    testResults: [{ name: "Script Execution", passed: false, error: message }],
    logs: [],
  };
}
function evaluate(context: QuickJSContext, source: string, decode = true) {
  const result = context.evalCode(source);
  try {
    if (result.error) {
      const error = context.dump(result.error);
      throw new Error(String(error?.message || error));
    }
    return decode
      ? context.dump("value" in result ? result.value : context.undefined)
      : undefined;
  } finally {
    result.dispose();
  }
}
function prepare(
  variables: Record<string, string>,
  response: ResponseContext | undefined,
  options: SandboxOptions,
) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + (options.timeoutMs || 2000);
  runtime.setInterruptHandler(
    () => Date.now() > deadline || !!options.signal?.aborted,
  );
  const context = runtime.newContext();
  const input = {
    environment: options.environment ?? variables,
    collection: options.collection || {},
    globals: options.globals || {},
    local: options.local || {},
    data: options.data || {},
    info: options.info,
    request: options.request,
    response,
  };
  try {
    evaluate(context, bootstrap);
    evaluate(context, `__reaBootstrap(${JSON.stringify(input)})`);
  } catch (error) {
    context.dispose();
    runtime.dispose();
    throw error;
  }
  return { context, runtime, deadline };
}
export class ScriptSandbox {
  static execute(
    script: string,
    variables: Record<string, string>,
    response?: ResponseContext,
    options: SandboxOptions = {},
  ): SandboxExecutionResult {
    if (script.length > 1024 * 1024)
      return failure(variables, "Script exceeds the 1 MiB limit", options);
    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare(variables, response, options);
    } catch (error) {
      return failure(variables, error.message, options);
    }
    const { context, runtime } = prepared;
    try {
      try {
        evaluate(context, script, false);
      } catch (error) {
        evaluate(
          context,
          `__reaRecordError('Script Execution',${JSON.stringify(error.message)})`,
        );
      }
      const jobs = runtime.executePendingJobs();
      try {
        if (jobs.error) throw new Error("Unhandled script promise rejection");
      } finally {
        jobs.dispose();
      }
      const result = JSON.parse(
        evaluate(context, "JSON.stringify(__reaResult())"),
      );
      if (result.pending)
        result.testResults.push({
          name: "Script Execution",
          passed: false,
          error: "Async APIs require executeAsync",
        });
      return result;
    } catch (error) {
      return failure(variables, error.message, options);
    } finally {
      context.dispose();
      runtime.dispose();
    }
  }
  static async executeAsync(
    script: string,
    variables: Record<string, string>,
    response?: ResponseContext,
    options: SandboxOptions = {},
  ): Promise<SandboxExecutionResult> {
    if (script.length > 1024 * 1024)
      return failure(variables, "Script exceeds the 1 MiB limit", options);
    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare(variables, response, options);
    } catch (error) {
      return failure(variables, error.message, options);
    }
    const { context, runtime, deadline } = prepared;
    let active = true;
    let requests = 0;
    let operations = 0;
    const deferreds: QuickJSDeferredPromise[] = [];
    const hostTasks = new Set<Promise<any>>();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const bridge = context.newFunction("__reaAsyncBridge", (argument) => {
      if (++operations > 100)
        throw new Error("Maximum 100 async operations per script");
      const deferred = context.newPromise();
      deferreds.push(deferred);
      const action = JSON.parse(context.getString(argument));
      const task = (async () => {
        if (action.kind === "sleep") {
          const delay = Number(action.ms);
          if (
            !Number.isFinite(delay) ||
            delay < 0 ||
            delay > Math.max(0, deadline - Date.now())
          )
            throw new Error("Timer exceeds script timeout");
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              controller.signal.removeEventListener("abort", abort);
              resolve();
            }, delay);
            const abort = () => {
              clearTimeout(timer);
              reject(new Error("Cancelled"));
            };
            controller.signal.addEventListener("abort", abort, { once: true });
          });
          return null;
        }
        if (action.kind === "request" && options.sendRequest) {
          if (++requests > 20) throw new Error("Maximum 20 script requests");
          return options.sendRequest(action.request, controller.signal);
        }
        throw new Error("Script API is not available");
      })().then(
        (value) => {
          if (!active) return;
          const handle = context.newString(JSON.stringify(value));
          deferred.resolve(handle);
          handle.dispose();
        },
        (error) => {
          if (!active) return;
          const handle = context.newError(String(error.message || error));
          deferred.reject(handle);
          handle.dispose();
        },
      );
      hostTasks.add(task);
      task.finally(() => hostTasks.delete(task));
      return deferred.handle;
    });
    context.setProp(context.global, "__reaAsyncBridge", bridge);
    bridge.dispose();
    try {
      try {
        evaluate(context, script, false);
      } catch (error) {
        evaluate(
          context,
          `__reaRecordError('Script Execution',${JSON.stringify(error.message)})`,
        );
      }
      while (true) {
        if (Date.now() > deadline || options.signal?.aborted)
          throw new Error(
            options.signal?.aborted
              ? "Script cancelled"
              : "Script execution timed out",
          );
        const jobs = runtime.executePendingJobs(100);
        try {
          if (jobs.error) throw new Error("Unhandled promise rejection");
        } finally {
          jobs.dispose();
        }
        const result = JSON.parse(
          evaluate(context, "JSON.stringify(__reaResult())"),
        );
        if (!result.pending && !hostTasks.size && !runtime.hasPendingJob())
          return result;
        if (hostTasks.size)
          await Promise.race([
            ...hostTasks,
            new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(10, Math.max(1, deadline - Date.now())),
              ),
            ),
          ]);
        else await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } catch (error) {
      return failure(variables, error.message, options);
    } finally {
      active = false;
      controller.abort();
      options.signal?.removeEventListener("abort", cancel);
      for (const deferred of deferreds) deferred.dispose();
      context.dispose();
      runtime.dispose();
    }
  }
}
