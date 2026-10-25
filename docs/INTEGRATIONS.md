# CLI, editor and agent integration

Requires Node.js 22+. Build once: `npm ci && npm run build`.

## Studio and headless runs

```sh
node bin/rea-api.js studio --workspace /absolute/path/to/api-project
node bin/rea-api.js run collection.json --environment environment.json --data rows.csv --bail
node bin/rea-api.js run collection.json --reporter junit --report-file results.xml
node bin/rea-api.js run collection.json --iterations 5 --timeout 10000 --reporter json
```

Collections may be native Rea JSON or Postman v2.1 JSON. Environment input uses the usual `values` array with key/value/enabled fields. CSV headers must be unique and every row must match their width; JSON data is a nonempty array of objects. `--folder` matches a folder name or request ID. Default iterations follow data length. Only failed assertions/network/run errors fail a run: HTTP 4xx/5xx must be asserted explicitly. `--bail` stops on the first failure. Exit codes: 0 passed, 1 failed, 2 invalid invocation/setup, 130 cancelled. SIGINT cancels requests.

Limits include 2 MiB input files, 1,000 iterations/default requests, 120 seconds per run, 30 seconds per request by default, 10 MiB default response cap, 2 seconds/32 MiB script heap, 20 script HTTP requests and 100 async operations per script. Limits are operational guards, not a substitute for choosing authorized endpoints. Retained run bodies are capped at 256 KiB each and 16 MiB total; assertions inspect the response before retention truncation. JSON/JUnit CLI summaries exclude bodies, headers and environment values. Only explicitly marked environment secrets are automatically scrubbed from assertion text; avoid logging secrets.

## VS Code preview

See [extension instructions](../extensions/vscode/README.md). `npm run build:extension` typechecks/bundles it. Install the packaged VSIX, set `rea.runtimePath` in **User Settings** to the built checkout, then run **Rea: Open API Studio**. Only trusted local file workspaces are supported. The service starts on free loopback ports and writes `.rea-api` inside the opened workspace. There is no Marketplace publication yet.

## MCP clients

Run `node /absolute/path/to/rea-api-studio/bin/rea-api.js mcp --workspace /absolute/path/to/api-project`. Stdout is reserved for MCP; tools are `list_collections`, `run_collection` and `send_request`. `list_collections` reads saved metadata; execution tools can modify remote systems and collection scripts may make further requests. Environment values and response bodies are not returned by default. `send_request` can return a body when explicitly requested; do not enable that for secret-bearing responses unnecessarily. No shell execution/file-path arguments are exposed as tools.

Example Codex registration, run manually after reviewing the workspace/path:

```sh
codex mcp add rea -- node /absolute/path/to/rea-api-studio/bin/rea-api.js mcp --workspace /absolute/path/to/api-project
```

Example Claude Code registration:

```sh
claude mcp add --transport stdio rea -- node /absolute/path/to/rea-api-studio/bin/rea-api.js mcp --workspace /absolute/path/to/api-project
```

Use an absolute Node executable if the client has a different PATH. No client configuration was changed automatically. These commands register a local server; they do not create a hosted connector or an app-store extension. Keep approval controls enabled and scope instructions to the APIs you intend to exercise.

Official references checked: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x), [VS Code Webviews](https://code.visualstudio.com/api/extension-guides/webview), [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust). Registration syntax and client settings may change.
