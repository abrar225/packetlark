import http from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";

/** A real loopback HTTP endpoint: tests never rely on a third-party echo service. */
export async function startHttpFixture() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const raw = Buffer.concat(buffers).toString("utf8");
    const contentType = req.headers["content-type"] || "";
    const form: Record<string, string> = {};
    let json: unknown = null;
    if (contentType.includes("application/x-www-form-urlencoded"))
      new URLSearchParams(raw).forEach((v, k) => (form[k] = v));
    if (contentType.includes("multipart/form-data")) {
      const data = await new Response(raw, {
        headers: { "content-type": contentType },
      }).formData();
      data.forEach((v, k) => (form[k] = String(v)));
    }
    if (contentType.includes("application/json") && raw) json = JSON.parse(raw);
    const payload = {
      args: Object.fromEntries(url.searchParams),
      form,
      json,
      headers: req.headers,
      gzipped: url.pathname === "/gzip",
      slideshow: { title: "A local fixture" },
    };
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.startsWith("/bytes/")) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(
        Buffer.from(
          Array.from(
            { length: Number(url.pathname.split("/")[2]) },
            (_, i) => i % 256,
          ),
        ),
      );
      return;
    }
    if (url.pathname === "/gzip") {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(JSON.stringify(payload)));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
