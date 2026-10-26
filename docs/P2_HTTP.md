# P2 HTTP transport

The executor uses Node HTTP/HTTPS, preserving enabled header rows in their original order, casing and multiplicity. Query and URL-encoded form rows append in order, including duplicate keys. Multipart text and explicitly selected file rows stream in order. Disabled rows do not travel.

## Methods and request framing

Standard methods and custom HTTP token methods are accepted (1–64 characters, normalized to uppercase). CONNECT, TRACE and TRACK are rejected. GET and HEAD do not send request bodies. HTTP/1.1 is supported; this is not an HTTP/2 or WebSocket client.

Host must match the URL; duplicate Host, Authorization, Proxy-Authorization and Cookie fields are rejected as ambiguous. Authentication configuration and a manually entered Authorization field must not both supply credentials. Generic duplicate header fields are sent separately. The client owns Content-Length, Transfer-Encoding, Connection, Expect, Upgrade and Trailer; manually entered values are rejected to avoid contradictory framing. Node streams uploads with backpressure and supplies transfer framing.

The resolved URL is limited to 8 KiB, headers to 64 KiB, and form fields to 1,000. Request and decoded response budgets are independently configurable up to 50 MiB. The default request budget is 4 MiB and decoded response budget 10 MiB. An overall deadline includes scripts, upload, headers, body and decompression (default 30 seconds, maximum five minutes).

## Explicit file selection

`SelectedFileStore.add(bytes, name, contentType)` or `addStream(source, name, contentType, signal)` accepts bytes explicitly selected by the user. A session store permits at most 32 selections and 50 MiB in aggregate by default, counting in-progress writes. UUID identifiers reveal no filesystem paths. Metadata contains only `id`, `name`, `size`, `contentType`; execution uses `resolveFile(id)` returning an `open()` read stream. Files live in a private session temporary directory, with mode 0600, and are deleted on removal/close. Interrupted or oversized selections are discarded.

Binary bodies use `body: {mode:'binary', fileId}`. Multipart file rows use `{key, value:'', fileId, fileName?}`. Names are escaped before constructing Content-Disposition. Imported paths and Postman `src` values never authorize file access; a missing or expired ID requires selection again. IDs are session capabilities and must remain on the authenticated local control surface.

Postman collection export explicitly rejects selected binary/multipart files (including disabled file rows), configured request TLS, and local OAuth connections rather than silently omitting their behavior or exporting session capabilities. Export a copy with those settings removed, then select files and configure CA/client certificates or OAuth separately in Postman. Unchanged imported unsupported file/OAuth modes retain their original opaque metadata for round trips; imported paths remain inert.

## Credentials and TLS

`{{secret:ID}}` references expand after ordinary variables and pre-request scripts, only in outbound header/query/form/body values and explicit authentication fields. Embedded references work. Environment and script variable scopes keep their references. URL, hostname, header names and query/form names cannot contain credential references. `resolveCredential(id, actualOrigin)` and `resolveOAuth(connectionId, actualOrigin)` must enforce the approved origin. Resolved values are registered with the execution redactor before diagnostics or script logs are retained.

HTTPS verifies certificates and hostnames by default. `tls.ca` and `tls.cert` accept bounded PEM public material. Client private keys and passphrases use `tls.keyRef` and `tls.passphraseRef`, resolved through the same origin-bound credential hook. Unknown TLS settings, including attempts to disable verification or inline a private key, fail before transport. No verification bypass exists. TLS client material is never reused across origins.

Cross-origin redirects strip credential headers, including generic fields containing resolved secret values, and Host. A credential-bearing body cannot be replayed across origins by a 307/308 redirect. Cookies are selected independently for each destination. Redirects allow only HTTP(S), reject URL user information, and stop after ten hops. `forbiddenOrigins` blocks the workbench control origin on initial, redirect and script-child requests without blocking ordinary private network targets.

## Streaming responses and cancellation

`onResponseHeaders` exposes status, an ordinary header mapping and ordered `headerEntries`. `onResponseChunk(Buffer)` and `onProgress({phase, bytes})` are awaited, giving the consumer backpressure. Download progress and byte budgets count decompressed bytes for gzip, deflate and Brotli. Aborting or exceeding a decoded budget destroys the original HTTP response and decoder.

With `artifactStore`, the response body preview defaults to 256 KiB; `previewBytes` can lower this. `sizeBytes` counts the complete decoded body and `previewTruncated` identifies a shortened preview. `artifactId` becomes available only when the body completes within its budget. `ResponseArtifactStore.get(id)` returns an `open()` stream of the exact decoded response bytes for a user-selected download. Default session quotas are 100 MiB and 32 artifacts. Partial downloads are removed on failure/cancellation. Artifacts are private mode-0600 temporary files and never become workspace/report data.

Post-response scripts receive the complete bounded text body even when the displayed preview is truncated; the executor retains a full bounded copy only when those scripts exist. Script-child requests inherit credential, TLS policy and cancellation hooks, but do not publish parent response chunks or artifacts. Binary previews provide a download explanation and a bounded base64 representation. Raw selected responses and downloads may contain secrets; logs and exported reports must use the shared redactor.

## Cookies and JSON validation

`CookieManager` supports scoped inspection, editing and clearing through its tough-cookie jar. Persistence is opt-in through `SecureCookieBackend {load, save, clear}`, intended for the platform credential vault. It never writes cookie values to workspace JSON. Serialized cookie state is bounded to 64 KiB and 500 cookies. Without a secure backend, persistence fails explicitly; transient jars continue working.

Every outbound raw JSON body is parsed before transport. An optional `validateJsonBody(raw, schema, signal)` hook supplies bounded schema validation; a schema without a validator fails explicitly. Invalid syntax never sends a request.

## Verification

`tests/p2-transport.test.ts` exercises real local HTTP and raw TCP servers: duplicate wire fields, custom methods, selected binary/multipart bytes, quotas, compressed byte limits, previews/download bytes, cancellation before headers/during upload/body, deadline enforcement, origin-bound embedded credentials, cross-origin stripping, forbidden control origins, secure-cookie backend round trips, framing rejection, default TLS rejection and explicit CA/mTLS success. `tests/files/tls` contains public test-only TLS credentials; they grant no external access.

Cookie configuration and secure writes are serialized. A ten-second wait limit reports an uncertain outcome if the native provider stalls; the authorized operation may still complete. Further cookie mutations are refused while that operation is pending, and no automatic retry occurs. Request completion reports a cookie warning instead of retaining an execution slot indefinitely. Shutdown retains the workspace writer lease until pending cookie/native credential work settles. This can require unlocking the OS credential store before shutdown completes.
