import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const tracker = read("docs/roadmap/task-tracker.json");
const requirements = read(tracker.source_requirements).requirements;
const statuses = new Set(["todo", "in_progress", "done", "blocked", "gated"]);
assert.deepEqual(Object.keys(tracker.status_definitions).sort(), [...statuses].sort());
const phaseIds = new Set(tracker.phases.map((phase) => phase.id));
const ids = new Set(tracker.tasks.map((task) => task.id));
const requirementIds = new Set(requirements.map((requirement) => requirement.id));
assert.equal(phaseIds.size, 10, "Track all P1–P10 phases exactly once");
assert.equal(tracker.phases.length, phaseIds.size, "Duplicate phase IDs");
for (let i = 1; i <= 10; i++) assert(phaseIds.has(`P${i}`));
assert.equal(ids.size, tracker.tasks.length, "Task IDs must be unique");
assert.equal(requirementIds.size, 92, "Preserve the 92 reviewed requirement IDs");
for (let i = 1; i <= 92; i++) assert(requirementIds.has(`PACKETLARK-${String(i).padStart(3, "0")}`), "Preserve the original requirement identities");
assert(fs.statSync(path.join(root, tracker.source_plan)).isFile(), "Missing source plan");
assert.deepEqual(Object.keys(tracker.requirements).sort(), [...requirementIds].sort());
assert.equal(tracker.current_phase, tracker.phases.find((p) => p.status === "in_progress")?.id ?? null);
assert(tracker.phases.filter((p) => p.status === "in_progress").length <= 1, "At most one phase may be active");
const phaseById = new Map(tracker.phases.map((phase) => [phase.id, phase]));
const phaseNumber = (id) => Number(id.slice(1));
const prerequisitesDone = (phase) => phase.depends_on.every((id) => id === "P0" || phaseById.get(id)?.status === "done");
const checkEvidence = (evidence) => {
  for (const file of evidence) {
    assert(typeof file === "string" && file.startsWith("docs/") && !file.includes(".."), `Invalid evidence path: ${file}`);
    assert(fs.statSync(path.join(root, file)).isFile(), `Missing evidence: ${file}`);
  }
};
const graph = new Map();
for (const task of tracker.tasks) {
  assert(phaseIds.has(task.phase) && task.id.startsWith(task.phase + "-"), task.id);
  assert(statuses.has(task.status), `Unknown status: ${task.id}`);
  assert(["deliverable", "prerequisite_gate", "phase_gate"].includes(task.kind), `Unknown task kind: ${task.id}`);
  if (["done", "in_progress"].includes(task.status)) {
    const phase = phaseById.get(task.phase);
    assert(["done", "in_progress"].includes(phase.status) && prerequisitesDone(phase), `${task.id} cannot precede its phase prerequisites`);
  }
  assert(task.title && task.acceptance.length && task.acceptance.every((value) => typeof value === "string" && value.trim()), `Missing acceptance: ${task.id}`);
  for (const id of task.requirement_ids) assert(requirementIds.has(id), `Unknown requirement: ${id}`);
  for (const id of task.depends_on) assert(ids.has(id), `Unknown dependency: ${id}`);
  if (task.status === "done") {
    assert(task.evidence.length, `Completion requires evidence: ${task.id}`);
    for (const id of task.depends_on) assert.equal(tracker.tasks.find((t) => t.id === id).status, "done", `${task.id} has unfinished dependency`);
  }
  if (task.status === "blocked") assert(task.blocker?.reason && task.blocker?.next_action, `Blocked task needs a next action: ${task.id}`);
  checkEvidence(task.evidence);
  graph.set(task.id, task.depends_on);
}
for (const phase of tracker.phases) {
  assert(statuses.has(phase.status));
  if (["done", "in_progress"].includes(phase.status)) assert(prerequisitesDone(phase), `Unfinished phase prerequisites: ${phase.id}`);
  const tasks = tracker.tasks.filter((task) => task.phase === phase.id);
  assert(tasks.length && tasks.some((task) => task.kind === "phase_gate"), `Missing phase gate: ${phase.id}`);
  for (const gate of tasks.filter((task) => task.kind === "phase_gate"))
    assert(tasks.filter((task) => task.id !== gate.id).every((task) => gate.depends_on.includes(task.id)), `Phase gate must depend on every deliverable: ${gate.id}`);
  if (phase.status === "done") assert(tasks.every((task) => task.status === "done"), `Unfinished phase: ${phase.id}`);
  graph.set(phase.id, phase.depends_on.filter((id) => id !== "P0"));
}
const visit = (id, ancestors = new Set()) => {
  assert(!ancestors.has(id), `Dependency cycle: ${id}`);
  assert(graph.has(id), `Unknown dependency: ${id}`);
  for (const dependency of graph.get(id)) visit(dependency, new Set([...ancestors, id]));
};
for (const id of graph.keys()) visit(id);
for (const original of requirements) {
  const requirement = tracker.requirements[original.id];
  assert.equal(requirement.candidate_phase, original.candidate_phase);
  assert.equal(requirement.feature, original.feature);
  assert.equal(requirement.required_work, original.required_work);
  assert.equal(requirement.workstream, original.workstream);
  assert(phaseIds.has(requirement.next_review_phase));
  assert(["pending", "in_progress", "accepted"].includes(requirement.status));
  assert(requirement.task_ids.length, `Unassigned requirement: ${original.id}`);
  for (const id of requirement.task_ids) assert(ids.has(id), `Unknown task: ${id}`);
  if (requirement.status === "accepted") {
    assert(requirement.evidence.length, `Requirement acceptance needs evidence: ${original.id}`);
    assert(requirement.task_ids.every((id) => tracker.tasks.find((task) => task.id === id).status === "done"));
  }
  assert(requirement.scopes?.length, `Missing phase scopes: ${original.id}`);
  assert(requirement.scopes.some((scope) => scope.phase === requirement.next_review_phase), `Missing next review scope: ${original.id}`);
  assert(requirement.task_ids.every((id) => requirement.scopes.some((scope) => scope.task_ids.includes(id))), `Task has no requirement scope: ${original.id}`);
  assert.equal(new Set(requirement.scopes.map((scope) => scope.phase)).size, requirement.scopes.length, `Duplicate requirement scope: ${original.id}`);
  for (const scope of requirement.scopes) {
    assert(phaseIds.has(scope.phase) && scope.scope?.trim() && ["pending", "accepted", "deferred"].includes(scope.status), `Invalid scope: ${original.id}`);
    assert(scope.task_ids.length && scope.task_ids.every((id) => ids.has(id) && id.startsWith(scope.phase + "-") && requirement.task_ids.includes(id)), `Scope task mismatch: ${original.id}`);
    if (scope.status === "accepted") {
      assert(scope.evidence.length && scope.task_ids.every((id) => tracker.tasks.find((task) => task.id === id).status === "done"), `Unverified scope: ${original.id}`);
    }
    if (scope.status === "deferred") assert(scope.deferred_to_task_ids.length && scope.deferred_to_task_ids.every((id) => ids.has(id) && requirement.task_ids.includes(id) && requirement.scopes.some((later) => later.task_ids.includes(id)) && phaseNumber(id.split("-")[0]) > phaseNumber(scope.phase)), `Missing later-phase deferral: ${original.id}`);
    if (phaseById.get(scope.phase).status === "done") assert(scope.status !== "pending", `Unresolved requirement at phase closure: ${original.id}/${scope.phase}`);
    if (requirement.status === "accepted") assert.equal(scope.status, "accepted", `Broad requirement still has open scopes: ${original.id}`);
    checkEvidence(scope.evidence);
  }
  checkEvidence(requirement.evidence);
}
if (tracker.phases.every((phase) => phase.status === "done"))
  assert(Object.values(tracker.requirements).every((requirement) => requirement.status === "accepted"), "Completed program still has unaccepted requirements");
