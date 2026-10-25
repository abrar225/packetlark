# Rea implementation program: local reliability to broader platform capability

Status: **approved; scoped P0 local-core gates passed, P1 in progress**. The trust-foundation implementation and baseline evidence are recorded in [P0_GATE.json](P0_GATE.json). See [P0 progress and remaining gates](P0_PROGRESS.md); this roadmap is not a statement of completed parity. The first P1 renderer increment and remaining workspace work are recorded in [P1_PROGRESS.md](P1_PROGRESS.md).

Date: 25 October 2026. Baseline: `c25e02ca2415dd7b2e2826c96ea4ff0df34de311` (Rea 1.1 preview). Capacity: one maintainer assisted by coding agents. Scope: all ten comparison areas, delivered in stages. This document describes intended work, not completed capabilities or a new product rating.

## 1. Product decisions settled with the user

1. First audience: individual developers and small teams using local APIs, editor/agent workflows and CI. Enterprise/cloud capabilities remain on the full roadmap.
2. Commercial boundary: free/open-source local core; optional self-hosted collaboration and monitoring. Any Rea-operated cloud or AI service needs a separate funded operating plan.
3. Planning capacity: one maintainer plus agents. Estimates are engineer-week ranges, not calendar commitments or an assumed AI productivity multiplier.
4. First stable release: dependable HTTP, OAuth 2/PKCE, secure local secrets, complete collection editing, migration checks and CLI/CI. Dedicated GraphQL/WebSocket/gRPC/MQTT clients follow.
5. Signature workflow: **capture → redact → infer a reviewable contract → generate regression fixtures → validate generated clients**, with evidence/provenance and uncertainty visible.
6. Defaults: no telemetry or implicit cloud upload; review/grants for imported scripts and agent destinations; secret-safe exports. Users can explicitly authorize local/private services. Compatibility mode can relax a particular control only through informed local consent.

The user confirmed Q7: “Yes — plan and test interfaces match; start P0.” All six decisions and the eight public test interfaces below are approved. The requested grilling/TDD confirmation is complete; routine implementation within this scope needs no additional confirmation.

## 2. Outcome and definition of competitive

First launch promise: **a private local HTTP workbench with trustworthy saves, secure credentials, compatible repeatable tests, and evidence-driven API discovery, available through one engine in the browser, CLI, editor and agent**.

A parity claim must name the supported version, feature subset, surface and tested behavior. “Supports OAuth” must distinguish acquire/refresh/revoke; “supports GraphQL” must distinguish raw JSON from an explorer; “MCP support” must distinguish client from server; “Git-native” must distinguish readable files from conflict/recovery workflows. Do not mark a feature done from a button, mock, README claim or happy-path test.

The previous 5.5/10 broad-readiness assessment remains a subjective baseline. A 9/10 target is a validation objective, not an acceptance condition the author can award automatically. Faster-than-Postman claims require matched independent measurements. Zero mistakes cannot be guaranteed; prevent, detect, recover and disclose instead.

### Traceability

[requirements.json](roadmap/requirements.json) preserves **all 92 rows** from the reviewed comparison. Each has a unique `REA-001`…`REA-092` ID, current evidence, documented comparator, workstream, candidate phase and source links. Existing features require revalidation, not automatic green status. Broad rows may require several releases; candidate phase means first increment, not full completion.

Additional immediate defect tickets are in section 5. The inventory covers major reviewed capabilities, not every private Postman implementation detail. Expand it when verified user workflows reveal omissions.

## 3. Architecture: keep one product engine and reduce duplicated decisions

Keep TypeScript/Node initially. No Rust rewrite, microservice split, new frontend framework or plugin marketplace without a measured need. Source line count is not complexity: remove duplicated execution/storage/policy decisions and keep ownership clear.

Target dependency flow:

```text
Browser workbench / CLI / VS Code / MCP server
                    ↓
Versioned commands, jobs and immutable resource/revision IDs
                    ↓
Execution policy + credential references + workspace repository
                    ↓
Execution coordinator → protocol adapter → transport
                    ↓
Bounded script worker / progress events / redaction / reports

Capture adapter → bounded byte stream → sanitization → observations
                                         ↓
                           contract review → fixtures → client validation
```

Proposed modules (names are design proposals, not existing implementations):

