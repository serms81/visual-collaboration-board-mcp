import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { EmptyResultSchema, SubscribeRequestParamsSchema, UnsubscribeRequestParamsSchema } from "@modelcontextprotocol/core/internal";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { ensureBoardServer, onBoardChange } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = process.env.VCB_DATA_DIR ?? join(here, "..", "data");
const base = `http://127.0.0.1:${process.env.VCB_PORT ?? 4183}`;
mkdirSync(evidenceDir, { recursive: true });
function record(kind, fields = {}) {
  appendFileSync(join(evidenceDir, "mcp-events.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + "\n");
}
async function json(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
function failure(kind, toolCallId, error, extra = {}) {
  record(kind, { toolCallId, ...extra, outcome: "error", error: String(error) });
  return { isError: true, content: [{ type: "text", text: String(error) }] };
}
const server = new McpServer({ name: "visual-collaboration-board", version: "0.13.3" }, { capabilities: { resources: { subscribe: true } } });

async function readBoardResource(uri, boardId, kind) {
  await ensureBoardServer();
  if (kind === "state") {
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/state`, { cache: "no-store" });
    if (!response.ok) throw new Error(`State HTTP ${response.status}`);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await response.json()) }] };
  }
  const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/${kind === "svg" ? "svg" : "capture"}`, { cache: "no-store" });
  if (response.status === 409) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await response.json()) }] };
  if (!response.ok) throw new Error(`Capture HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { contents: [{ uri: uri.href, mimeType: kind === "svg" ? "image/svg+xml" : "image/png", blob: bytes.toString("base64") }] };
}

server.registerResource("board-state", new ResourceTemplate("vcb://boards/{boardId}/state", { list: undefined }), {
  title: "Current VCB board state", description: "Current paths, groups, overlays, dimensions and version.", mimeType: "application/json"
}, async (uri, variables) => readBoardResource(uri, variables.boardId, "state"));
server.registerResource("board-capture", new ResourceTemplate("vcb://boards/{boardId}/capture", { list: undefined }), {
  title: "Current VCB browser canvas capture", description: "Latest PNG published by the open browser canvas, or an explicit pending state.", mimeType: "image/png"
}, async (uri, variables) => readBoardResource(uri, variables.boardId, "capture"));
server.registerResource("board-svg", new ResourceTemplate("vcb://boards/{boardId}/svg", { list: undefined }), {
  title: "Current VCB server-rendered SVG", description: "Current vector rendering of the board model.", mimeType: "image/svg+xml"
}, async (uri, variables) => readBoardResource(uri, variables.boardId, "svg"));
onBoardChange(({ boardId }) => {
  server.server.sendResourceUpdated({ uri: `vcb://boards/${boardId}/state` });
  server.server.sendResourceUpdated({ uri: `vcb://boards/${boardId}/capture` });
  server.server.sendResourceUpdated({ uri: `vcb://boards/${boardId}/svg` });
});
// The installed SDK exposes resource notification primitives but does not wire
// the legacy subscribe request into McpServer. Register the small compatibility
// handlers so clients using resources/subscribe can opt in as well.
server.server.setRequestHandler("resources/subscribe", { params: SubscribeRequestParamsSchema, result: EmptyResultSchema }, async () => ({}));
server.server.setRequestHandler("resources/unsubscribe", { params: UnsubscribeRequestParamsSchema, result: EmptyResultSchema }, async () => ({}));

