# Visual Collaboration Board MCP

A local MCP server with a browser board that lets an agent and a person inspect and modify the same visual state.

## Requirements

- macOS is the currently verified platform.
- Node.js 24 or newer.
- An MCP client that can launch a local STDIO server.

## Install and run

```sh
npm install
npm start
```

The server exposes MCP tools over STDIO. The local HTTP board server starts when the first board tool is called. `create_board` returns a local URL; open that URL in a browser before requesting a current canvas capture.

Environment variables:

- `VCB_PORT` — HTTP port (default `4183`).
- `VCB_DATA_DIR` — directory for board state, snapshots, history, and evidence.

Example Codex MCP configuration:

```toml
[mcp_servers.vcb]
command = "vcb-mcp"
```

## Current capabilities

The MCP can create and list boards, read structure/version, PNG capture and SVG, add paths, groups and rich elements, move and remove content, inspect history, undo/redo, persist state, and close an individual board. The browser UI supports drawing, rich elements, selection, movement, grid visibility and optional grid snapping. Human and agent content can be filtered separately. The board updates open browsers automatically when server state changes.

The server is a board tool. It does not decide what a drawing means, generate Mermaid, choose a fitting strategy, or validate domain rules. Existing board resizing, automatic annotation re-anchoring, multi-agent coordination and local Mermaid rendering are outside the current distribution scope.

## Development

```sh
npm test
```

The tests cover the MCP catalog and resources, persistence, rich elements, structure/versioning, SVG and canvas capture, overlays, history, undo/redo, protected human paths, and the browser UI.

## License

No public license has been selected yet. Treat this repository as source-available until a license is added.