- **WorkspaceRepository:** sole owner of canonical collection/environment writes, optimistic revisions, migration, recovery and external-change reconciliation. Routes, CLI and MCP call this interface rather than write files directly.
- **ExecutionCoordinator:** one request/run identity, cancellation, budgets, scope mutation policy and event stream across all clients. Sharing execution logic does not mean forcing HTTP-only fields onto other protocols.
- **Transport:** bounded byte streaming, backpressure, request/response deadlines, redirects, TLS configuration and credential stripping. Both request execution and capture use the same tested budget/policy primitives. Capture may need a separate adapter to preserve raw proxy semantics.
- **CredentialStore:** secret references and platform keychain integration. If no secure store exists, fail closed or remain session-only; never silently fall back to plaintext. Portable encrypted storage needs a reviewed design and dependency decision.
- **PolicyEvaluator:** per-workspace script/agent destination grants, method/write intent, redirects, DNS resolution and per-run budget enforcement. Local/private API access is explicitly grantable. Tool annotations alone are not enforcement.
- **ScriptWorker:** isolated QuickJS context per execution, bounded worker queue and host bridge. Move CPU-heavy scripts off the UI/server event loop; assess worker versus process isolation by threat model. Workers alone are not a hostile-code security boundary.
- **ProtocolAdapter:** capability metadata, validation, send/connect/subscribe/cancel and structured events. Use maintained protocol libraries after version/license/security review, not handwritten wire protocols. Lazy-load optional clients so HTTP users do not pay every protocol's startup cost.
- **ObservationStore and ContractPipeline:** sanitized observations, source provenance, inferred-versus-confirmed fields, approved fixture generation, spec validation and executable client checks.
- **UI state:** keyed drafts, selections, executions and tabs with explicit ownership. Replace global mutable “active request” assumptions incrementally; keep editor changes local until commands commit them.

### Storage design

Use versioned per-request/collection/environment files plus a resource manifest for user-authored portable data. Choose the exact Rea schema through an ADR and retain v2.1 import/export; do not pretend it is Postman's v3 YAML. Preserve unsupported source fields in a quarantine/round-trip envelope with explicit warnings.

Use a rebuildable local index/history/job store, potentially SQLite behind an adapter, for operational data. It must not become a second authoritative collection database. Select a Node 22/24-compatible implementation after packaging/crash tests; do not depend on an unstable runtime API accidentally.

Migrate with backup, dry-run, checksums, schema validation and rollback fixtures. Remove legacy mirror writes only through a documented compatibility transition. No destructive migration of the user's workspace during development tests.

### Complexity rules

One persistence owner, one policy evaluator and one execution coordinator. UI and adapters do not bypass them. No public “generic plugin” interface until at least two actual adapters demonstrate the need. Use discriminated models and strict typing for new modules; tighten legacy typing by touched module. Prefer native scrolling/virtualized long lists; decorative motion stays outside execution-critical paths.

## 4. Releases, dependency order and effort

Estimates include implementation and relevant tests, assuming full-time engineer effort. They exclude waiting for external audits, user recruitment, signing credentials and ongoing support. Re-estimate after each phase; do not add calendar dates until capacity is real.

- **P0 — Trust and baseline, 2–4 engineer-weeks.** Threat model, shared budgets/redaction, capture byte fidelity, request/save identity, storage correctness and performance baseline.
- **P1 — Workspace foundation, 3–5 weeks.** Repository/revisions, safe migration, full collection/folder editing, tabs/history, draft recovery and external-file reconciliation. Depends on P0.
- **P2 — Daily HTTP/auth/secrets, 4–7 weeks.** Keychain-backed secrets, OAuth 2/PKCE/refresh, file bodies, cookie controls, TLS configuration and stream-safe HTTP UX. Depends on P0–P1.
- **P3 — Compatible scripts and CI, 3–5 weeks.** Pinned compatibility suite, explicit Send/Run scope policy, durable run reports, bounded script workers, negative-path CLI/MCP tests. Depends on P1–P2.
- **P4 — Evidence-driven discovery, 3–6 weeks.** Capture sessions/filters, reviewable inference, OpenAPI import/validation, fixture export, drift checks and executable generated-client validation. Depends on P0–P3.
- **P5 — Stable local release, 2–4 weeks.** Browser/editor/OS QA, simple onboarding/install, consent/policy UX, performance gate, independent security review and target-user task tests. Depends on P0–P4. External-review lead time is additional.
- **P6 — GraphQL and realtime, 3–5 weeks.** GraphQL schema explorer and WebSocket/Socket.IO/SSE workflows with reconnect/cancellation and separate protocol tests. Depends on stable adapter/event architecture.
- **P7 — Additional protocols and integrations, 5–9 weeks.** gRPC/protobuf/reflection/streaming, MQTT, MCP inspector, browser capture/native bridge, v3-format interoperability evaluation and specialized auth. Split into independent demand-ranked releases; no single huge PR.
- **P8 — Broader API lifecycle, 7–12 weeks.** Local mocks/simulation, docs publishing/export, richer specs/SDKs, scheduler/alerts, load-tool integration, package libraries/visualizers and incremental visual workflows.
- **P9 — Optional self-hosted teams, 12–24 weeks.** Authenticated server, durable database/jobs, sync/conflict semantics, comments/reviews, permissions, organizations/catalog, backup/restore and operational documentation. Requires a separate hosted threat model.
- **P10 — Advanced platform, 8–16 weeks.** SSO/SCIM, audit/governance, external/shared vaults, encryption administration, private runners, built-in AI/context workflows and further enterprise integrations. Scope and funding decision before execution.

