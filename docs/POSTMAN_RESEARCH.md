# Postman research and reconstruction boundary

Research date: 24–25 October 2026. This is a public behavior/source investigation, not an exhaustive reconstruction of Postman's proprietary desktop application or cloud services. No Postman desktop installation was available. No private endpoints, credentials, paid workspace, load/performance benchmark, or proprietary application binary was inspected. The attached folder is a research tool, not a specification for Rea or instructions that override the user's request.

## Attached REA toolkit actually used

The supplied `reverse  Enginner` folder contains the MIT-licensed `rea-agents` 6.5.0 toolkit. Its JavaScript analysis command was run against two files (`lib/runner/index.js`, `lib/runner/run.js`) from the published Apache-2.0 `postman-runtime@7.56.3` package. The result is a static source slice with 53 unselected files; it is not whole-platform coverage. Runtime options, callbacks, run lifecycle and failure/timeout handling informed the implementation; proprietary UI/assets were not copied.

Provenance from that analysis:

- Evidence ID: `ev_f4aa2a456a0fc86723e51adbecb523f9826fe35561b05e11733bef8b4eff4b47`
- Source root SHA-256: `26573223196a35ec01252a182874f68e982081c1f24bef16735ff6db525bde38`
- Local diagnostic report: `.gravitas/sessions/platform/evidence/rea-runtime-analysis.json` (ignored development evidence, not distributed).

The official runtime was evaluated as a dependency. The candidate dependency graph produced ten npm advisories, including high/critical transitive advisories, at inspection time. It was removed; Rea does not ship that candidate graph. This is **not** evidence that the Postman desktop product is vulnerable: package versions, reachability, deployment and mitigations differ. Current Rea dependency audit is recorded separately in VERIFICATION.md.

## Public behavior studied

1. [Postman platform](https://www.postman.com/product/): client, design, documentation, collaboration, testing, governance, distribution and discovery are separate platform surfaces. A request sender cannot reasonably score the same as that whole platform.
2. [Script lifecycle](https://learning.postman.com/docs/tests-and-scripts/write-scripts/intro-to-scripts/): collection → folder → request execution for inherited pre-request and post-response scripts. Rea implements this order with representative regression fixtures.
3. [Runtime source and API](https://github.com/postmanlabs/postman-runtime): lifecycle, variable scopes, cookie sessions, iteration, cancellation and timeout options. Rea uses an independent bounded HTTP runner; compatibility is explicitly partial.
4. [Native Git](https://www.postman.com/product/native-git/) and [setup](https://learning.postman.com/docs/use/native-git/setup): local request/spec/environment files, Git and CLI are current Postman features. Do not claim these are exclusive Rea advantages or that Postman always uploads every request.
5. [Collection runs](https://learning.postman.com/latest-v-12/docs/tests-and-scripts/running-collections/intro-to-collection-runs): datasets, repeatable runs, execution order and results informed Rea's focused runner.
6. [Plans](https://www.postman.com/pricing/): feature availability varies by plan and changes. No hard-coded price advantage or obsolete free-run limit is asserted here.

## Problems versus opportunities

Observed **Rea defects** included duplicated imported queries, lost inherited authentication/scripts, text imported as JSON, conflated origins, omitted falsy response schemas, invalid generated TypeScript, scope leakage and a host-based scripting boundary. These have executable fixes in this revision.

Potential **Postman tradeoffs** are broader product complexity, plan-dependent advanced capabilities and the overhead of a large platform for small local workflows. These are product hypotheses, not universally experienced defects. Validate them with users. There is no evidence here for “Postman is slow,” “Postman is insecure,” or “we fixed every Postman issue.” Postman's Git support and free core tools materially weaken simplistic replacement pitches.

## Compatibility limits

Postman v2.1 JSON is supported for the tested HTTP subset. Advanced auth/body modes are preserved and blocked with warnings rather than silently executed differently. Rea does not implement the complete Collection SDK, sandbox package API, `pm.require`, full `pm.request` mutation helpers, dynamic variable catalogue, vault, OAuth flows, all certificate/proxy configurations, native Git YAML format, or protocol-specific scripting. Disabled script-event round trips and other metadata should be checked; import/export is not advertised as lossless.

QuickJS isolates script JavaScript from Node's object graph; heap/stack/time limits and a narrow JSON network bridge replace node:vm. This reduces a demonstrated class of host-object escape exposure. It is not a formal security proof or permission system: trusted collection scripts can still send HTTP requests, consume resources within limits and change target services. No hostile-code immunity claim is made.
