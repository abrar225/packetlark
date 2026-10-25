import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { PostmanConverter } from "../dist/core/models/PostmanConverter.js";
import { HttpExecutor } from "../dist/core/engine/HttpExecutor.js";
import { OpenApiGenerator } from "../dist/core/sniffing/OpenApiGenerator.js";
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ url: req.url }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const collection = PostmanConverter.fromPostman({
    auth: { type: "bearer", bearer: [{ key: "token", value: "example" }] },
    item: [
      {
        name: "Probe",
        request: {
          method: "GET",
          url: {
            raw: `${origin}/items?tag=x`,
            query: [{ key: "tag", value: "x" }],
          },
        },
      },
      {
        name: "Text",
        request: {
          method: "POST",
          url: origin,
          body: {
            mode: "raw",
            raw: "hello",
            options: { raw: { language: "text" } },
          },
        },
      },
    ],
  });
  const { collectionRequests } = await import(
    "../dist/core/models/CollectionContext.js"
  );
  const request = collectionRequests(collection)[0].request;
  const response = await HttpExecutor.execute(request);
  const url = JSON.parse(response.body).url;
  assert.equal(url, "/items?tag=x");
  assert.equal(request.auth.type, "bearer");
  assert.equal(collection.items[1].request.body.mode, "raw-text");
  const traffic = (host, body) => ({
    id: host,
    timestamp: new Date().toISOString(),
    url: `https://${host}/items`,
    pathname: "/items",
    method: "GET",
    queryParams: {},
    requestHeaders: {},
    responseStatus: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: body,
    durationMs: 1,
  });
  const records = [traffic("a.example", false), traffic("b.example", false)];
  assert.throws(() => OpenApiGenerator.generate(records), /origin/i);
  const spec = OpenApiGenerator.generate(
    records,
    "Rea inferred API",
    "1.0.0",
    "https://a.example",
  );
  assert.equal(Object.keys(spec.paths).length, 1);
  assert.equal(
    spec.paths["/items"].get.responses["200"].content["application/json"].schema
      .type,
    "boolean",
  );
  console.log(
    JSON.stringify(
      {
        postmanQueryDuplication: url,
        inheritedAuth: request.auth.type,
        rawTextImportedAs: collection.items[1].request.body.mode,
        multiHostPathCount: Object.keys(spec.paths).length,
        multiHostServerCount: spec.servers.length,
        falseResponseContent: spec.paths["/items"].get.responses["200"].content,
      },
      null,
      2,
    ),
  );
  console.log(
    "Regression probes passed: previous compatibility/spec defects remain fixed.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