P0–P5 total **17–31 engineer-weeks before contingency**. All listed phases total **52–97 engineer-weeks before contingency**, not equivalent to full proprietary-platform parity. With 25–30% uncertainty, roughly **65–126 engineer-weeks** of effort is a more honest whole-program planning envelope. Part-time work takes longer; agents do not eliminate review, testing or support. The ten-area roadmap is a long-term program, not a single side-project sprint.

## 5. Immediate, source-grounded defect backlog

These are **baseline** source-audit findings; line references refer to the pre-P0 source. They are not a completed security audit. Current disposition and executable evidence are tracked in [P0 progress](P0_PROGRESS.md).

- **TR-001: bounded capture transport.** `src/core/sniffing/TrafficSnifferProxy.ts:99` accumulates inbound bytes, `:155` reads the full upstream body and `:140` has no explicit abort signal. The 500-record cap at `:34` is not a byte budget. Add stream caps, deadlines, connection/concurrency caps and abort-on-disconnect/shutdown. Test large and slow streams, compression expansion and cleanup.
- **TR-002: binary forwarding fidelity.** Capture decodes a request to UTF-8 at `TrafficSnifferProxy.ts:104` and forwards text at `:143`. Keep transport bytes unchanged; decode only a bounded inspection copy. Test exact binary request and response bytes, duplicate/hop-by-hop headers and compressed responses. Existing binary coverage checks only response length.
- **TR-003: redact before retention.** Capture records URL/query/headers/body at `TrafficSnifferProxy.ts:202–217`. Sanitize before storage, subscriptions, inference or agent access. Reject/omit unparseable sensitive payloads from retained inspection data when safe structural redaction cannot be performed; forwarding still uses original authorized bytes. Offer explicit local-only diagnostic retention with expiry, never a quiet bypass.
- **TR-004: draft/save/execution ownership.** `public/app.js:281` starts save without awaiting selection changes; success at `:353` uses global clean state. Requests execute/render against global state at `:744–850`. Add immutable draft/revision/job IDs; delayed completion may update only its owner. Recover failed old drafts and keep new drafts dirty. Cancel by execution ID.
- **TR-005: consistent persistence.** `StudioServer.ts:278` atomically replaces canonical files, but mirrors at `:299`/`:344` are separate writes. Mutation routes update memory before durable commit, while deletes can swallow disk errors (`:317–328`, `:355`). Define commit point, rollback/recovery and meaningful API outcomes; no false success or successful canonical write reported as total loss merely because a compatibility mirror failed.
- **TR-006: conflict/reload integrity.** Malformed file input is silently ignored (`StudioServer.ts:124`); collection reload (`:756`) lacks complete deletion/revision reconciliation. Validate IDs/paths/symlinks, reject stale writes with conflict metadata, surface corruption and never overwrite valid user data with starter examples.
- **TR-007: honest script/scope semantics.** `web/sandbox-bootstrap.js:12–20` string-coerces writes and exposes plain-object `pm.request`; typed data becomes strings in `CollectionRunner.ts:164`. Single Send persists only environments while runs retain several scopes in memory (`StudioServer.ts:566–589`, `:643`). Define and expose the policy, then cross-run typed/precedence/mutation fixtures before claiming compatibility.

Implementation sequencing amendment after investigation: capture bounds and redaction share the observation commit point, so the first commit covers TR-001/002/003 together. Client ownership and workspace revision handling must agree on save/delete responses and conflict semantics, so the next commit covers TR-004/005/006 together. These are separate commits in one draft review bundle, with test fixtures covering their integration. This replaces the initial four-PR suggestion; unrelated UI redesign and protocol additions remain out of scope.

## 6. Ten workstreams and acceptance gates

### WS1 — HTTP requests and responses

Deliver complete supported methods/query/path/header editing; JSON/text/form/binary/multipart uploads; streaming response preview/download; cookie editor and controlled persistence; cancellation, redirect budgets, TLS/custom CA and actionable DNS/connect/TLS diagnostics. Header/query models preserve duplicates and ordering where meaningful. Document HTTP/2/custom method support explicitly rather than inheriting assumptions from fetch.

