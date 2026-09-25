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

Semantic groups keep their path IDs in each saved board version. When loading an older snapshot that omitted a group record but retained group IDs on its paths, VCB reconstructs the missing group in memory. Reading a historical snapshot does not rewrite its file.

## Board coordinates

`points` is an ordered list of `[x, y]` pairs containing **JSON numbers**, for example `[[10, 20], [100, 20]]`. A quoted value such as `"10"` is a string and is rejected by the MCP input schema. The origin `(0, 0)` is the top-left corner; `x` increases to the right and `y` increases downward. Use `create_board` or `get_board_structure` to read the board's `width` and `height`; valid coordinates lie within `0..width` and `0..height`.

One board unit equals one pixel of the canvas bitmap at its native size. Browser zoom changes only the displayed size. Optional grid snapping affects human edits, not coordinates supplied by the agent. Paths, groups, lines and arrows use `points`. Text, rectangles and ellipses use numeric `x` and `y`; shapes also use numeric `width` and `height`.

Example `add_elements` arguments:

```json
{"boardId":"board-123","elements":[{"type":"line","points":[[10,20],[100,20]]}]}
```

The server is a board tool. It does not decide what a drawing means, generate Mermaid, choose a fitting strategy, or validate domain rules. Existing board resizing, automatic annotation re-anchoring, multi-agent coordination and local Mermaid rendering are outside the current distribution scope.

## Development

```sh
npm test
```

The tests cover the MCP catalog and resources, persistence, rich elements, structure/versioning, SVG and canvas capture, overlays, history, undo/redo, protected human paths, and the browser UI.

## License

No public license has been selected yet. Treat this repository as source-available until a license is added.
