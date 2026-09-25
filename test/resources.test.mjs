import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("MCP resources expose current state, SVG and subscription capability", async () => {
  const transport = new StdioClientTransport({ command: "node", args: ["bin/vcb-mcp.mjs"], env: { ...process.env, VCB_PORT: "4225", VCB_DATA_DIR: "/tmp/vcb-resources-test" } });
  const client = new Client({ name: "vcb-resource-test", version: "1" });
  await client.connect(transport);
  const templates = await client.listResourceTemplates();
  assert.equal(templates.resourceTemplates.some(template => template.uriTemplate.includes("/state")), true);
  assert.equal(templates.resourceTemplates.some(template => template.uriTemplate.includes("/svg")), true);
  const created = await client.callTool({ name: "create_board", arguments: { width: 640, height: 400 } });
  const boardId = JSON.parse(created.content[0].text).boardId;
  const uri = `vcb://boards/${boardId}/state`;
  const state = await client.readResource({ uri });
  assert.equal(JSON.parse(state.contents[0].text).id, boardId);
  await client.subscribeResource({ uri });
  const svg = await client.readResource({ uri: `vcb://boards/${boardId}/svg` });
  assert.equal(svg.contents[0].mimeType, "image/svg+xml");
  await transport.close();
});
