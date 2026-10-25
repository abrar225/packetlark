# Verification record

24 October 2026, macOS, Node v24.14.0. Checks below apply to this redesign revision; they do not certify every endpoint, generated SDK, browser, or Postman behavior.

## Clean installation, build and automated tests

Observed after the final application/source changes:

```text
npm ci
added 49 packages
found 0 vulnerabilities

npm run check
> tsc && node scripts/build-web.mjs
Test Files  9 passed (9)
Tests       45 passed (45)

npm audit --audit-level=high
found 0 vulnerabilities
```

The original 39 tests remain, with HTTP fixtures moved from the external httpbin service to a real loopback HTTP server. Server tests use temporary storage roots and delete them afterward. Six additional tests exercise homepage/workbench/assets, missing static files, foreign origins, exact local origins, rebinding Host headers, encoded traversal, and proxy browser restrictions. The memory test checks a numeric RSS measurement, not an arbitrary cross-machine limit.

## Browser verification

Ego Lite, one task space. A temporary `StudioServer(4050, 8095, tempDir)` ran separately from the user's workspace. The repeatable script is `scripts/browser-check.mjs`; launch its server with `node scripts/test-server.mjs`, then import the script through Ego's `nodejs -e` command using its absolute file URL.

The final repeatable run reported **14 passing checks**:

1. Homepage sample request switching and sample response.
2. Homepage desktop axe WCAG 2 A/AA and 2.1 AA scan: zero violations, one incomplete check for manual review.
3. Homepage at 390px: no horizontal document overflow.
4. Reduced motion: all hero text visible and Lenis destroyed after the media preference changes.
5. Homepage resources: no third-party script/font/icon network requests.
6. Postman import selects the newly imported request.
7. A real loopback request returns 200 and its `pm.test` assertion passes.
8. Switching request tabs preserves the selected response tab.
9. Collection search filters and restores requests.
10. Code snippet opens; Escape closes the dialog and releases inert background content.
11. Workbench desktop axe scan: zero violations, two incomplete checks for manual review.
12. Workbench at 390px: no horizontal document overflow.
13. Forwarded local HTTP traffic appears in the traffic screen and OpenAPI 3.1 preview.
14. No observed page errors/unhandled rejections during those studio workflows.

Screenshots were inspected at the browser's original 948px viewport, a 1440 × 1000 desktop emulation and 390 × 844 mobile emulation. Mobile and desktop emulator checks do not substitute for physical device testing. Screenshots in `assets/` show actual UI state and sample/test data, not a performance benchmark.

Additional interactive checks during implementation: cURL import persists to its collection; environment rename survives reopening; environment quick-look works; real response assertions, headers and generated snippets render; modal Escape dismissal; reduced-motion page reload. Changes made to the browser QA collection are cleaned up after the repeatable run. The local test server is disposed separately.

Automated accessibility checks found and prompted fixes for low-contrast line numbers and nested interactive request controls. Remaining axe “incomplete” checks require human judgment, so no WCAG certification is claimed.

## Known limitations reproduced

`node scripts/assessment-probes.mjs` reproduced duplicated query parameters, lost inherited Postman auth, raw text imported as JSON, same-path multi-origin merging, and omitted schema content for `false` bodies. These are documented unresolved product limitations, not features fixed by the visual redesign.

## Deployment scope

GitHub Actions CI checks Node 22 and 24. The Pages workflow builds/tests then uploads only `dist-site/`, containing the informational homepage, local bundles/fonts, identity assets and license notices. It excludes the Node server, workbench page and workspace files. Real API work remains local. See the repository's GitHub Actions runs for remote verification; a local pass is not itself proof of a successful deployment.

VERDICT: PASS

This verdict covers the checks listed above. It does not assert full product parity, complete security, or correctness of all generated contracts and client code.

# Platform foundations — 25 October 2026

The record above describes the initial visual redesign. This section supersedes its unresolved-defect list for release candidate 1.1.0.

## Observed checks

- `npm run check`: **72 tests across 13 files passed**, including TypeScript compilation and web/sandbox asset builds. New tests exercise imported query normalization/inheritance/unsupported preservation, independent script scopes, real Chai/async assertions, bounded script networking, timeout/cancellation/body limits, binary bytes, redirect cookies, data iteration, request chaining, CSV and generated TypeScript compilation.
- Actual CLI subprocesses verified JSON/JUnit output and exit codes. An actual MCP stdio client negotiated the server, listed tools/collections and exercised invalid-ID rejection. These checks do not establish compatibility with every agent client/version.
- Workbench API tests verify invalid imports/malformed JSON return 400, inherited scripts execute, disabled environment entries survive script updates, and runs can be started/polled/cancelled.
- `node scripts/assessment-probes.mjs`: formerly reproduced query/auth/text/falsy/multi-origin bugs now pass focused regression assertions.
- `npm run build:extension`: strict extension typecheck and bundle passed. `@vscode/vsce@3.6.2 package --no-dependencies` produced a VSIX. VS Code was not installed here; extension-host execution, remote workspaces and Marketplace distribution are **not verified**. The preview explicitly supports trusted local desktop workspaces only.
- `npm run test:package` / `npm pack`: packaged compiled server, sandbox bootstrap, local web assets and notices. A new temporary directory installed the tarball with production dependencies only and `--ignore-scripts`; CLI help and an actual collection with a WASM pre-request script executed without source/dev dependencies. The temporary installation was removed afterward.
- Dependency lock audit observed **zero reported vulnerabilities**. This is an advisory snapshot, not a security audit or guarantee.

## Browser observations and limit

A temporary server at 4050/8095 used a disposable workspace. Direct Ego interactions verified selecting an imported request, sending a real local request, two inherited/async assertions, opening the runner, supplying two data rows, and rendering **PASSED: 2 requests · 4 assertions passed · 0 failed · 0 errors**. These results were visible in the browser snapshot.

The longer automated browser scripts repeatedly lost the Ego connection, so their completion, full accessibility rerun, mobile overflow assertions and screenshots are **not claimed as passing** for this revision. Initial redesign browser results above remain historical, not a substitute for current verification. `scripts/browser-platform-check.mjs` records the intended repeatable checks; it still requires a completed run. No browser upgrade/profile/storage changes were made to bypass that failure.

## Remaining release gates

No direct Postman/Newman differential run, full sandbox conformance, independently reviewed security boundary, performance/RAM comparison, signed desktop installer, installed editor-host test, production operations test or real-user adoption study was completed. CLI reports omit bodies/headers/scopes by default and redact explicitly marked environment secrets; unknown secrets can still appear in names/assertion/error text. Workspaces remain plaintext files.

VERDICT: PASS

This verdict covers the observed automated/core/package checks only. Browser-harness completion and editor-host validation remain open and prevent calling the entire distribution stable or assigning a 9/10 platform score.
