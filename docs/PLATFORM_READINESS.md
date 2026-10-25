# Readiness and launch decisions

25 October 2026 · release candidate 1.1.0

## Why the original score was 3.8

The 3.8/10 score assessed **broad professional platform readiness**, not the idea's worth or the author's skill. The earlier weighted rubric gave 20% to HTTP/auth, 15% each to automation, storage, capture, teams/ecosystem and reliability, and 5% to usability. Teams scored zero; automation and reliability scored three. Basic request execution and an attractive interface could not compensate for missing runner/CI, partial migration, incorrect inference and uncertain scripting isolation. The 8.5/10 Postman figure was a documentation-based reviewer judgment, not a direct benchmark or exhaustive quality measurement. The old personal-tool score used a narrower use case.

That assessment is historical. This revision closes several concrete gaps but does not establish a new 9/10 score. A score without a fixed task set, adoption evidence and comparable measurements would be cosmetic.

## Implemented in this revision

- Postman HTTP import with normalized repeated/disabled queries, inherited authentication and collection/folder/request scripts, explicit no-auth, preserved unsupported modes and import warnings.
- QuickJS scripting with Chai assertions, isolated variable scopes, async/callback tests, bounded `pm.sendRequest`, request chaining and skip behavior. It remains a subset of Postman's API.
- HTTP timeout, response-size limit, cancellation, redirect-aware cookie sessions, redirect credential stripping and binary response downloads. No interactive cookie editor or persistent cookie vault.
- Collection runs with JSON/CSV data, iterations, stop-on-failure, total run/request budgets and capped retained response bodies. Web runner, headless CLI, exit codes, JSON and JUnit summaries.
- Origin-specific capture exports; falsy/null/heterogeneous-array inference; schema-aware TypeScript output tested by compiling generated code. Inferred contracts remain drafts.
- Actual stdio MCP tools for collection discovery, bounded collection runs and HTTP requests. Reports omit response bodies and environment values by default; explicitly marked environment secrets are redacted from CLI/MCP assertion text. This does not guarantee discovery/redaction of every possible secret.
- A VS Code desktop preview sharing the local workbench engine, with Workspace Trust and machine-scoped executable configuration. Built/packageable; installed extension-host validation remains outstanding.
- Atomic per-collection/environment file replacement and surfaced save errors. Compatibility mirror files remain; this is not a multi-file transaction, concurrent-writer database or external file watcher.

## Major capabilities still absent or partial

**HTTP depth:** OAuth 1/2 acquisition/refresh, Digest/NTLM/AWS signing, mTLS/client certificate UI, custom CA/proxy configuration, binary/multipart file upload selection, SSE streaming UI, editable/persistent cookies and full request history/tabs. Browser-native fetch imposes additional protocol behavior differences.

**Protocols:** schema-aware GraphQL explorer, gRPC/protobuf/reflection/streaming, WebSocket/Socket.IO, MQTT and webhook listener workflows. GraphQL can be sent as ordinary HTTP JSON.

**Design and contracts:** spec-first editing/import/validation, multi-file OpenAPI and AsyncAPI, schema diff/breaking-change checks, editable inference provenance and production SDK coverage. Current snippets and inferred clients require review.

**Automation:** complete sandbox/Collection SDK conformance, package libraries, visualizers, scheduled monitors, mocks, load/performance testing, durable run history and distributed runs. Current local runner is bounded, not a production monitoring service.

**Collaboration/governance:** shared cloud workspaces, conflict resolution, comments, forks/reviews, organization roles, SSO/SCIM, audit trails, policy enforcement, API catalogue/discovery and partner/public networks. Manual Git files do not replace these.

**Distribution/operations:** signed desktop installers, verified Marketplace publishing, automatic updates, browser capture extension, hosted agent/service, extension-host testing, cross-platform interactive QA, independent security review, accessibility audit, telemetry opt-in design and support/recovery processes.

This inventory covers major public platform areas; it is not a claim that every Postman feature or defect has been enumerated.

## Recommended product promise

**A free local HTTP workbench that turns requests and observed traffic into repeatable tests and reviewable API drafts, usable from your editor and agent.** Launch this narrow promise as a public beta. Do not launch as a universal Postman replacement.

Order distribution by value and maintenance cost:

1. **Local web app + CLI:** same engine for humans and CI; no account/service budget required. The packaged runtime is ready for release-candidate testing.
2. **VS Code extension:** embed the workbench and later add native request-file actions, diagnostics and saved-run views. Current preview needs real extension-host tests and publisher ownership before Marketplace release.
3. **MCP for Codex and Claude Code:** shared stdio protocol rather than separate proprietary extensions. Tool calls execute APIs and can mutate services; retain client approval controls. This revision implements the server, not a hosted OAuth connector or automatic client registration.
4. **Browser extension, later:** narrow explicit-domain capture with user consent and redaction. The existing proxy does not intercept HTTPS CONNECT; do not promise automatic full browser HTTPS capture. Browser permission, extension review, native bridge and secret exposure require their own design/testing.
5. **Desktop wrapper only if users need it:** signing/updating/crash recovery add maintenance. Avoid simultaneously maintaining five independent clients.

Free software can be sustainable with local execution and user-owned CI. Hosting free monitors, shared cloud storage and AI inference indefinitely has ongoing costs. Keep those optional/self-hosted or fund them explicitly; “free for everyone” is not a capacity plan.

## Evidence gates for a defensible 9/10 in the focused category

- Publish a versioned supported-behavior contract and test it against consented, sanitized real collections. Report unsupported features and semantic differences; require zero silent corruption on the declared subset. Cross-run against pinned Postman/Newman versions before making compatibility claims.
- Finish everyday collection/folder authoring, request rename/reorder, unsaved-work handling, file watching/conflicts, request history and secure credential storage. Inject disk failures and verify recovery without data loss.
- Add inference validation/editing, provenance per field, origin/session filtering, capture redaction and export correctness. Compile generated clients and exercise them against their captured fixture servers.
- Conduct independent security review and adversarial script/network/resource tests, real VS Code host tests and Windows/Linux/macOS smoke tests. No unresolved critical/high release-blocking findings.
- Observe at least 10 independent developers completing migration → request → test → CI → contract export without assistance; record success rate, errors and time. Set a release target of ≥90% successful completion of supported tasks and investigate every data-loss event.
- Collect multi-week reliability and repeat-use evidence. Compare identical tasks with Postman, including both browser/desktop memory where relevant. Publish methodology, failures and version scope.

These are proposed acceptance criteria, not achieved metrics. Broad enterprise-platform 9/10 would additionally require the collaboration, governance and operations capabilities above; it is a separate, much larger objective.

See [research provenance](POSTMAN_RESEARCH.md), [usage/integrations](INTEGRATIONS.md), and [verification](VERIFICATION.md).

Additional public platform surfaces—visual Flows, AI-assisted authoring/agent workflows, published documentation, API security/governance integrations, webhook handling and SDK distribution—also require separate scope and validation. None is implied by Rea's MCP adapter, inferred OpenAPI document or TypeScript draft.
