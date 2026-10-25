import { build } from "esbuild";
await build({
  entryPoints: ["web/sandbox-bootstrap.js"],
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2022",
  outfile: "sandbox/bootstrap.js",
  legalComments: "inline",
});