function readPngDimensions(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Expected a PNG file");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

server.registerTool("inspect_image", {
  title: "Inspect a PNG before creating a board",
  description: "Read PNG dimensions and aspect ratio from a local file without creating or mutating a board. Use these facts to choose board dimensions before create_board.",
  inputSchema: z.object({ filePath: z.string().min(1) })
}, async ({ filePath }) => {
  const toolCallId = randomUUID();
  try {
    const image = readPngDimensions(filePath);
    const result = { filePath, ...image, aspectRatio: Number((image.width / image.height).toFixed(6)) };
    record("inspect_image-result", { toolCallId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("inspect_image-result", toolCallId, error, { filePath }); }
});

server.registerTool("create_board", {
  title: "Create a local board",
  description: "Create a new empty local board through MCP and return its browser URL, board ID and dimensions. Omit width/height for 640×400; choose dimensions before creation when a reference needs more space. Existing boards are never resized.",
  inputSchema: z.object({ width: z.number().int().min(320).max(2400).optional(), height: z.number().int().min(240).max(1600).optional() })
}, async ({ width, height }) => {
  const toolCallId = randomUUID();
  record("create_board-called", { toolCallId, width, height });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin: "mcp", toolCallId, width, height }) });
    const result = await json(response);
    record("create_board-result", { toolCallId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("create_board-result", toolCallId, error); }
});

server.registerTool("list_boards", {
  title: "List local boards",
  description: "List boards currently loaded by the local VCB server, including dimensions and current version.",
  inputSchema: z.object({})
}, async () => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards`, { cache: "no-store" }); const result = await json(response); record("list_boards", { toolCallId, count: result.boards?.length ?? 0 }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("list_boards", toolCallId, error); }
});

server.registerTool("get_board_history", {
  title: "Get board history",
  description: "List persisted versions of a board without changing its current state.",
  inputSchema: z.object({ boardId: z.string().min(1) })
}, async ({ boardId }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/history`, { cache: "no-store" }); const result = await json(response); record("get_board_history", { toolCallId, boardId, currentVersion: result.currentVersion }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("get_board_history", toolCallId, error, { boardId }); }
});

server.registerTool("get_board_version", {
  title: "Get board version",
  description: "Read one persisted historical version of a board without changing the current board.",
  inputSchema: z.object({ boardId: z.string().min(1), version: z.number().int().min(0) })
}, async ({ boardId, version }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/versions/${version}`, { cache: "no-store" }); const result = await json(response); record("get_board_version", { toolCallId, boardId, version }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("get_board_version", toolCallId, error, { boardId, version }); }
});

for (const action of ["undo", "redo"]) server.registerTool(`${action}_board`, {
  title: action === "undo" ? "Undo the latest board change" : "Redo a board change",
  description: `${action === "undo" ? "Move backward" : "Move forward"} in the board history without creating a synthetic snapshot. A new edit after undo opens a new history branch.`,
  inputSchema: z.object({ boardId: z.string().min(1) })
}, async ({ boardId }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/${action}`, { method: "POST", headers: { "x-tool-call-id": toolCallId } }); const result = await json(response); record(`${action}_board-result`, { toolCallId, boardId, result, outcome: "ok" }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure(`${action}_board-result`, toolCallId, error, { boardId }); }
});

server.registerTool("get_board_capture", {
  title: "See the browser canvas bitmap",
  description: "Get the latest PNG published automatically by the open board page from its actual canvas bitmap. Returns image pixels and provenance/version/hash and dimensions, not path geometry. If the browser has not published the current version yet, retry after it renders.",
  inputSchema: z.object({ boardId: z.string().min(1) })
}, async ({ boardId }) => {
  const toolCallId = randomUUID();
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/capture`, { cache: "no-store",
      headers: { "x-tool-call-id": toolCallId } });
    if (!response.ok) throw new Error(`Capture HTTP ${response.status}: ${await response.text()}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const version = Number(response.headers.get("x-board-version"));
    if (response.headers.get("x-capture-source") !== "browser-canvas" || sha256 !== response.headers.get("x-capture-sha256")) throw new Error("Capture provenance/hash mismatch");
    record("get_board_capture", { toolCallId, boardId, version, sha256, bytes: bytes.length, source: "browser-canvas", outcome: "ok" });
    const captureWidth = Number(response.headers.get("x-capture-width"));
    const captureHeight = Number(response.headers.get("x-capture-height"));
    return { content: [
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `Board capture: boardId=${boardId}; version=${version}; source=browser-canvas; sha256=${sha256}; size=${captureWidth}x${captureHeight}.` }
    ] };
  } catch (error) { return failure("get_board_capture", toolCallId, error, { boardId }); }
});