Acceptance: exact bytes and repeated fields reach fixture servers; cancellation interrupts all body phases; oversized/slow/compressed payloads stay bounded; cross-origin redirects do not leak credentials; no automatic redirect-based write outside grants; cookies obey domain/path/secure rules; unsupported settings fail explicitly. File selection sends only chosen files; no arbitrary imported file paths are read.

### WS2 — Authentication and enterprise endpoints

P2: secret references, OAuth 2 authorization-code + PKCE and client credentials, state/nonce validation, loopback callback ownership, timeout/error recovery, token expiry/refresh, concurrent-refresh single-flight, clear/revoke explanation and no token leakage. Add mTLS and custom CA through explicit settings. Existing bearer/basic/API-key remain.

Later: OAuth 1.0a, JWT signing, AWS Signature, Digest/NTLM and other documented auth modes from verified demand. Use maintained standards implementations; do not invent cryptography. JWT signing is not JWT validation. Preserve account/environment separation and forbid credential injection into unapproved destinations.

Acceptance: fake OAuth providers exercise success, denial, bad state, wrong callback, expired/rotated tokens, refresh failures and parallel calls; mTLS fixture fails without its certificate and succeeds with the selected one; default TLS verification remains enabled. Golden signing vectors and credential-redaction tests are required for each specialized helper.

### WS3 — Dedicated protocol tooling

P6: GraphQL introspection/schema cache, variables, query validation, operation selection and error UI; WebSocket/Socket.IO lifecycle, message history, auth and bounded reconnect; SSE incremental framing and event inspection. P7: gRPC unary/client/server/bidirectional streams with protobuf/reflection; MQTT TLS/auth/topic/QoS/session behavior; MCP inspector and optional model-request helpers. P8 adds the webhook listener workflow.

Acceptance: real local fixture peers; correct connect/subscribe/publish/disconnect and cancellation, binary messages, backpressure, bounded histories, auth failures and reconnect duplication tests. Define unsupported protocol features and per-surface capability tables. Mixed-protocol runs begin only after event/job models support them. No claim that raw GraphQL HTTP or a local MCP server supplies these dedicated clients.

### WS4 — Collections, environments and daily editing

Deliver full collection/folder/request CRUD, rename/duplicate/reorder/move, stable IDs, search, multi-request tabs, per-tab response ownership, history/examples, undo/draft recovery and keyboard access. Add optimistic revisions, external-file watching and conflict UI. Migrate to per-request versioned files/manifest without losing imported metadata; export v2.1 with warnings. Evaluate Postman v3 interoperability as a separate parser/serializer, not the internal storage schema.

Acceptance: save A → switch/edit B → delayed A completion leaves B dirty and A recoverable; execute A → select B cannot replace B's result; concurrent edits return conflict rather than overwrite; delete/rename/external invalid JSON are reflected truthfully; crash/restart restores only committed data and recoverable drafts. File failure and migration round-trip fixtures prove no silent data loss.

### WS5 — Scripting and assertions

Publish a supported `pm.*` contract by version. Match inherited event order, response helpers, typed iteration values, variable precedence/unset/clear, request mutation, error behavior and declared Send/Run persistence. Retain isolated interpreters, move CPU work off the main loop, cap bridge messages/tasks/results, and include deterministic seed/clock hooks in test mode.

Add dynamic variables incrementally. Later package libraries use an explicit reviewed allowlist/bundler model in the interpreter, not Node `require`; no arbitrary host package access. Visualizers render in a separate restricted sandbox with safe message boundaries.

Acceptance: pinned reference runtime differential fixtures with sanitized inputs compare outgoing bytes, event order, assertions and scope deltas; unsupported APIs produce explicit diagnostics. Infinite loops, promise chains, timer floods, heap exhaustion, malformed bridge payloads and cancellation release resources. Context/state never leaks between runs. Security review is independent of npm advisory results.

### WS6 — Automation, CI and testing

Deliver saved local run history with bounded retention, JSON/CSV previews and typed data, folders/selections, iterations, request chaining, per-test diagnostics, JSON/JUnit and stable exit codes. Expose the same operations through UI/CLI/MCP. Add local scheduler/alerts, mocks and mixed protocols later. Integrate a mature load tool behind an adapter instead of treating sequential iterations as performance testing; define load authorization and budgets.

Visual workflows start from the same versioned run graph, with a small conditional/loop/transform subset rather than a separate execution engine. Durable jobs must survive restart without silently rerunning destructive requests; use idempotency/retry policies appropriate to each task.

