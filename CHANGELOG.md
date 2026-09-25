# Changelog

## 0.13.6 — 2026-09-25

- Fixed semantic group persistence so every saved path version includes its group and current member IDs.
- Reconstructed missing group records from path metadata when reading older snapshots, without rewriting historical files on read.
- Added regression coverage for intermediate versions, the final snapshot, and loading an older snapshot.

## 0.13.5 — 2026-09-25

- Documented numeric board coordinates in the MCP tool descriptions, input schema and README.
- Clarified the top-left origin, board bounds and browser zoom behavior without changing stored geometry.

## 0.13.4 — 2026-09-25

- First distribution snapshot separated from the private product and research repository.
- Includes the local MCP server, browser UI, persistence, history, rich elements, resources, capture and test suite.
- Verified locally on macOS with Node.js 24.