server.registerTool("get_board_svg", {
  title: "Get the board SVG",
  description: "Get a deterministic server-rendered SVG of the current board model. This is a vector representation, not the literal browser canvas bitmap.",
  inputSchema: z.object({ boardId: z.string().min(1) })
}, async ({ boardId }) => {
  const toolCallId = randomUUID();
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/svg`, { cache: "no-store", headers: { "x-tool-call-id": toolCallId } });
    if (!response.ok) throw new Error(`SVG HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const version = Number(response.headers.get("x-board-version"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    record("get_board_svg", { toolCallId, boardId, version, sha256, bytes: bytes.length, source: "server-model", outcome: "ok" });
    return { content: [{ type: "resource", resource: { uri: `vcb://boards/${boardId}/svg`, mimeType: "image/svg+xml", blob: bytes.toString("base64") } }, { type: "text", text: `Board SVG: boardId=${boardId}; version=${version}; source=server-model; sha256=${sha256}.` }] };
  } catch (error) { return failure("get_board_svg", toolCallId, error, { boardId }); }
});

server.registerTool("add_agent_paths", {
  title: "Add paths to the open board",
  description: "Add 1–4 new red paths to the board using numeric board coordinates. Use get_board_structure for its width and height. Preserve all human paths. The open browser updates automatically.",
  inputSchema: z.object({
    boardId: z.string().min(1),
    paths: z.array(z.object({ points: z.array(z.tuple([z.number(), z.number()])).min(2).max(512) })).min(1).max(4)
  })
}, async ({ boardId, paths }) => {
  const toolCallId = randomUUID();
  record("add_agent_paths-called", { toolCallId, boardId, paths });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/agent-paths`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, paths }) });
    const result = await json(response);
    record("add_agent_paths-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("add_agent_paths-result", toolCallId, error, { boardId }); }
});

server.registerTool("add_agent_groups", {
  title: "Add named semantic groups to the open board",
  description: "Add 1–4 named red groups, each composed of 1–32 paths. Each point is a numeric [x, y] coordinate within the board dimensions returned by get_board_structure. Groups give related paths a stable semantic identity so they can be removed or replaced together. Preserve all human paths.",
  inputSchema: z.object({
    boardId: z.string().min(1),
    groups: z.array(z.object({ name: z.string().min(1), paths: z.array(z.object({ points: z.array(z.tuple([z.number(), z.number()])).min(2).max(512) })).min(1).max(32) })).min(1).max(4)
  })
}, async ({ boardId, groups }) => {
  const toolCallId = randomUUID();
  record("add_agent_groups-called", { toolCallId, boardId, groups });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/agent-groups`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, groups }) });
    const result = await json(response);
    record("add_agent_groups-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("add_agent_groups-result", toolCallId, error, { boardId }); }
});

