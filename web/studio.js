import { CredentialControls } from './credential-controls.js';
import { HttpControls } from './http-controls.js';
window.ReaCredentialControls = CredentialControls;
window.ReaHttpControls = HttpControls;
import "./fonts.css";
import { CollectionTree } from "./collection-tree.js";
import { WorkspaceSync } from "./workspace-sync.js";
import { DraftRecovery } from "./draft-recovery.js";
import { WorkspaceAuthoring } from "./workspace-authoring.js";
import { WorkbenchState, WorkbenchActivity, sanitizeExample } from "./workbench-activity.js";
import { validWorkspaceResource } from "../src/core/models/WorkspaceValidation.ts";
import { resolveCollectionRequest } from "../src/core/models/CollectionContext.ts";
window.ReaCollectionTree = CollectionTree;
window.ReaWorkspaceSync = WorkspaceSync;
window.ReaDraftRecovery = DraftRecovery;
window.ReaWorkspaceAuthoring = WorkspaceAuthoring;
window.ReaWorkbenchState = WorkbenchState;
window.ReaWorkbenchActivity = WorkbenchActivity;
window.ReaSanitizeExample = sanitizeExample;
window.ReaValidWorkspaceResource = validWorkspaceResource;
window.ReaResolveCollectionRequest = resolveCollectionRequest;
import {
  createIcons,
  Plus,
  Save,
  Search,
  Copy,
  Trash2,
  Folder,
  PanelsTopLeft,
  Radio,
  Layers,
  Settings2,
  Download,
  HardDrive,
  PanelLeft,
} from "lucide";
import { animate } from "animejs";
const icons = {
  Plus,
  Save,
  Search,
  Copy,
  Trash2,
  Folder,
  PanelsTopLeft,
  Radio,
  Layers,
  Settings2,
  Download,
  HardDrive,
  PanelLeft,
};
window.lucide = { createIcons: () => createIcons({ icons }) };
// Compatibility bridge for the existing response metric callback. No remote scripts.
window.anime = (options) =>
  animate(options.targets, {
    time: options.time,
    size: options.size,
    duration: options.duration,
    ease: "outExpo",
    onUpdate: options.update,
    onComplete: options.update,
  });
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) &&
    document.querySelector(".modal-backdrop").style.display !== "flex"
  ) {
    event.preventDefault();
    document.body.classList.add("sidebar-open");
    document.getElementById("collection-search").focus();
  }
});
