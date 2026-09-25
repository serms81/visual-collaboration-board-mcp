import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { renderPng } from "./png.mjs";
import { renderSvg } from "./svg.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = process.env.VCB_DATA_DIR ?? join(here, "..", "data");
const port = Number(process.env.VCB_PORT ?? 4183);
const origin = `http://127.0.0.1:${port}`;
const page = readFileSync(join(here, "page.html"));
const sessionId = randomUUID();
const boards = new Map();
const changeListeners = new Set();
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
for (const child of ["states", "captures", "model-captures", "boards"]) mkdirSync(join(evidenceDir, child), { recursive: true });

function record(kind, fields = {}) {
  const event = { at: new Date().toISOString(), epochMs: Date.now(), sessionId, kind, ...fields };
  appendFileSync(join(evidenceDir, "session.jsonl"), JSON.stringify(event) + "\n");
  return event;
}
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function onBoardChange(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); }
function emitBoardChange(board, event) {
  const payload = { boardId: board.id, version: board.version, serverEpochMs: event.epochMs };
  for (const subscriber of board.subscribers) subscriber.write(`event: board-change\ndata: ${JSON.stringify(payload)}\n\n`);
  for (const listener of changeListeners) listener(payload);
}
function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error("Expected a PNG image");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function imageFit(image, board, mode) {
  const fitsNative = image.width <= board.width && image.height <= board.height;
  const containScale = Math.min(board.width / image.width, board.height / image.height, 1);
  const coverScale = Math.max(board.width / image.width, board.height / image.height);
  const option = (scale, cropped) => {
    const width = Math.round(image.width * scale); const height = Math.round(image.height * scale);
    return { mode, scale, rendered: { width, height }, margins: { left: Math.floor((board.width - width) / 2), right: Math.ceil((board.width - width) / 2), top: Math.floor((board.height - height) / 2), bottom: Math.ceil((board.height - height) / 2) }, cropped, distorted: false,
      draw: { x: Math.floor((board.width - width) / 2), y: Math.floor((board.height - height) / 2), width, height } };
  };
  const options = [
    { ...option(1, false), mode: "native", scale: 1, rendered: { width: image.width, height: image.height }, margins: { left: Math.floor((board.width - image.width) / 2), right: Math.ceil((board.width - image.width) / 2), top: Math.floor((board.height - image.height) / 2), bottom: Math.ceil((board.height - image.height) / 2) } },
    { ...option(containScale, false), mode: "contain" },
    { ...option(coverScale, true), mode: "cover" }
  ];
  if (mode === "native" && !fitsNative) return { fitsNative, options, rejection: "IMAGE_DOES_NOT_FIT" };
  return { fitsNative, selected: options.find(item => item.mode === mode) };
}
function respondJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Body too large")); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) { return JSON.parse((await readBody(req, 1_000_000)).toString("utf8")); }
function persistCurrent(board) {
  const { capture, subscribers, ...value } = board;
  value.overlays = board.overlays.map(({ id, opacity, fit, image, bytes }) => ({ id, opacity, fit, image, data: bytes?.toString("base64") ?? null }));
  writeFileSync(join(evidenceDir, "boards", `${board.id}.json`), JSON.stringify(value, null, 2) + "\n");
}
function snapshot(board, { trackHistory = true, writeState = true } = {}) {
  if (trackHistory) {
    if (!Array.isArray(board.historyVersions)) { board.historyVersions = [board.version]; board.historyCursor = 0; }
    else if (board.historyVersions[board.historyCursor] !== board.version) {
      board.historyVersions = board.historyVersions.slice(0, (board.historyCursor ?? board.historyVersions.length - 1) + 1);
      board.historyVersions.push(board.version); board.historyCursor = board.historyVersions.length - 1;
    }
  }
  const { capture, subscribers, ...value } = board;
  value.overlays = board.overlays.map(({ id, opacity, fit, image, bytes }) => ({ id, opacity, fit, image, data: bytes?.toString("base64") ?? null }));
  if (writeState) writeFileSync(join(evidenceDir, "states", `${board.id}-v${board.version}.json`), JSON.stringify(value, null, 2) + "\n");
  writeFileSync(join(evidenceDir, "boards", `${board.id}.json`), JSON.stringify(value, null, 2) + "\n");
}
function validPath(board, points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= 512 && points.every(point =>
    Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
    point[0] >= 0 && point[0] <= board.width && point[1] >= 0 && point[1] <= board.height);
}
function validElement(board, element) {
  if (!element || typeof element !== "object" || typeof element.type !== "string") return false;
  if (!["text", "rectangle", "ellipse", "line", "arrow"].includes(element.type)) return false;
  if (["text", "rectangle", "ellipse"].includes(element.type) && (!Number.isFinite(element.x) || !Number.isFinite(element.y))) return false;
  if (["rectangle", "ellipse"].includes(element.type) && (!Number.isFinite(element.width) || !Number.isFinite(element.height) || element.width <= 0 || element.height <= 0)) return false;
  if (["line", "arrow"].includes(element.type) && !validPath(board, element.points)) return false;
  if (element.strokeWidth !== undefined && (!Number.isFinite(element.strokeWidth) || element.strokeWidth <= 0)) return false;
  return true;
}
function snapCoordinate(board, value) {
  const size = board.grid?.size ?? 24;
  return board.grid?.snap ? Math.round(value / size) * size : value;
}
function snapElement(board, element) {
  if (!board.grid?.snap) return element;
  const snapped = { ...element };
  if (Number.isFinite(snapped.x)) snapped.x = snapCoordinate(board, snapped.x);
  if (Number.isFinite(snapped.y)) snapped.y = snapCoordinate(board, snapped.y);
  if (Array.isArray(snapped.points)) snapped.points = snapped.points.map(([x, y]) => [snapCoordinate(board, x), snapCoordinate(board, y)]);
  if (Number.isFinite(snapped.width)) snapped.width = Math.max(board.grid.size, snapCoordinate(board, snapped.width));
  if (Number.isFinite(snapped.height)) snapped.height = Math.max(board.grid.size, snapCoordinate(board, snapped.height));
  return snapped;
}
function addPath(board, author, points, toolCallId = null, metadata = {}) {
  const prefix = author === "human" ? "h" : "a";
  board.nextPathNumber[author] += 1;
  const id = `${prefix}-${board.nextPathNumber[author]}`;
  const path = { id, author, color: author === "human" ? "#2459a6" : "#cf3b46", width: 5, points, ...metadata };
  board.paths.push(path); board.version += 1; board.capture = null;
  snapshot(board);
  const event = record("path-added", { boardId: board.id, version: board.version, id, author, toolCallId,
    pointCount: points.length, humanIds: board.paths.filter(p => p.author === "human").map(p => p.id),
    agentIds: board.paths.filter(p => p.author === "agent").map(p => p.id) });
  emitBoardChange(board, event);
  return { id, version: board.version, pathCount: board.paths.length };
}
function boardFrom(pathname) {
  const match = pathname.match(/^\/api\/boards\/([^/]+)(?:\/(.*))?$/);
  return match ? { board: boards.get(match[1]), id: match[1], action: match[2] ?? "" } : null;
}

