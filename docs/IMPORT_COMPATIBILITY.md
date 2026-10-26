# Import compatibility and semantic reports

P1 supports Postman Collection v2.1 JSON and a deliberately bounded cURL command parser. Postman v3 YAML, HAR and OpenAPI import remain later work. Import is local parsing: cURL text is never passed to a shell, and importing a collection never executes its scripts or requests.

The checked-in corpus is synthetic and sanitized. Every endpoint uses `.invalid`; credentials, cookie examples and bodies are fixture strings. No customer collections, live credentials or filesystem payloads were used. `tests/fixtures/imports/nested-v21.json` covers collection → folder → nested folder inheritance, repeated and disabled variables/query/header/body rows, structured URL metadata, disabled events, example responses, descriptions and opaque fields. `unsupported-v21.json` covers OAuth2, file multipart, GraphQL and XML options. `curl-cases.json` covers literal shell syntax, repeated headers, urlencoded/empty/raw/JSON bodies and explicit rejection boundaries.

## Diagnostics

`reportPostmanImport(source)` in `src/core/models/ImportDiagnostics.ts` returns `{collection, report}`. The report contains `format`, `preserved`, `requestCount`, `warnings`, and `differences`. Unsupported authentication and body modes survive export in opaque metadata and emit warnings that execution is blocked. A report with `preserved: true` means the compared import/export semantics survived; warnings can still indicate unsupported execution. It does not certify Postman runtime parity.

`comparePostmanSemantics(originalPostman, exportedPostman)` also accepts independently exported documents, including documents exported after storage migration or restart. It uses a Postman-side semantic projection, independently of the internal converter representation. Differences contain JSON pointer paths and `added`, `removed` or `changed` kinds; they omit field values so diagnostics do not duplicate secrets. Key names and path segments remain visible and should be reviewed before sharing a report.

The projection preserves array order, repeated/disabled rows, examples and opaque fields. It normalizes absent defaults (GET, empty arrays, disabled=false, string row type, inferred raw language), string/object URLs and query encoding. Structured query rows take precedence over `url.raw`; conflicting raw queries generate a warning. Generated collection/item identities are excluded from semantic comparison; stable provided identities are asserted separately by restart tests. The comparison is a preservation check, not an independent Postman execution engine or full v2.1 JSON Schema validator.

Run the corpus check after building:

```sh
npm run build
node scripts/check-import-corpus.mjs
npx vitest run tests/converter.test.ts tests/import-corpus.test.ts
```

Compare an original and a post-migration export:

```sh
node scripts/check-import-corpus.mjs --before original.json --after exported.json
```

The script exits 1 on semantic differences, 2 on invalid command usage, and prints paths without values. Invalid input formats fail with an explicit error. It runs no HTTP requests or workspace writes. The integration test imports the corpus through public Studio endpoints into a disposable workspace, stops Studio, starts a fresh instance and compares public exports, both with and without explicit repository migration between instances. This exercises whichever repository format Studio currently uses; the corpus test also calls the repository migration checksum API while Studio is stopped to verify preservation across that boundary.

## Supported boundaries

- Nested collection/folder auth, variables and event scripts are retained. Runtime inheritance is covered through `collectionRequests`; disabled event scripts stay inactive and remain in exports.
- Export overlays editable values on original row/body/auth/URL metadata. Unchanged active events preserve their original script metadata; edited event code retains disabled events and metadata from the first active event. Editing a combined multi-event script flattens active events for that listen type. Arbitrary Postman script/package behavior is outside this preservation guarantee.
- URL path-variable definitions and protocol profile fields survive export as metadata. Disabled Postman bodies remain inactive and retain their payload for export. This change does not implement their execution behavior. Imported response examples survive as metadata; a full example editor remains later work.
- Unsupported body/auth modes are preserved and blocked by execution. Unsupported HTTP methods, non-v2.1 schema URLs and malformed top-level collection shapes fail explicitly. A missing schema remains accepted for compatibility with existing imports. This parser does not promise exhaustive schema validation.
- cURL supports `-X/--request`, `-H/--header`, `-d/--data`, `--data-raw`, literal `--data-binary`, `--json`, `--url`, `-I/--head` and presentation flags `-s/-S`, `--silent/--show-error`, plus `-L/--location` matching the default follow-redirect behavior. Values may be quoted; line continuations are supported. Environment expansion, command substitution and globbing are never evaluated.
- Unknown options, compressed transfers, uploads from files, multipart `-F`, multiple URLs, unsupported methods and mixed/repeated `--json` bodies fail explicitly. `--data-raw @text` stays literal. Empty data is retained. `--json` adds JSON Content-Type and Accept defaults. Header modifiers, attached short flags, `--flag=value`, curl config files, proxy/TLS options and advanced cURL transport behavior are unsupported.

## Change evidence and planning policy

Policy: compact planning, dependency context, impact verification, no further delegation. The initial public converter fixture failed because export removed the disabled event and script package metadata. Targeted export overlays fixed that demonstrated loss and covered adjacent row, URL, body and auth preservation. Existing converter callers keep the same collection/request return shapes; diagnostics are an additive standalone API. Studio/UI integration can expose this report without replacing the imported collection response.

Verification commands and observed results are reported by the task handoff. Corpus assertions are behavior-based and include a deliberately mutated export to prove that example, opaque body metadata and disabled-header losses produce differences. These checks do not claim execution parity for unsupported Postman features.

Observed import verification (2026-10-26): `npx vitest run tests/converter.test.ts tests/import-corpus.test.ts tests/variable.test.ts tests/integration.test.ts tests/executor.test.ts tests/workspace-integrity.test.ts` passed 75/75 across six files. The focused converter/corpus/variable run passed 40/40. `npx tsc` passed and the built corpus script reported preservation for both collections and all 15 cURL cases. A disposable mutated export deleting the response example made the script exit 1 with `/item/0/item/0/item/0/response` as a removed path, proving the negative reporting path. A regression fixture first demonstrated disabled-variable inheritance losing the enabled value, then passed after skipping disabled overrides in `CollectionContext`.
