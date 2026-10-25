import type { IncomingMessage } from "node:http";

export class BodyBudgetError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Count bytes before retaining them. Leaves an oversized inbound socket for the HTTP owner to close after its error response. */
export function readIncomingBody(
  req: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
      signal.removeEventListener("abort", abort);
    };
    const error = (reason: Error) => {
      cleanup();
      req.pause();
      reject(reason);
    };
    const aborted = () =>
      error(new BodyBudgetError("Client disconnected", "ERR_ABORTED", 499));
    const abort = () =>
      error(
        signal.reason ||
          new BodyBudgetError("Request cancelled", "ERR_ABORTED", 499),
      );
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes)
        error(
          new BodyBudgetError(
            "Request body exceeds configured limit",
            "ERR_REQUEST_LIMIT",
            413,
          ),
        );
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      error(
        new BodyBudgetError(
          "Request body exceeds configured limit",
          "ERR_REQUEST_LIMIT",
          413,
        ),
      );
      return;
    }
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", aborted);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Native fetch decodes content encodings; this budget therefore applies to decoded bytes too. */
export async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new BodyBudgetError(
          "Response body exceeds configured limit",
          "ERR_RESPONSE_LIMIT",
          502,
        );
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
