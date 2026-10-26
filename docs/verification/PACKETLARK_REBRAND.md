# PacketLark rebrand verification

27 October 2026. Scope: current project tree, package and CLI identity, browser application, editor preview, repository metadata and static website. Historical Git objects retain their original provenance.

## Identity

- Display name: **PacketLark**. Package, executable, repository and workspace directory: `packetlark`.
- Original SVG lark with a packet-shaped cutout; matching favicon, Ink variant, horizontal wordmark, social card and editor icon.
- Updated homepage, metadata, links, installation commands, workbench, engine/export labels, editor commands/configuration, agent examples, temporary-file prefixes and requirement namespace. Requirement numbers, task relationships and scope are preserved.
- The local workspace was moved intact to `.packetlark`; all seven files were preserved, with a private backup outside the repository. No native credential metadata existed in this workspace. User request payloads and credentials were not rewritten.
- Existing installations should save unsaved browser drafts before upgrading and review workspace/native credential bindings before moving external workspaces. Browser recovery and native credentials are scoped to origin/workspace identity. Update editor and agent configuration to the new command and setting names.

## Fresh local checks

- `npm run check`: build, roadmap synchronization, **309 tests passed across 35 files**.
- `npm run build:extension`: strict TypeScript validation and editor bundle passed.
- `node scripts/package-smoke.mjs`: fresh production-only package installation, CLI and WASM script execution passed.
- `node scripts/assessment-probes.mjs` and `node scripts/check-import-corpus.mjs`: passed.
- `node scripts/check-branding.mjs`: package/lockfile/CLI/editor/HTML/logo/PNG/static-artifact identity checks passed. Both GitHub workflows run this check.
- `npm audit --audit-level=high`: zero vulnerabilities at inspection.
- `git diff --check`: passed.
- Case-aware scan of current tracked/new files and filenames: zero previous-brand matches. Ordinary words such as read, ready and create are excluded from the matcher. Git history, dependency sources and private backups are outside the current-source scan.

The initial full run exposed a renamed script-test fixture whose regex expected its former prefix; the fixture was corrected and its 17-test suite passed. A concurrent run subsequently hit the existing five-second upload-test limit; its seven-test suite passed in isolation and the final full suite passed without competing package/browser work. No runtime timeout limit was weakened.

## Browser evidence

Checks used an isolated temporary workspace rather than user data:

- Homepage title, full wordmark, links and original hero mark at 1440 × 1000.
- Interactive sample switching/sending produced the expected sample JSON/status.
- Homepage/workbench at 390 × 844: no horizontal overflow; workbench readiness observed.
- Health endpoint product: `packetlark`; existing version: 1.1.0.
- All four checked-in screenshots refreshed. Social card: 1200 × 630. Editor icon: 256 × 256. SVG sources are the authoritative vector assets.

Historical acceptance documents retain their original execution dates and source hashes. Branding and recorded paths were normalized; the affected P2 test-record checksum was updated and explicitly annotated. This does not claim historical benchmarks were rerun.

GitHub publication/deployment results are recorded in Actions and releases. These checks do not establish stable cross-platform certification, Marketplace publishing or exhaustive Postman compatibility.
