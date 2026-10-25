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
  const root = fs.mkdtempSync(path.join(tmpdir(), "rea-integrity-"));
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
  it.skipIf(process.platform === "win32")(
    "rejects symlinked managed directories before initialization writes outside the workspace",
    async () => {
      const root = fs.mkdtempSync(path.join(tmpdir(), "rea-linked-root-"));
      const outside = fs.mkdtempSync(
        path.join(tmpdir(), "rea-linked-outside-"),
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
            path.join(tmpdir(), "rea-redirected-"),
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
      const root = fs.mkdtempSync(path.join(tmpdir(), "rea-linked-marker-"));
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
            testScript: 'pm.environment.set("apiKey", "old-execution-token")',
          },
        });
        await started;
        const edited = await api(
          `environments/${env.id}`,
          "PUT",
          {
            values: [{ key: "apiKey", value: "new-user-token", enabled: true }],
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
        ).toBe("new-user-token");
      } finally {
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
      }
    }));

  it("resumes an interrupted legacy migration without dropping remaining resources", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "rea-migration-"));
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
    const root = fs.mkdtempSync(path.join(tmpdir(), "rea-migration-size-"));
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
