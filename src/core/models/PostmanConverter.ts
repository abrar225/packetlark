import {
  ApiCollection,
  CollectionItem,
  HttpRequest,
  HttpMethod,
  KeyValueParam,
  AuthConfig,
  RequestBody,
} from "./types.js";
const string = (value: any) => (value == null ? "" : String(value));
const variables = (values: any[]) =>
  (values || []).map((v) => ({
    key: string(v.key),
    value: string(v.value),
    enabled: v.disabled !== true,
    description: v.description,
    secret: v.type === "secret",
  }));
const events = (source: any, type: string) =>
  (source.event || [])
    .filter((e) => e.listen === type && e.disabled !== true)
    .map((e) =>
      Array.isArray(e.script?.exec)
        ? e.script.exec.join("\n")
        : e.script?.exec || "",
    )
    .join("\n");
function authFrom(source: any, warnings: string[]): AuthConfig {
  if (!source) return { type: "inherit" };
  const get = (key: string) =>
    string((source[source.type] || []).find((p) => p.key === key)?.value);
  switch (source.type) {
    case "noauth":
      return { type: "none" };
    case "bearer":
      return { type: "bearer", bearerToken: get("token") };
    case "basic":
      return {
        type: "basic",
        basicUsername: get("username"),
        basicPassword: get("password"),
      };
    case "apikey":
      return {
        type: "apikey",
        apiKeyName: get("key"),
        apiKeyValue: get("value"),
        apiKeyIn: get("in") === "query" ? "query" : "header",
      };
    default:
      warnings.push(
        `Unsupported authentication: ${source.type}. Preserved for export; execution is blocked.`,
      );
      return {
        type: "unsupported",
        originalType: source.type,
        postman: structuredClone(source),
      };
  }
}
function authTo(auth?: AuthConfig): any {
  if (!auth || auth.type === "inherit") return undefined;
  if (auth.type === "unsupported") return auth.postman;
  if (auth.type === "none") return { type: "noauth" };
  const pairs =
    auth.type === "bearer"
      ? [["token", auth.bearerToken]]
      : auth.type === "basic"
        ? [
            ["username", auth.basicUsername],
            ["password", auth.basicPassword],
          ]
        : [
            ["key", auth.apiKeyName],
            ["value", auth.apiKeyValue],
            ["in", auth.apiKeyIn || "header"],
          ];
  return {
    type: auth.type,
    [auth.type]: pairs.map(([key, value]) => ({
      key,
      value: value || "",
      type: "string",
    })),
  };
}
export class PostmanConverter {
  static fromPostman(source: any): ApiCollection {
    if (!source || typeof source !== "object" || !Array.isArray(source.item))
      throw new Error("Expected a Postman v2.1 collection with an item array");
    if (source.info?.schema && !source.info.schema.includes("/v2.1.0/"))
      throw new Error(
        "Only Postman Collection v2.1 JSON is supported. Export v2.1 before importing.",
      );
    const warnings: string[] = [];
    const convert = (item: any): CollectionItem => {
      const id = /^[a-zA-Z0-9_-]{1,200}$/.test(string(item.id))
        ? string(item.id)
        : crypto.randomUUID();
      const name = string(item.name) || "Untitled";
      const base = {
        id,
        name,
        description:
          typeof item.description === "string"
            ? item.description
            : item.description?.content,
        postman: structuredClone(item),
      };
      if (Array.isArray(item.item) && !item.request)
        return {
          ...base,
          isFolder: true,
          auth: authFrom(item.auth, warnings),
          variables: variables(item.variable),
          preRequestScript: events(item, "prerequest"),
          testScript: events(item, "test"),
          items: item.item.map(convert),
        };
      const req =
        typeof item.request === "string"
          ? { url: item.request }
          : item.request || {};
      let urlRaw = typeof req.url === "string" ? req.url : string(req.url?.raw);
      if (!urlRaw && req.url?.host) {
        const protocol = req.url.protocol || "https";
        const host = Array.isArray(req.url.host)
          ? req.url.host.join(".")
          : req.url.host;
        const path = Array.isArray(req.url.path)
          ? req.url.path.join("/")
          : req.url.path || "";
        urlRaw = `${protocol}://${host}${req.url.port ? ":" + req.url.port : ""}/${path}`;
      }
      const hashIndex = urlRaw.indexOf("#");
      const hash = hashIndex < 0 ? "" : urlRaw.slice(hashIndex);
      const withoutHash = hashIndex < 0 ? urlRaw : urlRaw.slice(0, hashIndex);
      const question = withoutHash.indexOf("?");
      const rawQuery = question < 0 ? "" : withoutHash.slice(question + 1);
      const params = Array.isArray(req.url?.query)
        ? variables(req.url.query)
        : [...new URLSearchParams(rawQuery)].map(([key, value]) => ({
            key,
            value,
            enabled: true,
          }));
      if (Array.isArray(req.url?.query) && rawQuery) {
        const enabled = params
          .filter((p) => p.enabled)
          .map((p) => [p.key, p.value]);
        if (
          JSON.stringify([...new URLSearchParams(rawQuery)]) !==
          JSON.stringify(enabled)
        )
          warnings.push(
            `${name}: structured query parameters take precedence over url.raw.`,
          );
      }
      const url =
        (question < 0 ? withoutHash : withoutHash.slice(0, question)) + hash;
      const body: RequestBody = { mode: "none" };
      if (req.body?.mode === "raw") {
        body.mode =
          req.body.options?.raw?.language === "json" ||
          (!req.body.options?.raw?.language &&
            /^\s*[\[{]/.test(req.body.raw || ""))
            ? "raw-json"
            : "raw-text";
        body.raw = string(req.body.raw);
      } else if (req.body?.mode === "urlencoded") {
        body.mode = "x-www-form-urlencoded";
        body.formData = variables(req.body.urlencoded);
      } else if (
        req.body?.mode === "formdata" &&
        !(req.body.formdata || []).some((p) => p.type === "file")
      ) {
        body.mode = "form-data";
        body.formData = variables(req.body.formdata);
      } else if (req.body?.mode) {
        body.mode = "unsupported";
        body.postman = structuredClone(req.body);
        warnings.push(
          `${name}: unsupported ${req.body.mode} body preserved; execution is blocked.`,
        );
      }
      const request: HttpRequest = {
        id,
        name,
        method: (req.method || "GET").toUpperCase() as HttpMethod,
        url,
        queryParams: params,
        headers: variables(req.header),
        body,
        auth: authFrom(req.auth, warnings),
        preRequestScript: events(item, "prerequest"),
        testScript: events(item, "test"),
        postman: structuredClone(req),
      };
      return { ...base, isFolder: false, request };
    };
    const auth = authFrom(source.auth, warnings);
    const items = source.item.map(convert);
    return {
      id: /^[a-zA-Z0-9_-]{1,200}$/.test(
        string(source.info?._postman_id || source.info?.id),
      )
        ? string(source.info?._postman_id || source.info?.id)
        : crypto.randomUUID(),
      name: source.info?.name || "Imported collection",
      description:
        typeof source.info?.description === "string"
          ? source.info.description
          : source.info?.description?.content || "",
      schemaVersion: "2.1.0",
      variables: variables(source.variable),
      auth,
      preRequestScript: events(source, "prerequest"),
      testScript: events(source, "test"),
      items,
      postman: structuredClone(source),
      importWarnings: [...new Set(warnings)],
    };
  }
  static toPostman(collection: ApiCollection): any {
    const encode = (s: string) =>
      encodeURIComponent(s).replace(/%7B/g, "{").replace(/%7D/g, "}");
    const vars = (values: KeyValueParam[]) =>
      values.map((v) => ({
        key: v.key,
        value: v.value,
        disabled: v.enabled === false,
        type: v.secret ? "secret" : "string",
        description: v.description,
      }));
    const event = (source: any, base: any) => {
      const other = (base.event || []).filter(
        (e) => !["prerequest", "test"].includes(e.listen),
      );
      return [
        ...other,
        ...[
          ["prerequest", source.preRequestScript],
          ["test", source.testScript],
        ]
          .filter(([, code]) => code)
          .map(([listen, code]) => ({
            listen,
            script: { type: "text/javascript", exec: code.split("\n") },
          })),
      ];
    };
    const convert = (item: CollectionItem): any => {
      const base = structuredClone(item.postman || {});
      if (item.isFolder)
        return {
          ...base,
          id: item.id,
          name: item.name,
          item: (item.items || []).map(convert),
          auth: authTo(item.auth),
          variable: vars(item.variables || []),
          event: event(item, base),
        };
      const req = item.request;
      if (!req) throw new Error("Collection item has no request");
      let body: any;
      if (req.body.mode === "unsupported") body = req.body.postman;
      else if (req.body.mode.startsWith("raw"))
        body = {
          mode: "raw",
          raw: req.body.raw || "",
          options: {
            raw: { language: req.body.mode === "raw-json" ? "json" : "text" },
          },
        };
      else if (
        req.body.mode === "form-data" ||
        req.body.mode === "x-www-form-urlencoded"
      ) {
        const mode = req.body.mode === "form-data" ? "formdata" : "urlencoded";
        body = { mode, [mode]: vars(req.body.formData || []) };
      }
      const q = (req.queryParams || [])
        .filter((p) => p.enabled !== false && p.key)
        .map((p) => `${encode(p.key)}=${encode(p.value)}`)
        .join("&");
      const hash = req.url.includes("#")
        ? req.url.slice(req.url.indexOf("#"))
        : "";
      const url = req.url.replace(/#.*$/, "");
      const raw = url + (q ? (url.includes("?") ? "&" : "?") + q : "") + hash;
      return {
        ...base,
        id: item.id,
        name: item.name,
        event: event(req, base),
        request: {
          ...structuredClone(req.postman || {}),
          method: req.method,
          auth: authTo(req.auth),
          header: vars(req.headers || []),
          body,
          url: { raw, query: vars(req.queryParams || []) },
        },
      };
    };
    const base = structuredClone(collection.postman || {});
    return {
      ...base,
      info: {
        ...base.info,
        _postman_id: collection.id,
        name: collection.name,
        description: collection.description || "",
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      auth: authTo(collection.auth),
      event: event(collection, base),
      variable: vars(collection.variables || []),
      item: collection.items.map(convert),
    };
  }
  static fromCurl(command: string): HttpRequest {
    // Tokenization only: never pass imported text to a shell.
    const tokens: string[] = [];
    let token = "",
      quote = "",
      started = false;
    const text = command.trim().replace(/\\\r?\n/g, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = "";
        else if (
          c === "\\" &&
          quote === '"' &&
          i + 1 < text.length &&
          /["\\$`]/.test(text[i + 1])
        )
          token += text[++i];
        else token += c;
        started = true;
      } else if (c === '"' || c === "'") {
        quote = c;
        started = true;
      } else if (c === "\\" && i + 1 < text.length) {
        token += text[++i];
        started = true;
      } else if (/\s/.test(c)) {
        if (started) {
          tokens.push(token);
          token = "";
          started = false;
        }
      } else {
        token += c;
        started = true;
      }
    }
    if (quote) throw new Error("Unterminated quote in cURL command");
    if (started) tokens.push(token);
    if (tokens.shift() !== "curl") throw new Error("Expected a curl command");
    let method = "GET",
      url = "",
      explicit = false;
    const headers: KeyValueParam[] = [];
    const chunks: string[] = [];
    let json = false;
    const value = (i: number) => {
      if (!tokens[i]) throw new Error("Missing cURL option value");
      return tokens[i];
    };
    for (let i = 0; i < tokens.length; i++) {
      const flag = tokens[i];
      if (["-X", "--request"].includes(flag)) {
        method = value(++i).toUpperCase();
        explicit = true;
      } else if (["-H", "--header"].includes(flag)) {
        const h = value(++i);
        const colon = h.indexOf(":");
        if (colon < 1) throw new Error("Invalid cURL header");
        headers.push({
          key: h.slice(0, colon).trim(),
          value: h.slice(colon + 1).trim(),
          enabled: true,
        });
      } else if (
        ["-d", "--data", "--data-raw", "--data-binary", "--json"].includes(flag)
      ) {
        const data = value(++i);
        if (data.startsWith("@"))
          throw new Error(
            "cURL file uploads are not supported; no local file was read",
          );
        chunks.push(data);
        json ||= flag === "--json";
      } else if (flag === "--url") url = value(++i);
      else if (["-I", "--head"].includes(flag)) {
        method = "HEAD";
        explicit = true;
      } else if (
        [
          "-s",
          "--silent",
          "-S",
          "--show-error",
          "-L",
          "--location",
          "--compressed",
        ].includes(flag)
      ) {
      } else if (flag.startsWith("-"))
        throw new Error(
          `Unsupported cURL option ${flag}; import was stopped instead of discarding behavior`,
        );
      else if (!url) url = flag;
      else throw new Error("Only one cURL URL can be imported at a time");
    }
    if (!/^https?:\/\//i.test(url))
      throw new Error("cURL must include an HTTP or HTTPS URL");
    if (chunks.length && !explicit) method = "POST";
    const raw = chunks.join("&");
    const declared =
      headers.find((h) => h.key.toLowerCase() === "content-type")?.value || "";
    const isJson = json || declared.includes("json");
    if (chunks.length && !declared && !json)
      headers.push({
        key: "Content-Type",
        value: "application/x-www-form-urlencoded",
        enabled: true,
      });
    if (json && !declared)
      headers.push({
        key: "Content-Type",
        value: "application/json",
        enabled: true,
      });
    return {
      id: crypto.randomUUID(),
      name: "cURL Request",
      method: method as HttpMethod,
      url,
      headers,
      queryParams: [],
      body: chunks.length
        ? {
            mode: isJson
              ? "raw-json"
              : declared.includes("x-www-form-urlencoded")
                ? "x-www-form-urlencoded"
                : "raw-text",
            raw,
          }
        : { mode: "none" },
      auth: { type: "none" },
    };
  }
}
