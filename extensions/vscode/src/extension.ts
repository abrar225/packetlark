import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
let child: ChildProcess | undefined;
let panel: vscode.WebviewPanel | undefined;
export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("PacketLark");
  context.subscriptions.push(output);
  const stop = () => {
    child?.kill();
    child = undefined;
    panel?.dispose();
    panel = undefined;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("packetlark.stopStudio", stop),
    { dispose: stop },
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("packetlark.openStudio", async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage(
          "Trust this workspace before running API collections and their scripts.",
        );
        return;
      }
      if (panel) {
        panel.reveal();
        return;
      }
      if (child) {
        vscode.window.showInformationMessage("PacketLark is starting.");
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root || root.scheme !== "file") {
        vscode.window.showErrorMessage(
          "Open a local folder first. This preview supports local desktop workspaces.",
        );
        return;
      }
      const config = vscode.workspace.getConfiguration("packetlark");
      // Machine values only: a repository cannot override the executable location.
      const machine = (key: string, fallback: string) =>
        config.inspect<string>(key)?.globalValue ?? fallback;
      const runtime = machine("runtimePath", "");
      const node = machine("nodePath", "node");
      if (
        !path.isAbsolute(runtime) ||
        !existsSync(path.join(runtime, "dist/cli.js"))
      ) {
        vscode.window.showErrorMessage(
          "Set PacketLark: Runtime Path to a built PacketLark checkout in User Settings.",
        );
        return;
      }
      child = spawn(
        node,
        [
          path.join(runtime, "bin/packetlark.js"),
          "studio",
          "--port",
          "0",
          "--sniffer-port",
          "0",
          "--workspace",
          root.fsPath,
        ],
        { cwd: root.fsPath, shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      const process = child;
      let pending = "";
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) {
          output.appendLine("Startup timed out.");
          stop();
        }
      }, 30000);
      process.stderr?.on("data", (data) => output.append(data.toString()));
      process.on("error", (error) => {
        clearTimeout(timer);
        output.appendLine(error.message);
        vscode.window.showErrorMessage(
          "PacketLark failed to start. See PacketLark output.",
        );
        stop();
      });
      process.on("exit", () => {
        clearTimeout(timer);
        if (child === process) {
          child = undefined;
          panel?.dispose();
          panel = undefined;
        }
      });
      process.stdout?.on("data", async (data) => {
        output.append(data.toString());
        pending = (pending + data.toString()).slice(-8192);
        const match = pending.match(
          /PacketLark: http:\/\/127\.0\.0\.1:(\d+)\/studio/,
        );
        if (!match || ready) return;
        ready = true;
        clearTimeout(timer);
        const port = Number(match[1]);
        const origin = `http://127.0.0.1:${port}`;
        try {
          const health = (await fetch(origin + "/api/health", {
            signal: AbortSignal.timeout(5000),
          }).then((r) => r.json())) as { product?: string };
          if (health.product !== "packetlark")
            throw new Error("Unexpected local service");
          panel = vscode.window.createWebviewPanel(
            "packetlark.studio",
            "PacketLark",
            vscode.ViewColumn.One,
            {
              enableScripts: true,
              retainContextWhenHidden: true,
              portMapping: [{ webviewPort: port, extensionHostPort: port }],
              localResourceRoots: [],
            },
          );
          panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><iframe title="PacketLark" src="${origin}/studio"></iframe></body></html>`;
          panel.onDidDispose(() => {
            panel = undefined;
          });
        } catch (error) {
          output.appendLine(String(error));
          stop();
        }
      });
    }),
  );
}
export function deactivate() {
  child?.kill();
}
