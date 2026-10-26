# PacketLark — VS Code preview

Local desktop workspaces only. Requires Node.js 22+ and a built PacketLark checkout. Run `npm ci && npm run build` in that checkout, then set **PacketLark: Runtime Path** in VS Code User Settings to its absolute path. Optionally set **PacketLark: Node Path** to your Node executable.

Build the extension with `npm run build:extension` from the repository root. Package with `npx @vscode/vsce package --no-dependencies` inside this folder, then use **Extensions: Install from VSIX**. No Marketplace release or publisher verification is implied.

Run **PacketLark: Open API Studio**. The extension starts a loopback-only service on available ports and embeds the workbench. **PacketLark: Stop API Studio** stops that service. Closing the panel keeps it running until stopped or VS Code exits. Collection files live in the opened folder's `.packetlark` directory. Collection execution can change remote services; use trusted collections and authorized endpoints. Workspace Trust is required. Remote, browser and virtual workspaces are not supported in this preview.

The extension has been typechecked, bundled and packaged; an installed VS Code extension-host smoke test is still required before distribution as stable.
