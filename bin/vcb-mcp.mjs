#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VCB_DATA_DIR ??= mkdtempSync(join(tmpdir(), "vcb-"));
await import("../src/mcp-server.mjs");
