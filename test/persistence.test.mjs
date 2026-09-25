import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), "vcb-persist-"));
const port = "4226";
const childScript = `
  const { ensureBoardServer, closeBoardServer } = await import(${JSON.stringify(process.cwd() + "/src/server.mjs")});
  await ensureBoardServer();
  const base = ${JSON.stringify(`http://127.0.0.1:${port}`)};
  const response = await fetch(base + "/api/boards");
  const value = await response.json();
  if (process.argv[1] === "create") {
    const created = await (await fetch(base + "/api/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "mcp", toolCallId: "persistence" }) })).json();
    await fetch(base + "/api/boards/" + created.boardId + "/human-paths", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ points: [[10, 10], [20, 20]] }) });
    console.log(created.boardId);
  } else console.log(JSON.stringify(value));
  await closeBoardServer();
`;

test("boards survive an HTTP server restart through VCB_DATA_DIR", async () => {
  const env = { ...process.env, VCB_PORT: port, VCB_DATA_DIR: dataDir };
  const created = await run(process.execPath, ["--input-type=module", "-e", childScript, "create"], { env });
  const boardId = created.stdout.trim();
  assert.match(boardId, /^board-/);
  const restarted = await run(process.execPath, ["--input-type=module", "-e", childScript, "list"], { env });
  const boards = JSON.parse(restarted.stdout.trim());
  assert.equal(boards.boards.some(board => board.boardId === boardId && board.version === 1), true);
  rmSync(dataDir, { recursive: true, force: true });
});