Acceptance: headless CI runs without the browser/account, proper failure/cancel exit codes, CSV quoting/typing, no report secrets, isolated parallel runs, deterministic chaining limits and bounded retained bodies. Scheduler timezone/missed-run/duplicate delivery and alert-spam cases require tests. Load results identify generator limits separately from server latency.

### WS7 — Traffic capture and discovery

First harden bytes, time, concurrency, redaction and disconnect behavior. Then add pause/start/stop, URL/method/status/origin filters, sessions, retention and selected capture → request/fixture actions. Store redaction policy version and structural provenance; never retain a raw-secret hash as a supposedly safe export. Preserve repeated query/header values. Retained observations are immutable sanitized snapshots: subscribers, UI consumers and inference cannot mutate shared nested records.

Browser capture is a separate consent-based extension/native-bridge project with per-domain grants and explicit record indicators. HTTPS CONNECT/MITM requires an independent certificate/trust design and manual informed installation; do not silently install a root CA. First stable release does not depend on TLS interception.

Acceptance: binary fidelity, slow/huge uploads/responses, disconnect/shutdown cleanup, cap enforcement, secrets excluded before observers/inference, and attempts by one consumer to mutate nested observations cannot change another consumer's view or a later export. Extension tests verify authorized domains only, stopping capture truly stops it, no background capture and no unexpected cloud egress. Capture forwarding uses original authorized bytes even when retained observations are sanitized.

### WS8 — Contracts, documentation, mocks and SDKs

Deliver OpenAPI 3.0/3.1 import, validation and a minimal review editor. Distinguish observed vs inferred vs confirmed fields, field provenance and uncertainty; distinguish “seen in all samples” from business-required. Let users correct route grouping, unions, content types, errors, auth and server origins. Generate regression fixtures from approved observations and fail CI on reviewed incompatible changes.

Later: multi-file refs, additional spec formats, maintained spec/collection links, local/static docs with examples, local programmable mocks with delays/errors/state isolation, SDK distribution. SDK generation should use a maintained generator/template adapter where possible; keep the current TypeScript draft until migration is tested rather than add handwritten generators for every language.

Acceptance: spec validates with an independent validator; no origin collision; external ref resolution is constrained; contract inference never marks unseen behavior proven; fixture replay verifies scrubbed matching rules. Generated clients compile **and execute** against fixture servers for paths, auth, bodies, errors, cancellation and binary data. Mocks cannot access arbitrary files/network by default; docs/examples omit secrets.

### WS9 — Secrets, teams and governance

P0–P2 local security: threat model, secret-safe data flow, keychain references, grants, audit of local execution decisions without secret values, and safe workspace permissions/backup. Raw secret migration requires explicit review and no lossy automatic deletion.

P9–P10 optional self-hosted platform: authenticated HTTP transport, TLS, users/orgs, RBAC, workspace ownership, sync/review conflicts, comments, catalogue/search, durable queue, backups/restore, audit retention, SSO/OIDC/SAML, SCIM, external vaults, governance/rules and encryption administration. Reuse maintained identity/policy systems; do not build password/security infrastructure from scratch. Separate local account-free mode from authenticated shared-server mode.

Acceptance: authorization checked server-side on every resource/job, tenant isolation, invitation/revocation, role changes, audit integrity and backup recovery; secrets cannot enter shared files without explicit approved policy. OIDC/SAML/SCIM use real provider fixtures/conformance tests. Do not market certifications or regulatory compliance without the relevant external process.

### WS10 — Distribution, agents and maturity

Use one runtime across local web/CLI/VS Code/MCP. Ship simple local onboarding, doctor/diagnostics, reproducible packages, source/license notices, upgrade/rollback and versioned compatibility tables. Complete installed VS Code host tests and supported OS smoke tests before Marketplace publication. Define Node-required versus standalone packaging in the release documentation; a signed desktop wrapper follows demand/funding.

Expand MCP with typed outputs, concise/paginated tools, job IDs/progress/cancel, permissions and redacted resources. Keep stdio for local; remote authenticated transport belongs to the self-hosted phase. MCP Inspector and real client fixtures must supplement the existing handshake check. Built-in AI/Context Graph is later opt-in, preferably bring-your-own-model, with schema/context export and explicit cost/privacy disclosure.

Acceptance: clean machine install → import → authorize → send → test → CLI → export without assistance; version mismatch and missing Node/keychain/provider produce actionable diagnostics; no implicit telemetry/upload; real clients can cancel long work and denied destinations cannot be bypassed with redirects/script requests. Hosted support/signing/cloud prerequisites are tracked rather than described as implemented.

## 7. Performance and code-complexity plan

Treat the following as **proposed budgets to ratify against a recorded reference machine in P0**, not measurements achieved today. Network/server time is separate from tool overhead.

