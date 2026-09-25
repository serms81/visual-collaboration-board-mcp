import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderPng } from "../src/png.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "vcb-contract-"));
process.env.VCB_PORT = "4223";
process.env.VCB_DATA_DIR = dataDir;
const { ensureBoardServer, closeBoardServer } = await import("../src/server.mjs");
await ensureBoardServer();
const base = "http://127.0.0.1:4223";
const json = async (path, options = {}) => { const response = await fetch(`${base}${path}`, options); const value = await response.json(); return { response, value }; };
const ok = async (path, options = {}) => { const { response, value } = await json(path, options); assert.equal(response.ok, true, `${path}: ${JSON.stringify(value)}`); return value; };
const post = (path, body) => ok(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("capture, history, overlays, listings and model representations", async () => {
  const created = await post("/api/boards", { origin: "mcp", toolCallId: "contract-create", width: 640, height: 400 });
  const id = created.boardId;
  const listed = await ok("/api/boards");
  assert.equal(listed.boards.some(board => board.boardId === id && board.width === 640), true);
  const png = renderPng({ width: 640, height: 400, paths: [], elements: [], overlays: [] });
  const capture = await ok(`/api/boards/${id}/canvas-capture`, { method: "POST", headers: { "content-type": "image/png", "x-board-version": "0", "x-browser-epoch-ms": String(Date.now()) }, body: png });
  assert.equal(capture.version, 0);
  const served = await fetch(`${base}/api/boards/${id}/capture`);
  assert.equal(served.headers.get("x-capture-source"), "browser-canvas");
  assert.equal(served.headers.get("x-capture-width"), "640");
  const overlay = await post(`/api/boards/${id}/overlays`, { origin: "mcp", toolCallId: "contract-overlay", source: "current-capture", fit: "native" });
  assert.equal(overlay.version, 1);
  const stale = await json(`/api/boards/${id}/capture`);
  assert.equal(stale.response.status, 409);
  const overlayImage = await fetch(`${base}/api/boards/${id}/overlays/${overlay.overlayId}/image`);
  assert.equal(overlayImage.headers.get("content-type"), "image/png");
  const history = await ok(`/api/boards/${id}/history`);
  assert.deepEqual(history.versions, [0, 1]);
  const versionZero = await ok(`/api/boards/${id}/versions/0`);
  assert.equal(versionZero.id, id);
  const modelCapture = await fetch(`${base}/api/boards/${id}/model-capture`);
  assert.equal(modelCapture.headers.get("x-capture-source"), "server-model");
  const removed = await fetch(`${base}/api/boards/${id}/overlays/${overlay.overlayId}`, { method: "DELETE" });
  assert.equal(removed.ok, true);
});

test("human paths reject MCP deletion until force is explicit and remain undoable", async () => {
  const created = await post("/api/boards", { origin: "mcp", toolCallId: "human-lock-create", width: 640, height: 400 });
  const id = created.boardId;
  const human = await post(`/api/boards/${id}/human-paths`, { points: [[20, 20], [120, 80]] });
  assert.equal(human.version, 1);
  const blocked = await json(`/api/boards/${id}/remove-human-paths`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId: "human-lock-blocked", pathIds: [human.id] }) });
  assert.equal(blocked.response.status, 423);
  assert.equal(blocked.value.error, "HUMAN_CONTENT_LOCKED");
  const removed = await ok(`/api/boards/${id}/remove-human-paths`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId: "human-lock-force", pathIds: [human.id], force: true }) });
  assert.deepEqual(removed.removed, [human.id]);
  const undone = await ok(`/api/boards/${id}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "ui", toolCallId: "human-lock-undo" }) });
  assert.equal(undone.version, 1);
  const state = await ok(`/api/boards/${id}/state`);
  assert.equal(state.paths.some(path => path.id === human.id), true);
});

test("agent group identities persist in every path version", async () => {
  const { boardId } = await post("/api/boards", { origin: "mcp", toolCallId: "groups-create" });
  const result = await post(`/api/boards/${boardId}/agent-groups`, { origin: "mcp", toolCallId: "groups-add", groups: [
    { name: "First", paths: [{ points: [[10, 10], [20, 20]] }, { points: [[30, 30], [40, 40]] }] },
    { name: "Second", paths: [{ points: [[50, 50], [60, 60]] }] }
  ] });
  assert.equal(result.version, 3);
  assert.deepEqual(result.groups.map(group => group.pathIds), [["a-1", "a-2"], ["a-3"]]);
  const first = await ok(`/api/boards/${boardId}/versions/1`);
  assert.deepEqual(first.groups.map(group => group.pathIds), [["a-1"]]);
  const second = await ok(`/api/boards/${boardId}/versions/2`);
  assert.deepEqual(second.groups.map(group => group.pathIds), [["a-1", "a-2"]]);
  const third = await ok(`/api/boards/${boardId}/versions/3`);
  assert.deepEqual(third.groups.map(group => group.pathIds), [["a-1", "a-2"], ["a-3"]]);
  const persisted = JSON.parse(readFileSync(join(dataDir, "boards", `${boardId}.json`), "utf8"));
  assert.deepEqual(persisted.groups.map(group => group.pathIds), [["a-1", "a-2"], ["a-3"]]);

  const legacy = { ...persisted, groups: persisted.groups.slice(0, 1) };
  writeFileSync(join(dataDir, "boards", `${boardId}.json`), JSON.stringify(legacy));
  writeFileSync(join(dataDir, "states", `${boardId}-v3.json`), JSON.stringify(legacy));
  const recoveredVersion = await ok(`/api/boards/${boardId}/versions/3`);
  assert.deepEqual(recoveredVersion.groups.map(group => group.pathIds), [["a-1", "a-2"], ["a-3"]]);
  const script = `const { ensureBoardServer, closeBoardServer } = await import(${JSON.stringify(new URL("../src/server.mjs", import.meta.url).href)}); await ensureBoardServer(); const response = await fetch("http://127.0.0.1:4227/api/boards/${boardId}/structure"); const value = await response.json(); console.log(JSON.stringify(value.groups.map(group => group.pathIds))); await closeBoardServer();`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, VCB_PORT: "4227", VCB_DATA_DIR: dataDir }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1)), [["a-1", "a-2"], ["a-3"]]);
});

after(async () => { await closeBoardServer(); rmSync(dataDir, { recursive: true, force: true }); });
