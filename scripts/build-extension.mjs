import { build } from "esbuild";
await build({
  entryPoints: ["extensions/vscode/src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  outfile: "extensions/vscode/dist/extension.cjs",
});