function loadBoards() {
  for (const filename of readdirSync(join(evidenceDir, "boards"))) {
    if (!filename.endsWith(".json")) continue;
    try {
      const value = JSON.parse(readFileSync(join(evidenceDir, "boards", filename), "utf8"));
      if (!value?.id || !Number.isInteger(value.width) || !Number.isInteger(value.height)) continue;
      const persistedVersions = readdirSync(join(evidenceDir, "states")).filter(name => name.startsWith(`${value.id}-v`) && name.endsWith(".json")).map(name => Number(name.match(/-v(\d+)\.json$/)?.[1])).filter(Number.isInteger).sort((a, b) => a - b);
      const historyVersions = value.historyVersions ?? (persistedVersions.length ? persistedVersions : [value.version]);
      boards.set(value.id, { ...value, grid: value.grid ?? { size: 24, snap: false }, elements: value.elements ?? [], nextElementNumber: value.nextElementNumber ?? 0, historyVersions, historyCursor: value.historyCursor ?? Math.max(0, historyVersions.length - 1), capture: null, subscribers: new Set(), overlays: (value.overlays ?? []).map(({ id, opacity, fit, image, data }) => ({ id, opacity, fit, image, bytes: data ? Buffer.from(data, "base64") : Buffer.alloc(0) })) });
    } catch (error) { record("board-load-failed", { filename, error: String(error) }); }
  }
}
loadBoards();