server.registerTool("get_board_structure", {
  title: "Get named board structure",
  description: "Get the canonical versioned board model: dimensions, paths, semantic groups, rich elements, overlays and schema version. Use it to save, inspect or edit the board without requesting a rendered PNG.",
  inputSchema: z.object({ boardId: z.string().min(1) })
}, async ({ boardId }) => {
  const toolCallId = randomUUID();
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/structure`, { cache: "no-store", headers: { "x-tool-call-id": toolCallId } });
    const result = await json(response);
    record("get_board_structure", { toolCallId, boardId, version: result.version, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("get_board_structure", toolCallId, error, { boardId }); }
});

const richElementSchema = z.object({
  type: z.enum(["text", "rectangle", "ellipse", "line", "arrow"]),
  x: z.number().optional(), y: z.number().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(),
  text: z.string().optional(),
  fontSize: z.number().positive().optional(),
  points: z.array(z.tuple([z.number(), z.number()])).min(2).max(512).optional(),
  color: z.string().optional(), strokeWidth: z.number().positive().optional()
});

server.registerTool("add_elements", {
  title: "Add text and basic shapes",
  description: "Add agent-owned text, rectangles, ellipses, lines or arrows. Elements receive stable ids and render in the open browser and SVG. This does not alter human paths.",
  inputSchema: z.object({ boardId: z.string().min(1), elements: z.array(richElementSchema).min(1).max(16) })
}, async ({ boardId, elements }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/elements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, elements }) }); const result = await json(response); record("add_elements-result", { toolCallId, boardId, result, outcome: "ok" }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("add_elements-result", toolCallId, error, { boardId }); }
});

server.registerTool("move_elements", {
  title: "Move board elements",
  description: "Translate selected rich elements by a delta while preserving ids and author. Human elements require allowHuman=true.",
  inputSchema: z.object({ boardId: z.string().min(1), elementIds: z.array(z.string().min(1)).min(1).max(32), dx: z.number(), dy: z.number(), allowHuman: z.boolean().optional() })
}, async ({ boardId, elementIds, dx, dy, allowHuman }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/move-elements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, elementIds, dx, dy, allowHuman }) }); const result = await json(response); record("move_elements-result", { toolCallId, boardId, result, outcome: "ok" }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("move_elements-result", toolCallId, error, { boardId, elementIds }); }
});

server.registerTool("remove_elements", {
  title: "Remove board elements",
  description: "Remove selected agent-owned rich elements. Human elements require allowHuman=true; paths are unaffected.",
  inputSchema: z.object({ boardId: z.string().min(1), elementIds: z.array(z.string().min(1)).min(1).max(32), allowHuman: z.boolean().optional() })
}, async ({ boardId, elementIds, allowHuman }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/remove-elements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, elementIds, allowHuman }) }); const result = await json(response); record("remove_elements-result", { toolCallId, boardId, result, outcome: "ok" }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("remove_elements-result", toolCallId, error, { boardId, elementIds }); }
});

server.registerTool("move_paths", {
  title: "Move board paths",
  description: "Translate selected paths by a delta. Human paths require an explicit allowHuman=true confirmation. Other paths are preserved.",
  inputSchema: z.object({ boardId: z.string().min(1), pathIds: z.array(z.string().min(1)).min(1).max(32), dx: z.number(), dy: z.number(), allowHuman: z.boolean().optional() })
}, async ({ boardId, pathIds, dx, dy, allowHuman }) => {
  const toolCallId = randomUUID();
  try { await ensureBoardServer(); const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/move-paths`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, pathIds, dx, dy, allowHuman }) }); const result = await json(response); record("move_paths-result", { toolCallId, boardId, result, outcome: "ok" }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
  catch (error) { return failure("move_paths-result", toolCallId, error, { boardId, pathIds }); }
});

server.registerTool("remove_agent_groups", {
  title: "Remove named agent groups",
  description: "Remove selected red semantic groups and all paths belonging to them. Human paths and other groups remain unchanged.",
  inputSchema: z.object({ boardId: z.string().min(1), groupIds: z.array(z.string().min(1)).min(1).max(16) })
}, async ({ boardId, groupIds }) => {
  const toolCallId = randomUUID();
  record("remove_agent_groups-called", { toolCallId, boardId, groupIds });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/remove-agent-groups`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, groupIds }) });
    const result = await json(response);
    record("remove_agent_groups-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("remove-agent-groups-result", toolCallId, error, { boardId, groupIds }); }
});

server.registerTool("remove_agent_paths", {
  title: "Remove agent paths",
  description: "Remove selected red paths previously added by this agent. Human paths are never removed. The open browser updates automatically.",
  inputSchema: z.object({ boardId: z.string().min(1), pathIds: z.array(z.string().min(1)).min(1).max(16) })
}, async ({ boardId, pathIds }) => {
  const toolCallId = randomUUID();
  record("remove_agent_paths-called", { toolCallId, boardId, pathIds });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/remove-agent-paths`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, pathIds }) });
    const result = await json(response);
    record("remove_agent_paths-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("remove_agent_paths-result", toolCallId, error, { boardId, pathIds }); }
});