- Cold local service ready: p95 ≤2 seconds after dependencies are installed; local browser usable: p95 ≤3 seconds on the reference machine. Record cold and warm caches separately.
- Warm HTTP execution overhead without scripts: aim for p95 ≤15 ms against paired direct-transport measurements on a deterministic loopback fixture. Report p50/p95/p99 and uncertainty; do not subtract unrelated averages and call it tool latency.
- Small warm assertion script: initial target p95 ≤50 ms including interpreter/bridge overhead; isolate initialization, evaluation and HTTP durations. Revisit with evidence if security/isolation trades off against latency.
- Request switching/filtering with 10,000 saved requests: p95 ≤100 ms for the supported operation, with bounded DOM work and virtualization.
- Initial idle target: ≤100 MiB backend RSS and ≤250 MiB combined backend plus the relevant browser/extension processes on the reference setup. Report shared-browser attribution limitations rather than omit browser cost. Optional protocol clients must remain lazy-loaded.
- Capture defaults to investigate: 4 MiB inbound, 10 MiB decoded upstream, 1 MiB retained preview per record, 32 MiB total sanitized history, bounded active forwards and explicit timeout. Default over-limit policy: reject oversized inbound bodies and abort over-limit upstream reads, explicitly marking incomplete captures/responses; never silently truncate a response and present success. Users may raise reviewed limits for an authorized workload. Stream and cancel decompression safely.
- After warm-up, repeated 1,000-request batches should plateau within a documented retained-data budget. Use heap profiles and resource counts; do not assert a universal leak threshold from one noisy RSS sample.
- No hot-path ornamental animation; JSON formatting/inference/large diff work runs off the main event loop or is incremental. UI consumes progress events rather than repeatedly polling/copying entire response sets when event streaming is justified.

Benchmark harness: pin Node, OS, CPU/RAM, Rea and reference-tool versions; use the same payloads/auth/scripts and loopback fixture; randomized paired runs, warm-up and at least 30 repeated samples per scenario (more for tail estimates), export raw results plus methodology. Include startup, 1 KiB/1 MiB/binary bodies, OAuth refresh, one assertion, 100-request runs, 10k-item editing and long capture. Never benchmark production writes without authorization.

Use Node performance marks, event-loop delay/utilization, CPU/heap profiles and process-tree RSS. CI on shared runners initially reports trends; dedicated repeatable runs enforce regressions. A >10% repeatable change triggers investigation, not automatic refusal to improve correctness. A “faster than Postman” claim needs matched task results and statistical uncertainty, not a visual impression. Primary reference: [Node 22 performance APIs](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html).

Complexity checks: no duplicated policy/transport/storage rules; command ownership is explicit; tests survive replacing an implementation; dependency counts/licenses/audit are recorded; unused adapters are not loaded; ADRs explain genuinely consequential choices. Set file/fan-out review thresholds after P0 measurement. Do not chase fewer lines by hiding errors or using unsafe generic code.

## 8. Differentiators worth testing, with evidence gates

These are product experiments, **not claims that Postman lacks every similar capability**.

- **Evidence-backed contract workbench:** click a field to see sanitized supporting observations, counterexamples, provenance and confidence. User confirmation—not sample frequency—sets contract requirements. Gate: target users correct a real draft with fewer silent mistakes than the current export-only flow.
- **Counterexample and regression pack:** generate offline fixtures from approved captures, then test draft contracts and clients against success/error/boundary cases. Synthesize cases only as labeled hypotheses. Gate: a deliberately broken client/contract fails for the right reason and a correct one passes reproducibly.
- **Safe execution preview:** summarize destinations, redirects, mutation methods, script networking, credential references and estimated budgets before import/run. Gate: blocked destinations cannot be reached through `pm.sendRequest`, redirects or alternate adapters; explicit local/private grants work.
- **Deterministic time capsule:** export sanitized spec, scripts, fixture responses, seeded variables, clock settings and tool version for offline reproduction. Gate: another machine reproduces the failure without live secrets or a cloud account. It is not a replay of arbitrary production side effects.
- **Reviewable agent change sets:** agents propose collection/test/spec changes as a diff; approved changes use revision-checked commands and produce an execution receipt. Gate: agents cannot silently broaden grants or overwrite a concurrent user edit. Prefer workflow quality to a large tool count.
- **Contract impact view:** trace an approved schema change to affected tests/generated clients and explain which observations changed. Gate: seeded breaking changes are detected without treating optional observed fields as proven required.

Do not start all six experiments at once. P4 validates the first two; safe execution is required infrastructure; the others follow user feedback.

