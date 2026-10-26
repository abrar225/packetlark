import assert from "node:assert/strict";
import * as p0 from "./check-p0-browser.mjs";
import * as p1 from "./check-p1-browser.mjs";
import * as reconciliation from "./check-p1-reconciliation.mjs";

// Run only against scripts/p0-browser-fixture.mjs. Some historical checks
// intentionally leave changed fixture resources; reset them between cases so
// a later real-transport test never inherits an example.test URL.
export async function verifyWorkspaceRegression(page, baseUrl) {
  const api = async (route, method = "GET", body) => {
    const response = await fetch(baseUrl + "/api/" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${method} ${route}`);
    return response.json();
  };
  const original = { collections: await api("collections"), environments: await api("environments") };
  assert(original.collections.some((collection) => collection.id === "race_fixture"), "Disposable race fixture required");
  const reset = async () => {
    for (const kind of ["collections", "environments"]) {
      const current = await api(kind);
      for (const resource of current)
        if (!original[kind].some((item) => item.id === resource.id)) await api(`${kind}/${resource.id}`, "DELETE");
      for (const resource of original[kind]) {
        const value = structuredClone(resource);
        delete value.revision;
        await api(current.some((item) => item.id === resource.id) ? `${kind}/${resource.id}` : kind, current.some((item) => item.id === resource.id) ? "PUT" : "POST", value);
      }
    }
  };
  const results = [];
  const checks = [p0.verifyPendingEnvironment, p0.verifyCreateDelete, p0.verifyOwnership, p0.verifyEnvironmentOwnership, p0.verifyStaleDeletes, p1.verifyNativeIdentity, p1.verifyNestedSearch, ...Object.values(reconciliation)];
  try {
    for (const check of checks) {
      await reset();
      const result = { check: check.name, ...await check(page, baseUrl) };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    return results;
  } finally { await reset(); }
}
