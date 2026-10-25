const reserved = new Set([
  "constructor",
  "request",
  "baseUrl",
  "options",
  "query",
  "body",
  "class",
  "default",
  "delete",
  "return",
  "function",
  "var",
  "let",
  "const",
  "new",
  "private",
  "public",
  "protected",
  "static",
  "interface",
  "type",
  "extends",
  "super",
  "this",
  "null",
  "true",
  "false",
  "await",
  "yield",
  "arguments",
  "eval",
]);
export class SdkGenerator {
  static sanitizeMethodName(raw: string): string {
    const parts = String(raw)
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean);
    if (!parts.length) return "requestOperation";
    let name =
      parts[0].toLowerCase() +
      parts
        .slice(1)
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join("");
    if (/^\d/.test(name)) name = "req" + name;
    return reserved.has(name) ? name + "Operation" : name;
  }
  private static type(
    schema: any,
    root: any,
    seen = new Set<string>(),
  ): string {
    if (!schema) return "unknown";
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return "unknown";
      const next = new Set(seen).add(schema.$ref);
      if (!schema.$ref.startsWith("#/")) return "unknown";
      let target = root;
      for (const part of schema.$ref.slice(2).split("/"))
        target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      return this.type(target, root, next);
    }
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.enum)
      return (
        schema.enum.map((value: any) => JSON.stringify(value)).join(" | ") ||
        "never"
      );
    if (schema.anyOf || schema.oneOf)
      return (schema.anyOf || schema.oneOf)
        .map((part: any) => this.type(part, root, seen))
        .join(" | ");
    if (Array.isArray(schema.type))
      return [
        ...new Set(
          schema.type.map((type: string) =>
            this.type({ ...schema, type }, root, seen),
          ),
        ),
      ].join(" | ");
    switch (schema.type) {
      case "null":
        return "null";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "string":
        return "string";
      case "array":
        return `(${this.type(schema.items, root, seen)})[]`;
      case "object": {
        const properties = Object.entries(schema.properties || {}).map(
          ([key, value]) =>
            `  ${/^[a-zA-Z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${this.type(value, root, seen)};`,
        );
        if (!properties.length) return "Record<string, unknown>";
        if (schema.additionalProperties)
          properties.push(`  [key: string]: unknown;`);
        return `{\n${properties.join("\n")}\n}`;
      }
      default:
        return "unknown";
    }
  }
  static generateTypeScript(spec: any): string {
    const rawTitle = String(spec.info?.title || "ApiClient").replace(
      /[^a-zA-Z0-9]/g,
      "",
    );
    const title = /^[A-Za-z]/.test(rawTitle) ? rawTitle : "Api" + rawTitle;
    const definitions = new Map<string, string>();
    const methods: string[] = [];
    const used = new Set<string>();
    const declare = (name: string, schema: any) => {
      let unique = name,
        index = 2;
      while (definitions.has(unique)) unique = name + index++;
      const type = this.type(schema, spec);
      definitions.set(
        unique,
        schema?.type === "object"
          ? `export interface ${unique} ${type}`
          : `export type ${unique} = ${type};`,
      );
      return unique;
    };
    const media = (content: any) =>
      Object.entries(content || {}).find(([type]) => type.includes("json")) ||
      Object.entries(content || {})[0];
    for (const [path, pathItem] of Object.entries<any>(spec.paths || {}))
      for (const [method, op] of Object.entries<any>(pathItem)) {
        if (
          ![
            "get",
            "post",
            "put",
            "patch",
            "delete",
            "head",
            "options",
          ].includes(method)
        )
          continue;
        const base = this.sanitizeMethodName(
            op.operationId || method + "_" + path,
          ),
          typeBase = base[0].toUpperCase() + base.slice(1);
        let name = base,
          n = 2;
        while (used.has(name)) name = base + n++;
        used.add(name);
        const args: string[] = [],
          aliases = new Map<string, string>();
        const argUsed = new Set(["options", "query", "body"]);
        const parameters = [
          ...(pathItem.parameters || []),
          ...(op.parameters || []),
        ];
        for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
          const raw = match[1];
          if (aliases.has(raw)) continue;
          let alias = this.sanitizeMethodName(raw);
          let count = 2;
          const initial = alias;
          while (argUsed.has(alias)) alias = initial + count++;
          argUsed.add(alias);
          aliases.set(raw, alias);
          args.push(`${alias}: string | number`);
        }
        const request = media(op.requestBody?.content);
        let bodyCode = "undefined",
          mime = "";
        if (request && !["get", "head"].includes(method)) {
          mime = request[0] as string;
          const bodyType = mime.includes("json")
            ? declare(typeBase + "Request", (request[1] as any).schema)
            : mime === "multipart/form-data"
              ? "FormData"
              : "string";
          args.push(
            `body${op.requestBody.required === false ? "?" : ""}: ${bodyType}`,
          );
          bodyCode = mime.includes("json")
            ? "body === undefined ? undefined : JSON.stringify(body)"
            : "body";
        }
        const hasQuery = parameters.some((p: any) => p.in === "query");
        if (hasQuery)
          args.push(
            "query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>",
          );
        args.push("options: RequestOptions = {}");
        const successful = Object.entries<any>(op.responses || {}).filter(
          ([status]) => /^2\d\d$/.test(status),
        );
        const types: string[] = [];
        if (method === "head") types.push("void");
        else
          for (const [status, response] of successful) {
            const responseMedia = media(response.content);
            if (status === "204" || !responseMedia) types.push("void");
            else if (String(responseMedia[0]).includes("json"))
              types.push(
                declare(
                  typeBase + "Response",
                  (responseMedia[1] as any).schema,
                ),
              );
            else
              types.push(
                String(responseMedia[0]).startsWith("text/") ||
                  String(responseMedia[0]).includes("xml")
                  ? "string"
                  : "ArrayBuffer",
              );
          }
        const returnType = types.length
          ? [...new Set(types)].join(" | ")
          : "unknown";
        const segments: string[] = [];
        let offset = 0;
        for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
          segments.push(JSON.stringify(path.slice(offset, match.index)));
          segments.push(`encodeURIComponent(String(${aliases.get(match[1])}))`);
          offset = match.index + match[0].length;
        }
        segments.push(JSON.stringify(path.slice(offset)));
        const server =
          op.servers?.[0]?.url ||
          pathItem.servers?.[0]?.url ||
          spec.servers?.[0]?.url ||
          "http://localhost";
        methods.push(
          `  public async ${name}(${args.join(", ")}): Promise<${returnType}> {\n    let path = ${segments.join(" + ")};\n${hasQuery ? `    const params = new URLSearchParams();\n    for (const [key, value] of Object.entries(query || {})) { if(value !== undefined) for(const part of Array.isArray(value) ? value : [value]) params.append(key, String(part)); }\n    if(params.size) path += '?' + params.toString();\n` : ""}    return this.request<${returnType}>(${JSON.stringify(server)}, path, { ...options, method: ${JSON.stringify(method.toUpperCase())}, body: ${bodyCode} }, ${JSON.stringify(mime === "multipart/form-data" ? "" : mime)});\n  }`,
        );
      }
    return `/** Generated from observed/schema data. Review types and server assumptions before use. */
export interface RequestOptions { headers?: Record<string, string>; token?: string; signal?: AbortSignal; baseUrl?: string; }
${[...definitions.values()].join("\n\n")}
export class ${title || "ApiClient"} {
  constructor(private baseUrl?: string) {}
  private async request<T>(server: string, path: string, options: RequestOptions & RequestInit, contentType: string): Promise<T> {
    const headers = new Headers(options.headers);
    if(contentType && options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', contentType);
    if(options.token) headers.set('Authorization', 'Bearer ' + options.token);
    const base = options.baseUrl || this.baseUrl || server;
    const response = await fetch(base.replace(/\\/+$/, '') + path, {method:options.method, body:options.body, signal:options.signal, headers});
    if(!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());
    if(response.status === 204 || options.method === 'HEAD') return undefined as T;
    const mime = response.headers.get('content-type') || '';
    if(mime.includes('json')) { const text = await response.text(); return (text ? JSON.parse(text) : undefined) as T; }
    if(mime.startsWith('text/') || mime.includes('xml') || !mime) return await response.text() as T;
    return await response.arrayBuffer() as T;
  }
${methods.join("\n\n")}
}
`;
  }
}