## 9. Skill set, research tooling and dependency policy

Installed at the user's request:

- `grill-me` plus its required `grilling` delegate from [mattpocock/skills](https://github.com/mattpocock/skills): used for the six settled product decisions and final confirmation.
- `find-skills` from [vercel-labs/skills](https://github.com/vercel-labs/skills): used to search architecture, TDD, security, MCP, OpenAPI and performance.

Selected supporting skills, installed and inspected:

- [TDD](https://skills.sh/mattpocock/skills/tdd): behavior-first tests at agreed public interfaces, one failing case → minimal implementation at a time. Search displayed approximately 1.1M installs.
- [Improve codebase architecture](https://skills.sh/mattpocock/skills/improve-codebase-architecture): candidate for focused refactor reviews, approximately 1.2M displayed installs. Its separate candidate-report/interview workflow has **not** been run as if a full architecture review were complete.
- [MCP builder](https://skills.sh/anthropics/skills/mcp-builder): used to shape typed tool outputs, pagination, annotations, errors and evaluation requirements; approximately 131.3K displayed installs. No new MCP implementation is claimed by this plan.
- [Security review](https://skills.sh/github/awesome-copilot/security-review): installed as a scoped review workflow, approximately 5.5K displayed installs. Inspected only; the prescribed full dependency/secrets/data-flow audit and patch review were **not** completed in this planning pass. Its workflow presents patches for human review rather than silently applying them.
- Existing Gravitas: scoped evidence/verification records. Existing frontend/browser skills: later UI/accessibility QA, used only when their workflows are actually needed.

Repository reputation was checked: the live GitHub responses showed roughly 302,591 stars for mattpocock/skills, 183,538 for anthropics/skills and 40,375 for github/awesome-copilot. Popularity is a discovery signal, not proof of safety/correctness. Source content and fit still determine usage. Search results for Azure, Go, Lark and low-evidence performance skills were not installed merely because they ranked highly. New skills become discoverable on the next agent turn; their files were read directly in this session.

The supplied reverse-engineering folder remains available. Its current skill says ordinary complete source analysis should use repository tools; reserve REA for behavior depending on a shipped package/binary or runtime evidence. Future differential research pins artifact version/hash, captures explicit scope/provenance/limitations, and uses sanitized fixtures. Existing published-runtime analysis is documented in [POSTMAN_RESEARCH.md](POSTMAN_RESEARCH.md); it does not establish whole-platform coverage. No proprietary service reconstruction, bypassing accounts, hidden endpoint access or unapproved certificate installation is needed for the first release.

Library selection gate: official maintenance/docs, license compatibility, dependency/advisory review, Node 22/24 and OS packaging tests, memory/latency fit, cancellation semantics, replacement cost. Evaluate protocol/auth/schema libraries per workstream; do not install a large speculative dependency set now. Pin selected versions and record an ADR. Reuse standards implementations and generators where they reduce risk; own the integration and policy tests.

## 10. Public test interfaces to confirm before product TDD

These are proposed observable test surfaces (called “seams” by the TDD skill). They are **not new tests written in this planning pass**.

1. **Loopback transport/capture:** send real bytes through the public HTTP/proxy interface to fixture servers and inspect returned bytes plus sanitized capture API data. Catches fidelity, limits, deadlines, redirects and policy. Does not prove every remote proxy/TLS deployment.
2. **Workspace command/API plus restart:** create/edit/delete with revision tokens, inject filesystem faults through a storage adapter, then restart and read through the public interface. Catches durability, conflicts and recovery. Does not prove arbitrary disk hardware failure recovery.
3. **Browser UI workflows:** interact with tabs, drafts, delayed saves/executions, dialogs and imports. Catches ownership/focus/accessibility/task regressions. Does not prove physical-device accessibility or all OS/browser versions.
4. **Headless CLI process:** real subprocesses, output artifacts, cancellation and exit codes with fixture collections/providers. Catches packaging, real process behavior and CI usability. Does not prove cloud scheduler reliability.
5. **Script/collection compatibility:** pinned reference runtime and Rea execute the same sanitized cases; compare allowed wire bytes, events, scope deltas and assertions. Catches semantic differences in the declared subset. Does not prove full desktop/cloud conformance.
6. **MCP/editor integration:** actual stdio/HTTP clients and VS Code extension host invoke real public commands and denial/cancellation paths. Catches integration/permissions/tool contract behavior. Does not prove every third-party client/version.
7. **Contract/client pipeline:** independent schema validator and generated client execute against the fixture that produced the approved contract. Catches export/client runtime mismatch. Does not infer business truth from traffic.
8. **Performance/resource harness:** fixed fixtures and recorded process tree. Catches repeatable overhead/leaks/regressions within that environment. Does not establish global speed superiority.

Test one vertical user behavior at a time. Do not replace transport/provider integration cases with mocks of internal functions, mirror implementation calculations, write all imagined tests before implementation, or treat snapshots as semantic compatibility. Keep sanitized corpora licensed/consented and free of production credentials.

## 11. First two implementation increments after confirmation

### Increment A — bounded, byte-correct capture

- Read current proxy/executor callers and tests; write a fixture demonstrating binary upload corruption through the public proxy interface.
- Introduce shared budget/lifecycle primitives without migrating unrelated routes.
- Preserve raw authorized forwarding bytes; retain only bounded inspection copies.
- Add oversized/slow input/output, decompression, disconnect and shutdown cases one at a time.
- Validate concurrency/resource release, then compare executor/capture budget behavior. Publish configured limits and over-limit outcomes in the UI/docs.
- Exit: byte equality, deterministic error behavior, upstream cleanup and bounded retained state; existing request execution still passes.

### Increment B — secret-safe observations and ownership

- Redact configured header/query/cookie/form/JSON paths before retention/subscription/inference; diagnostics must not leak raw values.
- Test secret-bearing URL credentials, nested payloads, parse failures, response headers/errors and exported fixture/spec/report paths. Preserve transport bytes separately.
- Add the stable draft/save/execution identity fix in its own PR with delayed-completion browser tests; it can proceed independently of later auth/protocol work.
- Exit: approved safe captures produce useful drafts without leaking seeded secrets; save A cannot mark draft B clean or overwrite its response.

Estimated first backlog is **not a commitment to finish P0 in one turn**. Each PR records trigger, before/after behavior, tests, risks and rollback. Do not automatically merge/publish a “stable” release merely because unit tests pass. Publish prereleases with precise open gates.

## 12. Release decision, maintenance and risk register

Before stable local release: supported-task contract published; all first-release requirements met; no unresolved release-blocking security/data-loss findings; malformed/unsupported imports explicit; browser and installed editor-host QA complete; supported OS install/restart/upgrade tests complete; independent security review scoped and findings dispositioned; benchmark results and limitations recorded; at least ten independent target developers attempt import → auth → request → test → CI → reviewed export, with a proposed ≥90% supported-task completion target and investigation of every data-loss event. Observe repeat use over multiple weeks. Ten developers is exploratory validation, not a representative market study.

Risks and responses:

- **Scope explosion:** keep P0–P5 gates fixed; later requirements remain tracked, not smuggled into the first release.
- **Compatibility versus safety:** explicit mode/grants and documented differences; never silently disable safety to pass a fixture.
- **Secrets/keychain portability:** verify OS providers; session-only fallback; recovery UX before credential migration.
- **Native dependencies/signing:** packaging spikes early, signing/publisher credentials tracked separately, no unsafe postinstall downloads.
- **Data migration/conflicts:** backups, revision checks and fault injection before changing format; never test against live `.rea-api`.
- **Protocol/library churn:** per-adapter contracts, pinned dependencies and limited optional loading.
- **Hosted costs/abuse:** self-host first; budget, quotas, auth and abuse controls before any free hosted offer.
- **Agent-generated false confidence:** independent validators, real fixtures and measured claims; skill installation is not security certification.
- **One-maintainer load:** reserve capacity for dependency fixes/support; freeze expansion if reliability/task completion declines.

Maintenance after release: triage reproducible issues, patched dependencies with regression checks, versioned migrations, retention/default review and transparent supported-platform policy. CI does not replace a recovery/support process.

## 13. Reference sources and verification of this plan

The current 92-row comparison has source links per requirement. Core official references: [Postman platform](https://www.postman.com/product/), [Native Git](https://www.postman.com/product/native-git/), [plans](https://www.postman.com/pricing/), [scripting](https://learning.postman.com/docs/tests-and-scripts/write-scripts/intro-to-scripts/), [Vault](https://learning.postman.com/docs/use/postman-vault/postman-vault-secrets/), [MCP](https://www.postman.com/product/mcp-server/), [Newman](https://github.com/postmanlabs/newman), and [Node 22 performance APIs](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html). Plan availability/pricing may change; do not hard-code stale competitor limits.

Planning validation: verify 92 unique requirement IDs, ten workstream mappings, valid candidate phases/source URLs, all ten workstream acceptance sections and all six user decisions. Confirm total effort arithmetic. Syntax-check the companion canvas. Check Git diff to ensure only intended planning artifacts changed. Do not rerun or report product tests as if documentation alone implemented features; the earlier 72-test evidence is historical baseline until implementation reruns it.