server.registerTool("remove_human_paths", {
  title: "Remove human paths by explicit request",
  description: "Remove selected blue paths only after an explicit user confirmation. The first attempt is rejected while human content is protected; after the user confirms, retry with force=true. The operation is versioned and can be undone.",
  inputSchema: z.object({ boardId: z.string().min(1), pathIds: z.array(z.string().min(1)).min(1).max(16), force: z.boolean().optional() })
}, async ({ boardId, pathIds, force }) => {
  const toolCallId = randomUUID();
  record("remove_human_paths-called", { toolCallId, boardId, pathIds });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/remove-human-paths`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, pathIds, force: force === true }) });
    const result = await json(response);
    record("remove_human_paths-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("remove_human_paths-result", toolCallId, error, { boardId, pathIds }); }
});

server.registerTool("add_image_overlay", {
  title: "Add a temporary image overlay",
  description: "Place a PNG reference layer using an explicit fit policy. Default native rejects images that do not fit without mutating the board and returns geometric options. Retry with contain (preserve all, margins) or cover (explicit crop); no silent distortion.",
  inputSchema: z.object({ boardId: z.string().min(1), source: z.enum(["current-capture", "stored-capture", "file"]), captureBoardId: z.string().min(1).optional(), captureVersion: z.number().int().min(0).optional(), filePath: z.string().min(1).optional(), opacity: z.number().min(0).max(1).optional(), fit: z.enum(["native", "contain", "cover"]).optional() })
}, async ({ boardId, source, captureBoardId, captureVersion, filePath, opacity, fit }) => {
  const toolCallId = randomUUID();
  record("add_image_overlay-called", { toolCallId, boardId, source, opacity });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/overlays`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId, source, captureBoardId, captureVersion, filePath, opacity, fit }) });
    const result = await json(response);
    record("add_image_overlay-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("add_image_overlay-result", toolCallId, error, { boardId }); }
});

server.registerTool("remove_image_overlay", {
  title: "Remove an image overlay",
  description: "Remove a temporary image reference layer by overlay ID without removing any human or agent paths.",
  inputSchema: z.object({ boardId: z.string().min(1), overlayId: z.string().min(1) })
}, async ({ boardId, overlayId }) => {
  const toolCallId = randomUUID();
  record("remove_image_overlay-called", { toolCallId, boardId, overlayId });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}/overlays/${encodeURIComponent(overlayId)}`, { method: "DELETE" });
    const result = await json(response);
    record("remove_image_overlay-result", { toolCallId, boardId, overlayId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("remove_image_overlay-result", toolCallId, error, { boardId, overlayId }); }
});

server.registerTool("close_board", {
  title: "Close one board",
  description: "Close one board by ID while leaving the MCP server and other boards running. This invalidates the board URL and removes that board's in-memory state.",
  inputSchema: z.object({ boardId: z.string().min(1) })
}, async ({ boardId }) => {
  const toolCallId = randomUUID();
  record("close_board-called", { toolCallId, boardId });
  try {
    await ensureBoardServer();
    const response = await fetch(`${base}/api/boards/${encodeURIComponent(boardId)}`, {
      method: "DELETE",
      headers: { "x-tool-call-id": toolCallId }
    });
    const result = await json(response);
    record("close_board-result", { toolCallId, boardId, result, outcome: "ok" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return failure("close_board-result", toolCallId, error, { boardId }); }
});

void serveStdio(() => server);
