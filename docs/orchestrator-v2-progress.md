# Orchestrator V2 implementation progress

Updated: 2026-07-16

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

Release candidate hardening: Codex app-server and Kimi ACP native handshakes,
Claude SDK checkpoints, explicit interrupted-Meeting recovery, packaged ASR
cross-origin isolation, and final DMG verification.

## Verification log

- Renderer TypeScript: pass
- Electron TypeScript: pass
- Production build: pass
- Node tests: 105/105 pass
- Packaged Codex runtime resolver regression: pass
- MeetingCommand authorization regression: pass
- Workspace isolation tests: Git worktree + non-Git path lock pass
- Production dependency audit: 0 vulnerabilities
- Codex app-server 0.144.1 OAuth/account handshake: pass
- Kimi ACP 0.24.1 initialize/auth/session handshake: pass
- Claude CLI auth preflight: correctly gated (`loggedIn=false` on this machine)
- Final packaged app startup smoke: pass
- DMG checksum verification: pass
- Packaged app 10-second startup smoke: pass
- DMG: superseded; 0.16.0 artifact and checksum are recorded after the final build

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
- Packaged renderer is served from a privileged, path-confined `app://bundle`
  protocol; real Electron inspection reports `crossOriginIsolated=true` and
  `SharedArrayBuffer` available for ONNX/VAD.
- Codex Coordinator uses app-server `initialize/account/read/thread/*/turn/*`
  instead of a paid `Ready` prompt; real OAuth handshake returns a native
  `codex-app-server` thread checkpoint.
- Kimi Expert uses ACP initialize/auth/session/resume/prompt/cancel in enforced
  plan mode; the canonical `~/.kimi-code/bin/kimi` runtime wins over PATH
  wrappers. Compatibility stream-json remains test-only/fallback.
- Claude Agent SDK is exactly pinned at `0.3.150`; native session IDs are
  snapshotted and `resume` is wired through the unified Backend adapter.
- Lobby exposes explicit recovery confirmation. Restored running tasks are
  projected as `interrupted` and never auto-replayed. Per-task actions let the
  user explicitly continue, retry, complete, or abandon; side-effecting restarts
  require confirmation. Journal sequence numbers continue across recovery.
- Codex and Kimi native transports reject runtime versions that do not match
  their locked protocol contract and persist protocol/backend versions in Host
  checkpoints. Kimi auth status includes a real ACP session handshake.
- Kimi ACP workspace reads resolve symlinks before enforcing the workspace
  boundary, and first-turn system instructions also apply to multimodal input.
- Packaged Whisper points `GGML_BACKEND_PATH` at its bundled baseline Apple
  Silicon CPU plugin and refreshes the complete native dependency closure on every macOS build;
  a synthesized Mandarin clip transcribed as “你好，今天我们测试语音识别。”.
- Removed vulnerable XLSX/PPTX in-process preview dependencies; system-open fallback remains.

## Formal release checks still open

The current artifact is an unsigned experience build, not a formal release. The
plan's release gate still requires installed-app manual E2E for the complete
Claude/Codex bidirectional Coordinator and failover matrix, a real two-hour
2-Host/4-Worker soak, and Apple signing/notarization. These are intentionally
not reported as passed by the automated smoke checks above.
