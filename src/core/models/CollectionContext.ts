import type {
  ApiCollection,
  CollectionItem,
  HttpRequest,
  KeyValueParam,
  AuthConfig,
} from "./types.js";
export interface ResolvedRequest {
  request: HttpRequest;
  variables: KeyValueParam[];
  path: string[];
}
export function collectionRequests(
  collection: ApiCollection,
): ResolvedRequest[] {
  const found: ResolvedRequest[] = [];
  function visit(
    items: CollectionItem[],
    parents: Array<ApiCollection | CollectionItem>,
    path: string[],
  ) {
    for (const item of items) {
      if (item.isFolder) {
        visit(item.items || [], [...parents, item], [...path, item.name]);
        continue;
      }
      if (!item.request) continue;
      const request = structuredClone(item.request);
      let auth: AuthConfig = { type: "none" };
      for (const parent of parents)
        if (parent.auth && parent.auth.type !== "inherit") auth = parent.auth;
      if (request.auth?.type && request.auth.type !== "inherit")
        auth = request.auth;
      request.auth = structuredClone(auth);
      request.preRequestScripts = parents
        .map((p) => p.preRequestScript)
        .filter(Boolean);
      request.testScripts = parents.map((p) => p.testScript).filter(Boolean);
      const variables = new Map<string, KeyValueParam>();
      for (const parent of parents)
        for (const variable of parent.variables || [])
          variables.set(variable.key, variable);
      found.push({
        request,
        variables: [...variables.values()],
        path: [...path, item.name],
      });
    }
  }
  visit(collection.items, [collection], [collection.name]);
  return found;
}
export function resolveCollectionRequest(
  collection: ApiCollection,
  edited: HttpRequest,
): ResolvedRequest {
  const resolved = collectionRequests(collection).find(
    (item) => item.request.id === edited.id,
  );
  if (!resolved) throw new Error("Request is not part of this collection");
  const merged = { ...resolved.request, ...structuredClone(edited) };
  if (!edited.auth || edited.auth.type === "inherit")
    merged.auth = resolved.request.auth;
  merged.preRequestScripts = resolved.request.preRequestScripts;
  merged.testScripts = resolved.request.testScripts;
  return { ...resolved, request: merged };
}
