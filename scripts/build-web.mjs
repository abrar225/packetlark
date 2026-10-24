import { build } from "esbuild";
import { mkdir, copyFile, cp, rm } from "node:fs/promises";
await build({
  entryPoints: { landing: "web/landing.js", studio: "web/studio.js" },
  bundle: true,
  minify: true,
  sourcemap: false,
  outdir: "public/assets",
  loader: { ".woff2": "file", ".woff": "file" },
  assetNames: "fonts/[name]-[hash]",
  target: ["es2022"],
  legalComments: "linked",
});
await mkdir("public/third-party", { recursive: true });
for (const [name, file] of [
  ["animejs", "LICENSE.md"],
  ["lenis", "LICENSE"],
  ["lucide", "LICENSE"],
  ["@fontsource-variable/manrope", "LICENSE"],
  ["@fontsource-variable/dm-sans", "LICENSE"],
  ["@fontsource/ibm-plex-mono", "LICENSE"],
]) {
  await copyFile(
    `node_modules/${name}/${file}`,
    `public/third-party/${name.replaceAll("/", "-").replace("@", "")}-LICENSE.txt`,
  );
}
await copyFile("docs/THIRD_PARTY_NOTICES.md", "public/third-party/NOTICES.md");
// GitHub Pages serves only the informational website. The local Node API is never deployed.
await rm("dist-site", { recursive: true, force: true });
await mkdir("dist-site", { recursive: true });
for (const f of ["index.html", "landing.css", "favicon.svg"])
  await copyFile(`public/${f}`, `dist-site/${f}`);
await cp("public/assets", "dist-site/assets", { recursive: true });
await cp("public/brand", "dist-site/brand", { recursive: true });
await cp("public/third-party", "dist-site/third-party", { recursive: true });
await copyFile("LICENSE", "dist-site/LICENSE");
