import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("STDIO catalog exposes the complete VCB tool surface", async () => {
  const transport = new StdioClientTransport({ command: "node", args: ["bin/vcb-mcp.mjs"], env: { ...process.env, VCB_PORT: "4224", VCB_DATA_DIR: "/tmp/vcb-mcp-tools-test" } });
  const client = new Client({ name: "vcb-test", version: "1" });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const expected of ["create_board", "get_board_capture", "get_board_svg", "get_board_structure", "add_elements", "move_elements", "remove_elements", "undo_board", "redo_board", "get_board_history", "get_board_version", "add_image_overlay", "close_board"]) assert.equal(names.has(expected), true, `missing ${expected}`);
  assert.ok(tools.tools.length >= 20);
  await transport.close();
});
