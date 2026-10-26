# P2 JSON validation boundary

JSON body syntax and optional JSON Schema checks use pinned MIT-licensed Ajv 8.20.0. Draft 2020-12 and draft-07 are supported through separate constructors. Remote references, unknown formats and unsupported schema dialects fail explicitly. No schema-generated code runs in the Studio browser.

Ajv's [security guidance](https://ajv.js.org/security.html) treats untrusted schemas as potentially expensive, including regex evaluation. Rea compiles and validates in a disposable Node worker, with a two-second default deadline, cancellation, two concurrent workers, 96 MiB old-space, 16 MiB young-space and 4 MiB stack limits. Body input is capped at 16 MiB; schemas at 64 KiB, depth 32 and 5,000 nodes. `allErrors` is disabled. Failure messages omit input values and schema literals. Worker termination completes before its concurrency slot is released.

`tests/json-body-validation.test.ts` exercises valid and invalid bodies, forbidden remote references/depth, expensive regex termination and cancellation followed by successful reuse. Dependency updates must retain these tests and recheck [schema dialect support](https://ajv.js.org/json-schema.html). Schema validation does not grant a request destination or expand credential origin permissions.
