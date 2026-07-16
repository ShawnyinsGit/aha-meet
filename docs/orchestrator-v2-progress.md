# Orchestrator V2 implementation progress

Updated: 2026-07-13

## Status

- [x] A. Backend runtime/session foundation
- [x] B. Meeting and Coordinator domain core
- [x] C. MeetingCommand and global Scheduler
- [x] D. Workspace isolation and recovery
- [x] E. Multi-host collaboration and failover UI
- [x] F. IPC/browser/ASR/security hardening
- [x] G. Unsigned experience DMG build and automated verification
- [ ] H. Formal release gate: full installed-app manual matrix, 2-hour soak, signing and notarization

## Current slice

Packaged Codex runtime: resolve a real executable outside ASAR, preserve the real HOME/OAuth environment, use backend-specific models, report readiness only after a real handshake, and make turn interruption recoverable.

## Verification log

- Renderer TypeScript: pass
- Electron TypeScript: pass
- Production build: pass
- Node tests: 38/38 pass
- Packaged Codex runtime resolver regression: pass
- MeetingCommand authorization regression: pass
- Workspace isolation tests: Git worktree + non-Git path lock pass
- Production dependency audit: 0 vulnerabilities
- Final packaged Codex 0.144.1 OAuth handshake with gpt-5.4: pass
- Final packaged app startup smoke: pass
- DMG checksum verification: pass
- Packaged app 10-second startup smoke: pass
- DMG: `release/AhaMeet-0.15.1-arm64.dmg`
- SHA-256: `7e52ef9e1f987cfa07185f0f397dec7a73d3d206d6648498c766580884e7100c`

## Implemented

- Packaged Codex resolves and passes a real `app.asar.unpacked` executable.
- Backend-specific environment/auth construction; non-Claude CLIs keep real HOME.
- Backend-specific model selection.
- Codex real async startup handshake and abortable turns.
- Single `coordinatorHostId`, transfer IPC/UI, expert role enforcement.
- Added-host failure no longer ends the whole renderer Meeting.
- One authoritative Meeting Scheduler with per-task executor Backend selection.
- Internal expert request/reply tools.
- Adapter-independent expert response forwarding for Kimi/Qoder-style backends without MCP command support.
- Append-only Meeting event journal and terminal snapshot.
- ASR payload limits and embedded browser permission/navigation/bounds hardening.
- Coordinator failover prompt, Host reconnect, interrupted-task recovery snapshots.
- Git worktree isolation and non-Git declared path locks.
- Non-Git overlapping path locks now serialize pending tasks instead of failing them.
- Codex `meeting-command` frames are consumed at the Adapter boundary; `speak` no longer duplicates or leaks JSON into chat.
- First-window macOS microphone consent and denied-state native recovery dialog are covered by regression tests.
- Removed vulnerable XLSX/PPTX in-process preview dependencies; system-open fallback remains.

## Formal release checks still open

The current artifact is an unsigned experience build, not a formal release. The
plan's release gate still requires installed-app manual E2E for the complete
Claude/Codex bidirectional Coordinator and failover matrix, a real two-hour
2-Host/4-Worker soak, and Apple signing/notarization. These are intentionally
not reported as passed by the automated smoke checks above.

## Known pre-existing working-tree changes

- `package-lock.json`
- `AGENTS.md`
- `icon.png`
- `src/components/JoinScreen.tsx`
- `src/components/PlanMeetingModal.tsx`

These are treated as user-owned and must not be overwritten.