function applyHistoryVersion(board, version) {
  const filename = `${board.id}-v${version}.json`;
  if (!existsSync(join(evidenceDir, "states", filename))) throw new Error("Board version not found");
  const saved = JSON.parse(readFileSync(join(evidenceDir, "states", filename), "utf8"));
  const subscribers = board.subscribers;
  const historyVersions = board.historyVersions;
  const historyCursor = board.historyCursor;
  Object.assign(board, saved, { version: saved.version, historyVersions, historyCursor, capture: null, subscribers,
    overlays: (saved.overlays ?? []).map(({ id, opacity, fit, image, data }) => ({ id, opacity, fit, image, bytes: data ? Buffer.from(data, "base64") : Buffer.alloc(0) })) });
  persistCurrent(board);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") return respondJson(res, 200, { ok: true, boardCount: boards.size, sessionId });
  if (req.method === "GET" && pathname === "/api/boards") return respondJson(res, 200, { boards: [...boards.values()].map(board => ({ boardId: board.id, width: board.width, height: board.height, version: board.version })) });
  if (req.method === "POST" && pathname === "/api/boards") {
    try {
      const input = await readJson(req);
      if (input.origin !== "mcp" || typeof input.toolCallId !== "string") throw new Error("Expected MCP tool origin");
      const width = input.width === undefined ? 640 : input.width;
      const height = input.height === undefined ? 400 : input.height;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240 || width > 2400 || height > 1600) throw new Error("Board dimensions must be integers within 320..2400 × 240..1600");
      const id = `board-${randomUUID().slice(0, 8)}`;
      const board = { id, width, height, version: 0, grid: { size: 24, snap: false }, paths: [], elements: [], groups: [], nextPathNumber: { human: 0, agent: 0 }, nextElementNumber: 0, nextGroupNumber: 0, overlays: [], capture: null, subscribers: new Set() };
      boards.set(id, board); snapshot(board);
      const boardUrl = `${origin}/boards/${id}`;
      record("board-created", { boardId: id, version: 0, toolCallId: input.toolCallId, url: boardUrl });
      return respondJson(res, 201, { boardId: id, url: boardUrl, version: 0, width, height });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  const pageMatch = pathname.match(/^\/boards\/([^/]+)$/);
  if (req.method === "GET" && pageMatch) {
    if (!boards.has(pageMatch[1])) return respondJson(res, 404, { error: "Board not found" });
    record("page-request", { boardId: pageMatch[1], diagnostic: url.searchParams.get("diagnostic") === "1" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(page);
  }
  const route = boardFrom(pathname);
  if (!route) return respondJson(res, 404, { error: "Not found" });
  const { board, id, action } = route;
  if (!board) return respondJson(res, 404, { error: "Board not found" });
  if (req.method === "DELETE" && action === "") {
    for (const subscriber of board.subscribers) subscriber.end();
    board.subscribers.clear();
    boards.delete(id);
    record("board-closed", { boardId: id, version: board.version });
    return respondJson(res, 200, { boardId: id, closed: true });
  }
  if (req.method === "GET" && action === "state") return respondJson(res, 200, { id, width: board.width, height: board.height, version: board.version, grid: board.grid ?? { size: 24, snap: false }, historyVersions: board.historyVersions ?? [board.version], historyCursor: board.historyCursor ?? 0, paths: board.paths, elements: board.elements ?? [], overlays: board.overlays.map(({ id: overlayId, opacity, fit, image }) => ({ id: overlayId, opacity, fit, image })) });
  if (req.method === "POST" && action === "grid") {
    try {
      const input = await readJson(req);
      if (input.origin !== "ui" || typeof input.toolCallId !== "string" || typeof input.snap !== "boolean") throw new Error("Grid settings are controlled by the UI");
      const size = input.size === undefined ? (board.grid?.size ?? 24) : input.size;
      if (!Number.isInteger(size) || size < 8 || size > 128) throw new Error("Grid size must be an integer within 8..128");
      board.grid = { size, snap: input.snap };
      persistCurrent(board);
      const event = record("grid-settings-changed", { boardId: id, version: board.version, grid: board.grid, toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, grid: board.grid, agentUnaffected: true });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "GET" && action === "history") {
    const versions = readdirSync(join(evidenceDir, "states")).filter(name => name.startsWith(`${id}-v`) && name.endsWith(".json")).map(name => Number(name.match(/-v(\d+)\.json$/)?.[1])).filter(Number.isInteger).sort((a, b) => a - b);
    return respondJson(res, 200, { boardId: id, currentVersion: board.version, versions, historyVersions: board.historyVersions ?? versions, historyCursor: board.historyCursor ?? Math.max(0, versions.indexOf(board.version)) });
  }
  if (req.method === "POST" && (action === "undo" || action === "redo")) {
    try {
      const historyVersions = board.historyVersions ?? [board.version];
      const cursor = board.historyCursor ?? historyVersions.length - 1;
      const nextCursor = action === "undo" ? cursor - 1 : cursor + 1;
      if (nextCursor < 0 || nextCursor >= historyVersions.length) return respondJson(res, 409, { error: action === "undo" ? "Nothing to undo" : "Nothing to redo", boardId: id, version: board.version, canUndo: cursor > 0, canRedo: cursor < historyVersions.length - 1 });
      board.historyCursor = nextCursor;
      applyHistoryVersion(board, historyVersions[nextCursor]);
      const event = record(`board-${action}`, { boardId: id, version: board.version, historyCursor: nextCursor, toolCallId: req.headers["x-tool-call-id"] ?? null });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, historyCursor: nextCursor, canUndo: nextCursor > 0, canRedo: nextCursor < historyVersions.length - 1 });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  const versionMatch = action.match(/^versions\/(\d+)$/);
  if (req.method === "GET" && versionMatch) {
    const version = Number(versionMatch[1]);
    const filename = `${id}-v${version}.json`;
    if (!existsSync(join(evidenceDir, "states", filename))) return respondJson(res, 404, { error: "Board version not found", boardId: id, version });
    return respondJson(res, 200, JSON.parse(readFileSync(join(evidenceDir, "states", filename), "utf8")));
  }
  if (req.method === "POST" && action === "restore-version") {
    try {
      const input = await readJson(req);
      if (!Number.isInteger(input.version) || input.version < 0) throw new Error("Expected a board version");
      const filename = `${id}-v${input.version}.json`;
      if (!existsSync(join(evidenceDir, "states", filename))) throw new Error("Board version not found");
      const saved = JSON.parse(readFileSync(join(evidenceDir, "states", filename), "utf8"));
      const subscribers = board.subscribers; const restoredVersion = board.version + 1;
      Object.assign(board, saved, { version: restoredVersion, capture: null, subscribers });
      snapshot(board);
      const event = record("board-restored", { boardId: id, version: restoredVersion, restoredVersion: input.version, toolCallId: input.toolCallId ?? null });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: restoredVersion, restoredVersion: input.version });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "GET" && action === "events") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    board.subscribers.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ version: board.version })}\n\n`);
    record("sse-connected", { boardId: id, version: board.version, subscribers: board.subscribers.size });
    req.on("close", () => { board.subscribers.delete(res); record("sse-disconnected", { boardId: id, subscribers: board.subscribers.size }); });
    return;
  }
  if (req.method === "POST" && action === "human-paths") {
    try {
      const input = await readJson(req);
      if (!validPath(board, input.points)) throw new Error("Expected 2–512 board-coordinate points");
      return respondJson(res, 201, addPath(board, "human", input.points));
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "agent-paths") {
    try {
      const input = await readJson(req);
      if (input.origin !== "mcp" || typeof input.toolCallId !== "string") throw new Error("Expected MCP tool origin");
      if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 4 || input.paths.some(p => !validPath(board, p.points))) throw new Error("Expected 1–4 valid paths");
      const beforeHuman = JSON.stringify(board.paths.filter(p => p.author === "human"));
      const added = input.paths.map(p => addPath(board, "agent", p.points, input.toolCallId));
      const humanPathsUnchanged = beforeHuman === JSON.stringify(board.paths.filter(p => p.author === "human"));
      return respondJson(res, 201, { boardId: id, version: board.version, added, humanPathsUnchanged });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "elements") {
    try {
      const input = await readJson(req);
      if (!(input.origin === "mcp" || input.origin === "ui") || typeof input.toolCallId !== "string" || !Array.isArray(input.elements) || input.elements.length < 1 || input.elements.length > 16) throw new Error("Expected 1–16 elements");
      const elements = input.origin === "ui" && board.grid?.snap ? input.elements.map(element => snapElement(board, element)) : input.elements;
      if (elements.some(element => !validElement(board, element))) throw new Error("Invalid rich element");
      const created = elements.map(element => {
        board.nextElementNumber += 1;
        const id = `e-${board.nextElementNumber}`;
        const author = input.origin === "ui" ? "human" : "agent";
        const normalized = { ...element, id, author, color: element.color ?? (author === "human" ? "#2459a6" : "#cf3b46"), strokeWidth: element.strokeWidth ?? 2 };
        board.elements.push(normalized);
        return normalized;
      });
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("elements-added", { boardId: id, version: board.version, elementIds: created.map(element => element.id), toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 201, { boardId: id, version: board.version, added: created.map(element => ({ id: element.id, type: element.type, author: element.author })), humanElementsUnchanged: input.origin === "mcp" });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "move-elements") {
    try {
      const input = await readJson(req);
      if (!(input.origin === "mcp" || input.origin === "ui") || typeof input.toolCallId !== "string" || !Array.isArray(input.elementIds) || input.elementIds.length < 1 || input.elementIds.length > 32) throw new Error("Expected 1–32 element IDs");
      if (!Number.isFinite(input.dx) || !Number.isFinite(input.dy)) throw new Error("Expected numeric dx and dy");
      const requested = new Set(input.elementIds); const selected = (board.elements ?? []).filter(element => requested.has(element.id));
      if (selected.length !== requested.size) throw new Error("One or more element IDs were not found");
      if (selected.some(element => element.author === "human") && input.allowHuman !== true) throw new Error("Moving human elements requires allowHuman=true");
      for (const element of selected) {
        const moved = { ...element, x: element.x + input.dx, y: element.y + input.dy, points: element.points?.map(([x, y]) => [x + input.dx, y + input.dy]) };
        if (!validElement(board, moved) || moved.x < 0 || moved.y < 0 || (moved.width && moved.x + moved.width > board.width) || (moved.height && moved.y + moved.height > board.height) || moved.points?.some(([x, y]) => x < 0 || x > board.width || y < 0 || y > board.height)) throw new Error(`Move would leave board bounds for ${element.id}`);
        Object.assign(element, moved);
      }
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("elements-moved", { boardId: id, version: board.version, moved: [...requested], dx: input.dx, dy: input.dy, toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, moved: [...requested] });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "remove-elements") {
    try {
      const input = await readJson(req);
      if (!(input.origin === "mcp" || input.origin === "ui") || typeof input.toolCallId !== "string" || !Array.isArray(input.elementIds) || input.elementIds.length < 1 || input.elementIds.length > 32) throw new Error("Expected 1–32 element IDs");
      const requested = new Set(input.elementIds); const selected = (board.elements ?? []).filter(element => requested.has(element.id));
      if (selected.length !== requested.size) throw new Error("One or more element IDs were not found");
      if (selected.some(element => element.author === "human") && input.allowHuman !== true) throw new Error("Removing human elements requires allowHuman=true");
      board.elements = board.elements.filter(element => !requested.has(element.id));
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("elements-removed", { boardId: id, version: board.version, removed: [...requested], toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, removed: [...requested] });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "move-paths") {
    try {
      const input = await readJson(req);
      if (input.origin !== "mcp" || typeof input.toolCallId !== "string" || !Array.isArray(input.pathIds) || input.pathIds.length < 1 || input.pathIds.length > 32) throw new Error("Expected 1–32 path IDs");
      if (!Number.isFinite(input.dx) || !Number.isFinite(input.dy)) throw new Error("Expected numeric dx and dy");
      const requested = new Set(input.pathIds);
      const selected = board.paths.filter(path => requested.has(path.id));
      if (selected.length !== requested.size) throw new Error("One or more path IDs were not found");
      if (selected.some(path => path.author === "human") && input.allowHuman !== true) throw new Error("Moving human paths requires allowHuman=true");
      const moved = selected.map(path => {
        const points = path.points.map(([x, y]) => [x + input.dx, y + input.dy]);
        if (!validPath(board, points)) throw new Error(`Move would leave board bounds for ${path.id}`);
        path.points = points;
        return path.id;
      });
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("paths-moved", { boardId: id, version: board.version, moved, dx: input.dx, dy: input.dy, toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, moved });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "agent-groups") {
    try {
      const input = await readJson(req);
      if (input.origin !== "mcp" || typeof input.toolCallId !== "string" || !Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 4) throw new Error("Expected 1–4 semantic groups");
      if (input.groups.some(group => typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.paths) || group.paths.length < 1 || group.paths.length > 32 || group.paths.some(path => !validPath(board, path.points)))) throw new Error("Expected named groups with 1–32 valid paths");
      const beforeHuman = JSON.stringify(board.paths.filter(path => path.author === "human"));
      const created = input.groups.map(group => {
        board.nextGroupNumber += 1;
        const groupId = `g-${board.nextGroupNumber}`;
        const pathIds = group.paths.map(path => addPath(board, "agent", path.points, input.toolCallId, { groupId, groupName: group.name.trim() }).id);
        board.groups.push({ id: groupId, name: group.name.trim(), author: "agent", pathIds });
        return { id: groupId, name: group.name.trim(), pathIds };
      });
      const humanPathsUnchanged = beforeHuman === JSON.stringify(board.paths.filter(path => path.author === "human"));
      return respondJson(res, 201, { boardId: id, version: board.version, groups: created, humanPathsUnchanged });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "GET" && action === "structure") {
    return respondJson(res, 200, { format: "vcb-board-structure", schemaVersion: 1, id, width: board.width, height: board.height, version: board.version, grid: board.grid ?? { size: 24, snap: false }, groups: board.groups, paths: board.paths, elements: board.elements ?? [], overlays: board.overlays.map(({ id: overlayId, opacity, fit, image }) => ({ id: overlayId, opacity, fit, image })) });
  }
  if (req.method === "POST" && action === "remove-agent-groups") {
    try {
      const input = await readJson(req);
      if (input.origin !== "mcp" || typeof input.toolCallId !== "string" || !Array.isArray(input.groupIds) || input.groupIds.length < 1 || input.groupIds.length > 16) throw new Error("Expected 1–16 agent group IDs");
      const requested = new Set(input.groupIds);
      const groups = board.groups.filter(group => group.author === "agent" && requested.has(group.id));
      if (groups.length === 0) throw new Error("No matching agent groups found");
      const pathIds = new Set(groups.flatMap(group => group.pathIds));
      board.paths = board.paths.filter(path => !pathIds.has(path.id));
      board.groups = board.groups.filter(group => !requested.has(group.id));
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("groups-removed", { boardId: id, version: board.version, removed: groups.map(group => group.id), toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, removed: groups.map(group => group.id), humanPathsUnchanged: true });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "remove-agent-paths") {
    try {
      const input = await readJson(req);
      if (!(input.origin === "mcp" || input.origin === "ui") || typeof input.toolCallId !== "string" || !Array.isArray(input.pathIds) || input.pathIds.length < 1 || input.pathIds.length > 16) throw new Error("Expected 1–16 agent path IDs");
      const requested = new Set(input.pathIds);
      const removed = board.paths.filter(path => path.author === "agent" && requested.has(path.id)).map(path => path.id);
      if (removed.length === 0) throw new Error("No matching agent paths found");
      board.paths = board.paths.filter(path => !removed.includes(path.id));
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("paths-removed", { boardId: id, version: board.version, removed, toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, removed, humanPathsUnchanged: true });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "remove-human-paths") {
    try {
      const input = await readJson(req);
      if (!(input.origin === "mcp" || input.origin === "ui") || typeof input.toolCallId !== "string" || !Array.isArray(input.pathIds) || input.pathIds.length < 1 || input.pathIds.length > 16) throw new Error("Expected 1–16 human path IDs");
      if (input.origin === "mcp" && input.force !== true) return respondJson(res, 423, { error: "HUMAN_CONTENT_LOCKED", message: "Human paths are protected. Ask the user for confirmation and retry with force=true.", pathIds: input.pathIds, humanContentLocked: true });
      const requested = new Set(input.pathIds);
      const removed = board.paths.filter(path => path.author === "human" && requested.has(path.id)).map(path => path.id);
      if (removed.length === 0) throw new Error("No matching human paths found");
      board.paths = board.paths.filter(path => !removed.includes(path.id));
      board.version += 1; board.capture = null; snapshot(board);
      const event = record("human-paths-removed", { boardId: id, version: board.version, removed, force: input.force === true, toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 200, { boardId: id, version: board.version, removed });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  if (req.method === "POST" && action === "overlays") {
    try {
      const input = await readJson(req, 20_000_000);
      if (input.origin !== "mcp" || typeof input.toolCallId !== "string" || !["current-capture", "stored-capture", "file"].includes(input.source)) throw new Error("Expected current-capture, stored-capture or file overlay source");
      let bytes;
      if (input.source === "current-capture") {
        if (!board.capture || board.capture.version !== board.version) throw new Error("Current canvas capture not yet published");
        bytes = board.capture.bytes;
      } else if (input.source === "stored-capture") {
        if (typeof input.captureBoardId !== "string" || !Number.isInteger(input.captureVersion) || input.captureVersion < 0) throw new Error("Expected captureBoardId and captureVersion");
        const filename = readdirSync(join(evidenceDir, "captures")).find(name => name.startsWith(`${input.captureBoardId}-v${input.captureVersion}-`) && name.endsWith(".png"));
        if (!filename) throw new Error("Stored capture not found");
        bytes = readFileSync(join(evidenceDir, "captures", filename));
      } else {
        if (typeof input.filePath !== "string" || !input.filePath.endsWith(".png")) throw new Error("Expected a local PNG filePath");
        bytes = readFileSync(input.filePath);
      }
      const fitMode = input.fit ?? "native";
      if (!["native", "contain", "cover"].includes(fitMode)) throw new Error("Expected fit native, contain or cover");
      const image = pngDimensions(bytes); const fit = imageFit(image, board, fitMode);
      if (fit.rejection) return respondJson(res, 409, { error: fit.rejection, board: { width: board.width, height: board.height }, image, fitsNative: fit.fitsNative, options: fit.options });
      const overlay = { id: `overlay-${randomUUID().slice(0, 8)}`, opacity: Number.isFinite(input.opacity) ? Math.max(0, Math.min(1, input.opacity)) : 0.45, bytes, image, fit: fit.selected };
      board.overlays.push(overlay); board.version += 1; board.capture = null; snapshot(board);
      const event = record("overlay-added", { boardId: id, version: board.version, overlayId: overlay.id, source: input.source, toolCallId: input.toolCallId });
      emitBoardChange(board, event);
      return respondJson(res, 201, { boardId: id, version: board.version, overlayId: overlay.id, opacity: overlay.opacity, image, fit: overlay.fit });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  const overlayImage = action.match(/^overlays\/([^/]+)\/image$/);
  if (req.method === "GET" && overlayImage) {
    const overlay = board.overlays.find(item => item.id === overlayImage[1]);
    if (!overlay) return respondJson(res, 404, { error: "Overlay not found" });
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    return res.end(overlay.bytes);
  }
  const overlayDelete = action.match(/^overlays\/([^/]+)$/);
  if (req.method === "DELETE" && overlayDelete) {
    const index = board.overlays.findIndex(item => item.id === overlayDelete[1]);
    if (index < 0) return respondJson(res, 404, { error: "Overlay not found" });
    const [removed] = board.overlays.splice(index, 1); board.version += 1; board.capture = null; snapshot(board);
    const event = record("overlay-removed", { boardId: id, version: board.version, overlayId: removed.id });
    emitBoardChange(board, event);
    return respondJson(res, 200, { boardId: id, version: board.version, removed: removed.id });
  }
  if (req.method === "POST" && action === "canvas-capture") {
    try {
      const bytes = await readBody(req);
      const version = Number(req.headers["x-board-version"]);
      const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
      const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
      if (!bytes.subarray(0, 8).equals(pngSignature) || width !== board.width || height !== board.height) throw new Error(`Expected ${board.width}x${board.height} PNG canvas bytes`);
      if (version !== board.version) throw new Error(`Stale canvas version ${version}; current ${board.version}`);
      const hash = sha(bytes);
      const file = `${id}-v${version}-${hash.slice(0, 12)}.png`;
      writeFileSync(join(evidenceDir, "captures", file), bytes);
      board.capture = { bytes, version, sha256: hash, file, width, height,
        diagnostic: req.headers["x-diagnostic-marker"] === "1" };
      record("canvas-capture-published", { boardId: id, version, sha256: hash, file, bytes: bytes.length, width, height,
        diagnostic: board.capture.diagnostic, browserEpochMs: Number(req.headers["x-browser-epoch-ms"]) });
      return respondJson(res, 201, { boardId: id, version, sha256: hash, file });
    } catch (error) { return respondJson(res, 409, { error: String(error) }); }
  }
  if (req.method === "GET" && action === "capture") {
    if (!board.capture || board.capture.version !== board.version) return respondJson(res, 409, { error: "Current canvas capture not yet published", boardId: id, version: board.version });
    const c = board.capture;
    record("canvas-capture-served", { boardId: id, version: c.version, sha256: c.sha256, file: c.file, toolCallId: req.headers["x-tool-call-id"] ?? null });
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-board-id": id,
      "x-board-version": String(c.version), "x-capture-sha256": c.sha256, "x-capture-source": "browser-canvas", "x-capture-width": String(c.width), "x-capture-height": String(c.height), "x-diagnostic-marker": c.diagnostic ? "1" : "0" });
    return res.end(c.bytes);
  }
  if (req.method === "GET" && action === "model-capture") {
    const bytes = renderPng(board); const hash = sha(bytes); const file = `${id}-v${board.version}-${hash.slice(0, 12)}.png`;
    writeFileSync(join(evidenceDir, "model-captures", file), bytes);
    record("model-capture-created", { boardId: id, version: board.version, sha256: hash, file });
    res.writeHead(200, { "content-type": "image/png", "x-capture-sha256": hash, "x-capture-source": "server-model" });
    return res.end(bytes);
  }
  if (req.method === "GET" && action === "svg") {
    const bytes = Buffer.from(renderSvg(board), "utf8");
    const hash = sha(bytes);
    record("model-svg-served", { boardId: id, version: board.version, sha256: hash, toolCallId: req.headers["x-tool-call-id"] ?? null });
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store", "x-board-id": id, "x-board-version": String(board.version), "x-render-source": "server-model", "x-render-sha256": hash, "x-render-width": String(board.width), "x-render-height": String(board.height) });
    return res.end(bytes);
  }
  if (req.method === "POST" && action === "browser-event") {
    try {
      const input = await readJson(req);
      if (!["page-ready", "rendered"].includes(input.kind)) throw new Error("Unknown browser event");
      record(`browser-${input.kind}`, { boardId: id, version: input.version, source: input.source,
        browserEpochMs: input.browserEpochMs, serverEpochMs: input.serverEpochMs,
        latencyMs: Number.isFinite(input.serverEpochMs) ? input.browserEpochMs - input.serverEpochMs : null,
        humanIds: input.humanIds, agentIds: input.agentIds });
      return respondJson(res, 200, { ok: true });
    } catch (error) { return respondJson(res, 400, { error: String(error) }); }
  }
  return respondJson(res, 404, { error: "Not found" });
});

let serverReady;
export function ensureBoardServer() {
  if (!serverReady) serverReady = new Promise((resolve, reject) => {
    const onError = async error => {
      serverReady = undefined;
      if (error.code === "EADDRINUSE") {
        try {
          const response = await fetch(`${origin}/api/health`, { cache: "no-store" });
          const health = await response.json();
          if (response.ok && health.ok === true && typeof health.sessionId === "string") {
            record("server-reused", { origin, existingSessionId: health.sessionId, boardCount: health.boardCount });
            resolve(origin);
            return;
          }
        } catch {
          // The occupied port is not a healthy VCB server; preserve the original error.
        }
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      record("server-started", { origin, boardCount: boards.size });
      process.stderr.write(`VCB board server: ${origin}\n`);
      resolve(origin);
    });
  });
  return serverReady;
}

export async function closeBoardServer() {
  if (!serverReady) return;
  await serverReady;
  await new Promise((resolve, reject) => server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
  serverReady = undefined;
}
