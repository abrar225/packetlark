import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("refuses skipped phase prerequisites, unresolved requirement scopes, cycles and duplicate phases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packetlark-roadmap-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync("scripts/roadmap-tracker.mjs", path.join(root, "scripts/roadmap-tracker.mjs"));
    fs.cpSync("docs", path.join(root, "docs"), { recursive: true });
    const file = path.join(root, "docs/roadmap/task-tracker.json");
    const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = (change: (tracker: any) => void) => {
      const tracker = structuredClone(baseline);
      change(tracker);
      fs.writeFileSync(file, JSON.stringify(tracker));
      return spawnSync(process.execPath, [path.join(root, "scripts/roadmap-tracker.mjs"), "--write"], { encoding: "utf8" });
    };
    expect(check(() => {}).status).toBe(0);
    const skipped = check((t) => {
      // Keep this negative case valid after P1 itself has been accepted.
      t.phases.find((p: any) => p.id === "P1").status = "in_progress";
      t.current_phase = "P1";
      t.phases.find((p: any) => p.id === "P2").status = "done";
      for (const task of t.tasks.filter((task: any) => task.phase === "P2")) {
        task.status = "done";
        task.evidence = ["docs/P1_PROGRESS.md"];
      }
    });
    expect(skipped.status).not.toBe(0);
    expect(skipped.stderr).toContain("cannot precede its phase prerequisites");
    const unresolved = check((t) => {
      t.phases[0].status = "done";
      t.phases[1].status = "in_progress";
      t.current_phase = "P2";
      t.requirements["PACKETLARK-023"].status = "in_progress";
      t.requirements["PACKETLARK-023"].scopes.find((scope: any) => scope.phase === "P1").status = "pending";
      for (const task of t.tasks.filter((task: any) => task.phase === "P1")) {
        task.status = "done";
        task.evidence = ["docs/P1_PROGRESS.md"];
      }
    });
    expect(unresolved.status).not.toBe(0);
    expect(unresolved.stderr).toContain("Unresolved requirement at phase closure");
    expect(check((t) => t.phases.push(t.phases[0])).stderr).toContain("Duplicate phase IDs");
    expect(check((t) => t.tasks[4].depends_on.push(t.tasks[4].id)).stderr).toContain("Dependency cycle");
    expect(check((t) => { t.requirements["PACKETLARK-010"].task_ids = ["P1-007"]; }).stderr).toContain("Scope task mismatch");
    const allPhasesDone = (t: any) => {
      t.current_phase = null;
      for (const phase of t.phases) phase.status = "done";
      for (const task of t.tasks) { task.status = "done"; task.evidence = ["docs/P1_PROGRESS.md"]; }
      for (const requirement of Object.values(t.requirements) as any[]) {
        for (const scope of requirement.scopes) { scope.status = "accepted"; scope.evidence = ["docs/P1_PROGRESS.md"]; }
      }
    };
    expect(check(allPhasesDone).stderr).toContain("Completed program still has unaccepted requirements");
    expect(check((t) => {
      allPhasesDone(t);
      for (const requirement of Object.values(t.requirements) as any[]) { requirement.status = "accepted"; requirement.evidence = ["docs/P1_PROGRESS.md"]; }
    }).status).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
