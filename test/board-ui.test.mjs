import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "vcb-test-"));
process.env.VCB_PORT = "4221";
process.env.VCB_DATA_DIR = dataDir;
const { ensureBoardServer, closeBoardServer } = await import("../src/server.mjs");
await ensureBoardServer();
const base = "http://127.0.0.1:4221";
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, options);
  const value = options.expectText ? await response.text() : await response.json();
  assert.equal(response.ok, true, `${path}: ${JSON.stringify(value)}`);
  return value;
};
const post = (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("rich editing, canonical structure, SVG and version recovery", async () => {
  const created = await post("/api/boards", { origin: "mcp", toolCallId: "test-create", width: 900, height: 600 });
  const id = created.boardId;
  const added = await post(`/api/boards/${id}/elements`, { origin: "mcp", toolCallId: "test-add", elements: [
    { type: "text", x: 30, y: 40, text: "Test", fontSize: 22 },
    { type: "rectangle", x: 60, y: 80, width: 260, height: 150, strokeWidth: 3 },
    { type: "ellipse", x: 360, y: 80, width: 180, height: 120, strokeWidth: 4 },
    { type: "arrow", points: [[80, 300], [220, 330]], strokeWidth: 5 }
  ] });
  assert.equal(added.version, 1);
  const structure = await request(`/api/boards/${id}/structure`);
  assert.equal(structure.format, "vcb-board-structure");
  assert.equal(structure.schemaVersion, 1);
  assert.equal(structure.elements[1].width, 260);
  assert.equal(structure.elements[1].strokeWidth, 3);
  const humanElement = await post(`/api/boards/${id}/elements`, { origin: "ui", toolCallId: "test-human-element", elements: [{ type: "rectangle", x: 700, y: 400, width: 80, height: 60 }] });
  assert.equal(humanElement.added[0].author, "human");
  const svg = await request(`/api/boards/${id}/svg`, { expectText: true });
  assert.match(svg, /data-element-id="e-2"/);
  assert.match(svg, /<text/);
  const moved = await post(`/api/boards/${id}/move-elements`, { origin: "ui", toolCallId: "test-move", elementIds: ["e-2"], dx: 10, dy: 5 });
  assert.equal(moved.version, 3);
  const removed = await post(`/api/boards/${id}/remove-elements`, { origin: "ui", toolCallId: "test-remove", elementIds: ["e-3"] });
  assert.equal(removed.version, 4);
  const undone = await post(`/api/boards/${id}/undo`, { origin: "ui", toolCallId: "test-undo" });
  assert.equal(undone.version, 3);
  assert.equal(undone.canRedo, true);
  const redone = await post(`/api/boards/${id}/redo`, { origin: "ui", toolCallId: "test-redo" });
  assert.equal(redone.version, 4);
  assert.equal(redone.canUndo, true);
  await post(`/api/boards/${id}/undo`, { origin: "ui", toolCallId: "test-branch-undo" });
  await post(`/api/boards/${id}/elements`, { origin: "mcp", toolCallId: "test-branch-add", elements: [{ type: "text", x: 500, y: 500, text: "branch" }] });
  const noRedo = await fetch(`${base}/api/boards/${id}/redo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "ui", toolCallId: "test-no-redo" }) });
  assert.equal(noRedo.status, 409);
  const restored = await post(`/api/boards/${id}/restore-version`, { origin: "ui", toolCallId: "test-restore", version: 1 });
  assert.equal(restored.restoredVersion, 1);
  assert.equal(restored.version, 5);
  const recovered = await request(`/api/boards/${id}/state`);
  assert.equal(recovered.elements.length, 4);
  assert.equal(recovered.elements.find(element => element.id === "e-2").x, 60);
});

test("served UI exposes collaboration controls and canvas capture route", async () => {
  const created = await post("/api/boards", { origin: "mcp", toolCallId: "test-ui", width: 640, height: 400 });
  const html = await request(`/boards/${created.boardId}`, { expectText: true });
  for (const marker of ["zoom-in", "select-mode", "data-create", "addHumanElement", "show-drawings", "show-human", "show-agent", "undo", "redo", "Deshaciendo", "historyCursor", "canvas-capture", "connection-alert", "connectionFailure", "Conexión perdida", "No cierres la pestaña", "delete-dialog", "delete-confirm", "delete-cancel"]) assert.match(html, new RegExp(marker.replace("-", "\\-")));
});

after(async () => { await closeBoardServer(); rmSync(dataDir, { recursive: true, force: true }); });
