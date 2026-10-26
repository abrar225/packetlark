import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { StudioServer } from "../src/server/StudioServer.js";
import { startHttpFixture } from "./http-fixture.js";

async function workspace(
  test: (
    root: string,
    api: (
      route: string,
      method?: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => Promise<Response>,
    restart: () => Promise<void>,
  ) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "packetlark-integrity-"));
  let server: StudioServer;
  let port: number;
  const restart = async () => {
    if (server) await server.stop();
    server = new StudioServer(0, 0, root);
    port = await server.start();
  };
  await restart();
  const api = (route: string, method = "GET", body?: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await test(root, api, restart);
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("workspace API and restart integrity", () => {
  it("keeps browser recovery identity stable across restart and distinct across workspace roots", () =>
    workspace(async (root, api, restart) => {
      const identity = await (await api("workspace/identity")).json();
      expect(identity).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(identity)).not.toContain(root);
      await restart();
      expect(await (await api("workspace/identity")).json()).toEqual(identity);
      await workspace(async (_, other) => {
        expect(await (await other("workspace/identity")).json()).not.toEqual(identity);
      });
    }));

  it("counts the combined collection and environment document limit before committing", () =>
    workspace(async (root, api) => {
      for (let i = 0; i < 997; i++)
        fs.writeFileSync(
          path.join(root, "collections", `quota_${i}.json`),
          JSON.stringify({
            id: `quota_${i}`,
            name: "Quota",
            variables: [],
            items: [],
          }),
        );
      expect(
        (
          await api("collections", "POST", {
            id: "thousandth",
            name: "Last",
            variables: [],
            items: [],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api("environments", "POST", {
            id: "excess",
            name: "Too many",
            values: [],
          })
        ).status,
      ).toBe(413);
      expect(
        fs.existsSync(path.join(root, "environments", "excess.json")),
      ).toBe(false);
      const snapshot = await (await api("workspace")).json();
      expect(snapshot.collections.length + snapshot.environments.length).toBe(
        1000,
      );
    }));
  it("does not create initialization metadata past the managed directory limit", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "packetlark-init-entry-limit-"));
    const directory = path.join(root, "collections");
    fs.mkdirSync(directory);
    for (let i = 0; i < 2047; i++)
      fs.writeFileSync(path.join(directory, `preserved_${i}`), "");
    try {
      expect(() => new StudioServer(0, 0, root)).toThrow(
        /Workspace exceeds the supported limit/,
      );
      expect(fs.readdirSync(directory).length).toBe(2048);
      expect(fs.existsSync(path.join(directory, ".initialized"))).toBe(false);
      expect(fs.readFileSync(path.join(directory, "preserved_0"), "utf8")).toBe(
        "",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects a new file at the managed-directory entry limit without poisoning refresh", () =>
    workspace(async (root, api) => {
      const directory = path.join(root, "collections");
      const present = fs.readdirSync(directory).length;
      for (let i = present; i < 2048; i++)
        fs.writeFileSync(path.join(directory, `unmanaged_${i}`), "");
      const response = await api("collections", "POST", {
        id: "one_too_many",
        name: "Too many",
        variables: [],
        items: [],
      });
      expect(response.status).toBe(413);
      expect(fs.existsSync(path.join(directory, "one_too_many.json"))).toBe(
        false,
      );
      expect((await api("workspace")).status).toBe(200);
    }));
  it("keeps the previous validated snapshot when another resource is malformed", () =>
    workspace(async (root, api) => {
      const before = await (await api("workspace")).json();
      const collection = before.collections[0],
        environment = before.environments[0];
      const collectionFile = path.join(
        root,
        "collections",
        collection.id + ".json",
      );
      const envFile = path.join(root, "environments", environment.id + ".json");
      const envBytes = fs.readFileSync(envFile);
      const external = JSON.parse(fs.readFileSync(collectionFile, "utf8"));
      external.name = "Valid edit waits for complete snapshot";
      fs.writeFileSync(collectionFile, JSON.stringify(external));
      fs.writeFileSync(envFile, "{malformed");
      expect((await api("workspace")).status).toBe(503);
      expect(
        (await (await api(`collections/${collection.id}`)).json()).name,
      ).toBe(collection.name);
      expect(fs.readFileSync(envFile, "utf8")).toBe("{malformed");
      fs.writeFileSync(envFile, envBytes);
      expect((await (await api("workspace")).json()).collections[0].name).toBe(
        "Valid edit waits for complete snapshot",
      );
    }));
  it("bounds aggregate workspace refresh and refuses writes that exceed the same budget", () =>
    workspace(async (root, api) => {
      const payload = "x".repeat(2 * 1024 * 1024 - 2048);
      for (let i = 0; i < 17; i++)
        fs.writeFileSync(
          path.join(root, "collections", `large_${i}.json`),
          JSON.stringify({
            id: `large_${i}`,
            name: "Large",
            variables: [],
            items: [],
            importedMetadata: payload,
          }),
        );
      const snapshot = await api("workspace");
      expect(snapshot.status).toBe(503);
      expect((await snapshot.json()).error.code).toBe("ERR_WORKSPACE_LIMIT");
      const proposed = {
        id: "over_limit",
        name: "Too much",
        variables: [],
        items: [],
      };
      expect((await api("collections", "POST", proposed)).status).toBe(413);
      expect(
        fs.existsSync(path.join(root, "collections", "over_limit.json")),
      ).toBe(false);
      fs.unlinkSync(path.join(root, "collections", "large_16.json"));
      expect((await api("collections", "POST", proposed)).status).toBe(200);
    }));
  it("rejects stale collection execution context before transport and runs the reviewed revision", () =>
    workspace(async (root, api) => {
      let calls = 0;
      const target = http.createServer((_req, res) => {
        calls++;
        res.end("safe");
      });
      await new Promise<void>((resolve) =>
        target.listen(0, "127.0.0.1", resolve),
      );
      try {
        const request = {
          id: "request",
          method: "GET",
          url: `http://127.0.0.1:${(target.address() as any).port}/`,
        };
        const original = await (
          await api("collections", "POST", {
            id: "context",
            name: "Context",
            variables: [],
            items: [{ id: "request", name: "Request", request }],
            testScript:
              'pm.test("original", () => pm.expect(pm.response.code).to.equal(200))',
          })
        ).json();
        const file = path.join(root, "collections", "context.json");
        const external = JSON.parse(fs.readFileSync(file, "utf8"));
        external.testScript =
          'pm.test("reviewed", () => pm.expect(pm.response.code).to.equal(200))';
        fs.writeFileSync(file, JSON.stringify(external));
        const stale = await api("execute", "POST", {
          collectionId: original.id,
          collectionRevision: original.revision,
          request,
        });
        expect(stale.status).toBe(412);
        expect((await stale.json()).error.code).toBe("ERR_WORKSPACE_CONFLICT");
        expect(calls).toBe(0);
        const staleRun = await api("runs", "POST", {
          collectionId: original.id,
          collectionRevision: original.revision,
        });
        expect(staleRun.status).toBe(412);
        expect(calls).toBe(0);
        const latest = (await (await api("workspace")).json()).collections.find(
          (col) => col.id === original.id,
        );
        const reviewed = await api("execute", "POST", {
          collectionId: latest.id,
          collectionRevision: latest.revision,
          request,
        });
        expect(reviewed.status).toBe(200);
        expect((await reviewed.json()).testResults).toEqual([
          { name: "reviewed", passed: true },
        ]);
        expect(calls).toBe(1);
      } finally {
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
      }
    }));
  it("exposes a conditional workspace snapshot that reflects external edits and deletions", () =>
    workspace(async (root, api) => {
      const first = await api("workspace");
      expect(first.status).toBe(200);
      const snapshot = await first.json();
      const tag = first.headers.get("etag");
      expect(tag).toBe(`"${snapshot.revision}"`);
      expect(
        (await api("workspace", "GET", undefined, { "If-None-Match": tag }))
          .status,
      ).toBe(304);
      const file = path.join(
        root,
        "collections",
        snapshot.collections[0].id + ".json",
      );
      const external = JSON.parse(fs.readFileSync(file, "utf8"));
      external.name = "Changed in external editor";
      fs.writeFileSync(file, JSON.stringify(external));
      const changed = await api("workspace", "GET", undefined, {
        "If-None-Match": tag,
      });
      expect(changed.status).toBe(200);
      const next = await changed.json();
      expect(next.revision).not.toBe(snapshot.revision);
      expect(next.collections[0].name).toBe("Changed in external editor");
      fs.unlinkSync(file);
      expect((await (await api("workspace")).json()).collections).toEqual([]);
    }));
  it.skipIf(process.platform === "win32")(
    "rejects symlinked managed directories before initialization writes outside the workspace",
    async () => {
      const root = fs.mkdtempSync(path.join(tmpdir(), "packetlark-linked-root-"));
      const outside = fs.mkdtempSync(
        path.join(tmpdir(), "packetlark-linked-outside-"),
      );
      try {
        fs.symlinkSync(outside, path.join(root, "collections"), "dir");
        expect(() => new StudioServer(0, 0, root)).toThrow(
          /workspace.*(directory|path)/i,
        );
        expect(fs.readdirSync(outside)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform === "win32")(
    "stops reading, saving and deleting when a managed directory is redirected after startup",
    () =>
      workspace(async (root, api) => {
        for (const kind of ["collections", "environments"]) {
          const original = (await (await api(kind)).json())[0];
          const directory = path.join(root, kind);
          const retained = directory + "-retained";
          const outside = fs.mkdtempSync(
            path.join(tmpdir(), "packetlark-redirected-"),
          );
          const file = path.join(outside, original.id + ".json");
          const data = fs.readFileSync(
            path.join(directory, original.id + ".json"),
          );
          fs.writeFileSync(file, data);
          fs.renameSync(directory, retained);
          fs.symlinkSync(outside, directory, "dir");
          try {
            const update = await api(`${kind}/${original.id}`, "PUT", {
              name: "Must not escape",
            });
            expect(update.status).toBe(503);
            expect((await update.json()).error.code).toBe(
              "ERR_WORKSPACE_UNSAFE",
            );
            expect((await api(kind)).status).toBe(503);
            expect((await api(`${kind}/${original.id}`)).status).toBe(503);
            expect(
              (
                await api("execute", "POST", {
                  request: { method: "GET", url: "http://127.0.0.1:1/" },
                })
              ).status,
            ).toBe(503);
            expect((await api("health")).ok).toBe(true);
            expect((await api(`${kind}/${original.id}`, "DELETE")).status).toBe(
              503,
            );
            expect(fs.readFileSync(file)).toEqual(data);
          } finally {
            fs.unlinkSync(directory);
            fs.renameSync(retained, directory);
            fs.rmSync(outside, { recursive: true, force: true });
          }
          expect((await api(kind)).ok).toBe(true);
        }
      }),
  );
  it("rejects oversized external files during revision checks without replacing their contents", () =>
    workspace(async (root, api) => {
      const original = (await (await api("collections")).json())[0];
      const file = path.join(root, "collections", original.id + ".json");
      const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, "x");
      fs.writeFileSync(file, oversized);
      const result = await api(`collections/${original.id}`, "PUT", {
        name: "Must not replace",
      });
      expect(result.status).toBe(503);
      expect((await result.json()).error.code).toBe("ERR_WORKSPACE_INVALID");
      expect(fs.readFileSync(file).equals(oversized)).toBe(true);
    }));
  it("requires restart when a managed directory is replaced by a different real directory", () =>
    workspace(async (root, api) => {
      const original = (await (await api("collections")).json())[0];
      const directory = path.join(root, "collections");
      const retained = directory + "-original";
      fs.cpSync(directory, retained, { recursive: true });
      // Keep the original inode alive so a new directory cannot reuse it.
      fs.renameSync(directory, directory + "-old");
      fs.renameSync(retained, directory);
      try {
        expect((await api("collections")).status).toBe(503);
        expect(
          (
            await api(`collections/${original.id}`, "PUT", {
              name: "Must not commit",
            })
          ).status,
        ).toBe(503);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.renameSync(directory + "-old", directory);
      }
      expect((await api("collections")).status).toBe(200);
    }));
  it.skipIf(process.platform === "win32")(
    "rejects a linked initialization marker instead of treating it as a committed workspace",
    async () => {
      const root = fs.mkdtempSync(path.join(tmpdir(), "packetlark-linked-marker-"));
      const outside = path.join(root, "outside-marker");
      const original = new StudioServer(0, 0, root);
      await original.stop();
      const marker = path.join(root, "collections", ".initialized");
      fs.writeFileSync(outside, "1\n");
      fs.unlinkSync(marker);
      fs.symlinkSync(outside, marker);
      try {
        expect(() => new StudioServer(0, 0, root)).toThrow(/workspace/i);
        expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(outside, "utf8")).toBe("1\n");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("rejects ambiguous request and item identities without replacing the collection", () =>
    workspace(async (_root, api) => {
      const original = (await (await api("collections")).json())[0];
      for (const ids of [
        ["one", "same", "two", "same"],
        ["one", "one", "two", "one"],
        ["one", "two", "two", "three"],
      ]) {
        const items = [0, 1].map((index) => ({
          id: ids[index * 2],
          name: "Request " + index,
          request: {
            id: ids[index * 2 + 1],
            method: "GET",
            url: "http://example.test/",
          },
        }));
        const response = await api(`collections/${original.id}`, "PUT", {
          items,
        });
        expect(response.status).toBe(400);
        expect(
          (await (await api(`collections/${original.id}`)).json()).revision,
        ).toBe(original.revision);
      }
    }));
  it("executes a native item without a separate request ID and retains inherited context after restart", () =>
    workspace(async (_root, api, restart) => {
      const target = await startHttpFixture();
      try {
        const created = await api("collections", "POST", {
          id: "native_identity",
          name: "Native identity",
          variables: [{ key: "baseUrl", value: target.url, enabled: true }],
          testScript:
            'pm.test("inherited", () => pm.expect(pm.response.code).to.equal(200))',
          items: [
            {
              id: "native_item",
              name: "Native request",
              request: { method: "GET", url: "{{baseUrl}}/get" },
            },
          ],
        });
        expect(created.ok).toBe(true);
        await restart();
        const response = await api("execute", "POST", {
          collectionId: "native_identity",
          request: { id: "native_item", method: "GET", url: "{{baseUrl}}/get" },
        });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.status).toBe(200);
        expect(result.testResults).toEqual([
          { name: "inherited", passed: true },
        ]);
      } finally {
        await target.stop();
      }
    }));
  it("keeps deliberately emptied collections and environments empty after refresh and restart", () =>
    workspace(async (root, api, restart) => {
      for (const kind of ["collections", "environments"]) {
        const initial = await (await api(kind)).json();
        // Retained migration source must never become a second live database.
        fs.writeFileSync(
          path.join(root, kind + ".json"),
          JSON.stringify(initial),
        );
        for (const resource of initial)
          expect((await api(`${kind}/${resource.id}`, "DELETE")).ok).toBe(true);
        expect(await (await api(kind)).json()).toEqual([]);
      }
      await restart();
      for (const kind of ["collections", "environments"])
        expect(await (await api(kind)).json()).toEqual([]);
    }));
  it("commits canonical edits without depending on a legacy mirror write", () =>
    workspace(async (root, api, restart) => {
      for (const kind of ["collections", "environments"]) {
        const resource = (await (await api(kind)).json())[0];
        const mirror = path.join(root, kind + ".json");
        fs.rmSync(mirror, { force: true });
        fs.mkdirSync(mirror);
        const result = await api(`${kind}/${resource.id}`, "PUT", {
          name: "Committed once",
        });
        expect(result.status).toBe(200);
      }
      await restart();
      for (const kind of ["collections", "environments"])
        expect((await (await api(kind)).json())[0].name).toBe("Committed once");
    }));

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the previous in-memory resource when a precommit write fails",
    () =>
      workspace(async (root, api) => {
        for (const kind of ["collections", "environments"]) {
          const resource = (await (await api(kind)).json())[0];
          const file = path.join(root, kind, resource.id + ".json");
          const directory = path.dirname(file);
          fs.chmodSync(directory, 0o500);
          try {
            expect(
              (
                await api(`${kind}/${resource.id}`, "PUT", {
                  name: "Must not commit",
                })
              ).status,
            ).toBe(500);
            expect(
              (await (await api(`${kind}/${resource.id}`)).json()).name,
            ).toBe(resource.name);
          } finally {
            fs.chmodSync(directory, 0o700);
          }
        }
      }),
  );

  it("reports malformed canonical files without hiding them or creating replacement samples", () =>
    workspace(async (root, api, restart) => {
      const resource = (await (await api("collections")).json())[0];
      const file = path.join(root, "collections", resource.id + ".json");
      fs.writeFileSync(file, "{truncated");
      const response = await api("collections");
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("ERR_WORKSPACE_INVALID");
      expect(fs.readFileSync(file, "utf8")).toBe("{truncated");
      await expect(restart()).rejects.toMatchObject({
        code: "ERR_WORKSPACE_INVALID",
      });
    }));

  it("rejects stale client revisions and external disk edits instead of overwriting them", () =>
    workspace(async (root, api) => {
      for (const kind of ["collections", "environments"]) {
        const original = (await (await api(kind)).json())[0];
        expect(typeof original.revision).toBe("string");
        const first = await api(
          `${kind}/${original.id}`,
          "PUT",
          { name: "First writer" },
          { "If-Match": `"${original.revision}"` },
        );
        expect(first.status).toBe(200);
        const stale = await api(
          `${kind}/${original.id}`,
          "PUT",
          { name: "Stale writer" },
          { "If-Match": `"${original.revision}"` },
        );
        expect(stale.status).toBe(412);
        const current = await first.json();
        const file = path.join(root, kind, original.id + ".json");
        const edited = JSON.parse(fs.readFileSync(file, "utf8"));
        edited.name = "External editor";
        fs.writeFileSync(file, JSON.stringify(edited));
        expect(
          (
            await api(
              `${kind}/${original.id}`,
              "PUT",
              { name: "Must not replace external edit" },
              { "If-Match": `"${current.revision}"` },
            )
          ).status,
        ).toBe(412);
        expect((await (await api(kind)).json())[0].name).toBe(
          "External editor",
        );
      }
    }));

  it("keeps newer environment edits when an older execution tries to persist script mutations", () =>
    workspace(async (root, api) => {
      let received: () => void, finish: () => void;
      const started = new Promise<void>((resolve) => (received = resolve));
      const target = http.createServer((_req, res) => {
        finish = () => res.end("execution completed");
        received();
      });
      await new Promise<void>((resolve) =>
        target.listen(0, "127.0.0.1", resolve),
      );
      try {
        const env = (await (await api("environments")).json())[0];
        const execution = api("execute", "POST", {
          environmentId: env.id,
          request: {
            method: "GET",
            url: `http://127.0.0.1:${(target.address() as any).port}/`,
            headers: [],
            queryParams: [],
            body: { mode: "none" },
            auth: { type: "none" },
            testScript: 'pm.environment.set("counter", "old-execution-value")',
          },
        });
        await started;
        const edited = await api(
          `environments/${env.id}`,
          "PUT",
          {
            values: [{ key: "counter", value: "new-user-value", enabled: true }],
          },
          { "If-Match": `"${env.revision}"` },
        );
        expect(edited.ok).toBe(true);
        finish();
        const result = await (await execution).json();
        expect(result.body).toBe("execution completed");
        expect(result.persistence.environment.code).toBe(
          "ERR_WORKSPACE_CONFLICT",
        );
        expect(
          (await (await api(`environments/${env.id}`)).json()).values[0].value,
        ).toBe("new-user-value");
      } finally {
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
      }
    }));

  it("resumes an interrupted legacy migration without dropping remaining resources", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "packetlark-migration-"));
    const resources = ["first", "second", "third"].map((id) => ({
      id,
      name: id,
      schemaVersion: "2.1.0",
      variables: [],
      items: [],
    }));
    fs.writeFileSync(
      path.join(root, "collections.json"),
      JSON.stringify(resources),
    );
    const rename = fs.renameSync;
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("/second.json"))
        throw Object.assign(new Error("Injected replacement failure"), {
          code: "EIO",
        });
      rename(from, to);
    });
    let server: StudioServer;
    try {
      expect(() => new StudioServer(0, 0, root)).toThrow(/Injected/);
      fault.mockRestore();
      server = new StudioServer(0, 0, root);
      const port = await server.start();
      const loaded = await (
        await fetch(`http://127.0.0.1:${port}/api/collections`)
      ).json();
      expect(loaded.map((resource) => resource.id).sort()).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(root, "collections.json"), "utf8"),
        ),
      ).toEqual(resources);
    } finally {
      fault.mockRestore();
      if (server) await server.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed nested resources before replacing valid workspace data", () =>
    workspace(async (_root, api) => {
      for (const [kind, patch] of [
        ["collections", { items: [null] }],
        ["collections", { variables: null }],
        ["environments", { values: [null] }],
        ["environments", { values: [{ key: "x", value: { nested: true } }] }],
      ] as const) {
        const original = (await (await api(kind)).json())[0];
        const result = await api(`${kind}/${original.id}`, "PUT", patch);
        expect(result.status).toBe(400);
        expect(
          (await (await api(`${kind}/${original.id}`)).json()).revision,
        ).toBe(original.revision);
      }
    }));
  it("migrates compact legacy data without creating an oversized unreadable canonical file", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "packetlark-migration-size-"));
    const resource = {
      id: "compact",
      name: "Compact",
      variables: [],
      items: [],
      postman: { padding: Array(250000).fill(0) },
    };
    expect(
      Buffer.byteLength(JSON.stringify(resource, null, 2)),
    ).toBeGreaterThan(2 * 1024 * 1024);
    fs.writeFileSync(
      path.join(root, "collections.json"),
      JSON.stringify([resource]),
    );
    let server: StudioServer;
    try {
      server = new StudioServer(0, 0, root);
      const port = await server.start();
      const response = await fetch(
        `http://127.0.0.1:${port}/api/collections/compact`,
      );
      expect(response.ok).toBe(true);
      expect((await response.json()).postman.padding.length).toBe(250000);
      expect(
        fs.statSync(path.join(root, "collections", "compact.json")).size,
      ).toBeLessThanOrEqual(2 * 1024 * 1024);
    } finally {
      if (server) await server.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
