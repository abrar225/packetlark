import { KeyValueParam } from '../models/types.js';

export class VariableResolver {
  /**
   * Replaces `{{variable}}` templates with values from active environments, collection variables, or dynamic generators.
   */
  public static resolve(text: string, context: Record<string, string>): string {
    if (!text || typeof text !== 'string') return text;

    let current = text;
    const maxDepth = 5;

    for (let depth = 0; depth < maxDepth; depth++) {
      let substituted = false;
      const next = current.replace(/\{\{\s*([a-zA-Z0-9_$.-]+)\s*\}\}/g, (match, rawKey) => {
        const key = rawKey.trim();

        // Dynamic variables
        if (key === '$guid' || key === '$uuid') {
          substituted = true;
          return crypto.randomUUID();
        }
        if (key === '$timestamp') {
          substituted = true;
          return Math.floor(Date.now() / 1000).toString();
        }
        if (key === '$isoTimestamp') {
          substituted = true;
          return new Date().toISOString();
        }
        if (key === '$randomInt') {
          substituted = true;
          return Math.floor(Math.random() * 1000).toString();
        }

        if (context && key in context) {
          substituted = true;
          return context[key];
        }
        return match;
      });

      if (next === current || !substituted) {
        break;
      }
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
    runtimeVars: Record<string, string> = {}
  ): Record<string, string> {
    const context: Record<string, string> = {};

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
