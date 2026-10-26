/** Validate known editable fields while preserving opaque import metadata. */
export function validWorkspaceResource(
  value: any,
  kind: "collections" | "environments",
): boolean {
  const object = (value: any) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const id = (value: any) =>
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
  const params = (value: any) =>
    Array.isArray(value) &&
    value.every(
      (entry) =>
        object(entry) &&
        typeof entry.key === "string" &&
        typeof entry.value === "string" &&
        (entry.enabled === undefined || typeof entry.enabled === "boolean") &&
        (entry.secret === undefined || typeof entry.secret === "boolean"),
    );
  const optionalParams = (value: any) => value === undefined || params(value);
  const scripts = (value: any) =>
    [value.preRequestScript, value.testScript].every(
      (script) => script === undefined || typeof script === "string",
    );
  const auth = (value: any) =>
    value === undefined ||
    (object(value) &&
      ["none", "inherit", "bearer", "basic", "apikey", "oauth2", "unsupported"].includes(
        value.type,
      ));
  const request = (value: any) =>
    object(value) &&
    (value.id === undefined || id(value.id)) &&
    typeof value.url === "string" &&
    typeof value.method === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(value.method) &&
    optionalParams(value.headers) &&
    optionalParams(value.queryParams) &&
    auth(value.auth) &&
    (value.tls === undefined || (object(value.tls) && Object.keys(value.tls).every(key=>["ca","cert","keyRef","passphraseRef"].includes(key)) && Object.values(value.tls).every(entry=>typeof entry === "string" && entry.length<=256*1024))) &&
    (value.streamResponse === undefined || typeof value.streamResponse === "boolean") &&
    scripts(value) &&
    (value.body === undefined ||
      (object(value.body) &&
        [
          "binary",
          "none",
          "raw-json",
          "raw-text",
          "form-data",
          "x-www-form-urlencoded",
          "unsupported",
        ].includes(value.body.mode) &&
        (value.body.raw === undefined || typeof value.body.raw === "string") &&
        optionalParams(value.body.formData))) &&
    (value.timeoutMs === undefined ||
      (Number.isFinite(value.timeoutMs) && value.timeoutMs > 0)) &&
    (value.followRedirects === undefined ||
      typeof value.followRedirects === "boolean");
  let visited = 0;
  const identities = new Set<string>();
  const uniqueIdentity = (item: any) => {
    const aliases = new Set([
      item.id,
      ...(!item.isFolder && item.request?.id ? [item.request.id] : []),
    ]);
    for (const alias of aliases) {
      if (identities.has(alias)) return false;
      identities.add(alias);
    }
    return true;
  };
  const items = (value: any, depth = 0): boolean =>
    Array.isArray(value) &&
    depth <= 24 &&
    value.every(
      (item) =>
        ++visited <= 10000 &&
        object(item) &&
        id(item.id) &&
        uniqueIdentity(item) &&
        typeof item.name === "string" &&
        optionalParams(item.variables) &&
        auth(item.auth) &&
        scripts(item) &&
        (item.isFolder
          ? items(item.items || [], depth + 1)
          : request(item.request)),
    );
  return (
    object(value) &&
    id(value.id) &&
    typeof value.name === "string" &&
    (kind === "environments"
      ? params(value.values)
      : params(value.variables) &&
        auth(value.auth) &&
        scripts(value) &&
        items(value.items))
  );
}