const counts = (tasks) => [...statuses].map((status) => [status, tasks.filter((task) => task.status === status).length]).filter(([, count]) => count).map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join("; ");
const lines = [
  "# Implementation task tracker — P1 to P10", "",
  "Generated from [task-tracker.json](roadmap/task-tracker.json). Edit that file, then run `npm run roadmap:write`; CI checks synchronization with `npm run roadmap:check`.", "",
  `As of ${tracker.as_of}. **Current phase: ${tracker.current_phase || "none (between phases or complete)"}.** ${tracker.execution_policy}`, "",
  `**Delivery tasks: ${tracker.tasks.length} total — ${counts(tracker.tasks)}.** Requirement acceptance is tracked separately: ${requirements.length} rows; ${Object.values(tracker.requirements).filter((r) => r.status === "accepted").length} accepted. Counts are not an effort or readiness percentage.`, "",
  "P0's scoped local-core gates passed; broader security/recovery obligations remain assigned below. Existing functionality and old capability labels do not waive acceptance gates.", "",
  "## Working rules", "", ...tracker.update_rules.map((rule) => `- ${rule}`), "",
];
for (const phase of tracker.phases) {
  const tasks = tracker.tasks.filter((task) => task.phase === phase.id);
  lines.push(`## ${phase.id} — ${phase.title}`, "", `Status: **${phase.status.replaceAll("_", " ")}**. Depends on ${phase.depends_on.join(", ")}. ${counts(tasks)}.`, "");
  for (const task of tasks) {
    lines.push(`- [${task.status === "done" ? "x" : " "}] **${task.id} — ${task.title}** (${task.status.replaceAll("_", " ")})`, ...task.acceptance.map((criterion) => `  - Acceptance: ${criterion}`));
    if (task.requirement_ids.length) lines.push(`  - Requirements: ${task.requirement_ids.join(", ")}.`);
    if (task.depends_on.length) lines.push(`  - Dependencies: ${task.depends_on.join(", ")}.`);
    if (task.evidence.length) lines.push(`  - Recorded evidence: ${task.evidence.map((file) => `[${path.basename(file)}](${path.posix.relative("docs", file)})`).join(", ")}.`);
    if (task.blocker) lines.push(`  - Blocker: ${task.blocker.reason}. Next: ${task.blocker.next_action}.`);
  }
  lines.push("");
}
lines.push("## Requirement acceptance ledger — all 92 reviewed rows", "", "Each row retains the original candidate phase. Next review phase assigns outstanding work; candidate phase never means full capability completion. Full workstream acceptance gates remain in [the implementation plan](IMPLEMENTATION_PLAN.md#6-ten-workstreams-and-acceptance-gates).", "");
for (const [id, item] of Object.entries(tracker.requirements)) {
  lines.push(`- [${item.status === "accepted" ? "x" : " "}] **${id} — ${item.feature}** (${item.status.replaceAll("_", " ")})`, `  - ${item.workstream}; original candidate ${item.candidate_phase}; next review ${item.next_review_phase}; tasks: ${item.task_ids.join(", ")}.`, `  - Remaining: ${item.required_work}`, `  - Boundary: ${item.cross_phase_note}`);
  for (const scope of item.scopes) lines.push(`  - ${scope.phase} scope: ${scope.status}; ${scope.scope}${scope.deferred_to_task_ids.length ? ` Deferred to ${scope.deferred_to_task_ids.join(", ")}.` : ""}`);
}
const markdown = lines.join("\n") + "\n";
const target = path.join(root, "docs/TASK_TRACKER.md");
if (process.argv.includes("--write")) fs.writeFileSync(target, markdown);
else assert.equal(fs.readFileSync(target, "utf8"), markdown, "Tracker summary is stale; run npm run roadmap:write");
console.log(`Roadmap: ${phaseIds.size} phases, ${ids.size} delivery tasks, ${requirementIds.size} requirements; evidence paths, dependencies and summary validated.`);
console.log("VERDICT: PASS");
