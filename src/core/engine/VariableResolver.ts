import { BodyBudgetError } from "./BodyBudget.js";
import { KeyValueParam } from "../models/types.js";

export class VariableResolver {
  /**
   * Replaces `{{variable}}` templates with values from active environments, collection variables, or dynamic generators.
   */
  public static resolve(
    text: string,
    context: Record<string, string>,
    maxBytes = 4 * 1024 * 1024,
  ): string {
    if (!text || typeof text !== "string") return text;
    const limit = () =>
      new BodyBudgetError(
        "Resolved request field exceeds its byte/substitution budget",
        "ERR_REQUEST_LIMIT",
        413,
      );
    if (Buffer.byteLength(text) > maxBytes) throw limit();
    let current = text;
    for (let depth = 0; depth < 5; depth++) {
      const parts: string[] = [];
      let size = 0,
        cursor = 0,
        count = 0,
        substituted = false;
      const append = (value: string) => {
        size += Buffer.byteLength(value);
        if (size > maxBytes) throw limit();
        parts.push(value);
      };
      for (const match of current.matchAll(
        /\{\{\s*([a-zA-Z0-9_$.-]+)\s*\}\}/g,
      )) {
        if (++count > 10000) throw limit();
        append(current.slice(cursor, match.index));
        const key = match[1].trim();
        let value: string;
        if (key === "$guid" || key === "$uuid") value = crypto.randomUUID();
        else if (key === "$timestamp")
          value = Math.floor(Date.now() / 1000).toString();
        else if (key === "$isoTimestamp") value = new Date().toISOString();
        else if (key === "$randomInt")
          value = Math.floor(Math.random() * 1000).toString();
        else if (context && Object.hasOwn(context, key))
          value = String(context[key]);
        else value = match[0];
        substituted ||= value !== match[0];
        append(value);
        cursor = match.index + match[0].length;
      }
      append(current.slice(cursor));
      const next = parts.join("");
      if (next === current || !substituted) break;
      current = next;
    }
    return current;
  }

  /**
   * Combines variables into a single key-value context map.
   */
  public static buildContext(
    collectionVars: KeyValueParam[] = [],
    envVars: KeyValueParam[] = [],
    runtimeVars: Record<string, string> = {},
  ): Record<string, string> {
    const context: Record<string, string> = Object.create(null);

    // 1. Collection variables (lowest precedence)
    for (const v of collectionVars) {
      if (v.enabled !== false && v.key) {
        context[v.key] = v.value;
      }
    }

    // 2. Environment variables
    for (const v of envVars) {
      if (v.enabled !== false && v.key) {
        context[v.key] = v.value;
      }
    }

    // 3. Runtime variables from scripts (highest precedence)
    Object.assign(context, runtimeVars);

    return context;
  }
}
