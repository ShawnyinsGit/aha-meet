// SessionRegistry — owns the per-cwd virtual meeting slots that back the
// tabbed UI. Each slot owns exactly one Orchestrator (= one Talker + scheduler
// of Workers). cwd is the natural primary key: a single cwd cannot back two
// concurrent meetings — `findByCwd` is the gate.
//
// The registry deliberately does NOT spawn orchestrators on its own. Callers
// (the sessions:open IPC handler) construct the Orchestrator and hand it in;
// the registry only tracks lifecycle, active selection, and ordering. This
// keeps Electron-side wiring (emit closure that needs to know sessionId before
// it can capture itself) flexible.
//
// `activeId` follows the user's tab focus. Most IPC handlers accept an
// explicit sessionId in the payload; when one is missing, the handler falls
// back to `getActive()`. That fallback is the compatibility seam for any
// legacy callsite (eg. global hotkeys) that doesn't know about tabs.

import type { Orchestrator } from './orchestrator.js';

export interface SessionSlot {
  id: string;
  cwd: string;
  orchestrator: Orchestrator;
  recapPending: boolean;
  openedAt: number;
  lastActivityAt: number;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  openedAt: number;
  lastActivityAt: number;
}

export type OpenResult =
  | { kind: 'opened'; slot: SessionSlot }
  | { kind: 'duplicate'; existingId: string };

export class SessionRegistry {
  private sessions = new Map<string, SessionSlot>();
  private activeId: string | null = null;

  /** Insert a fully-constructed orchestrator under a new sessionId. The caller
   *  is responsible for picking the id (so it can pre-bind it into the
   *  orchestrator's emit closure) and for actually starting the orchestrator.
   *  If `cwd` already maps to a live slot, returns `{kind:'duplicate'}` and
   *  does not insert — caller is expected to discard the orchestrator it built
   *  for the duplicate (or, better, check `findByCwd` first to avoid building
   *  it at all). */
  open(id: string, cwd: string, orchestrator: Orchestrator): OpenResult {
    const existing = this.findByCwd(cwd);
    if (existing) return { kind: 'duplicate', existingId: existing.id };

    const now = Date.now();
    const slot: SessionSlot = {
      id,
      cwd,
      orchestrator,
      recapPending: false,
      openedAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(id, slot);
    if (this.activeId === null) this.activeId = id;
    return { kind: 'opened', slot };
  }

  /** Remove a slot. Caller is responsible for calling orchestrator.end()
   *  beforehand if it wants graceful shutdown (the IPC layer does this). If
   *  the removed slot was active, picks any remaining slot as the new active,
   *  preferring the most-recently-used. Returns true if a slot was removed. */
  close(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    if (this.activeId === id) {
      const next = this.mostRecent();
      this.activeId = next ? next.id : null;
    }
    return true;
  }

  setActive(id: string): boolean {
    const slot = this.sessions.get(id);
    if (!slot) return false;
    this.activeId = id;
    slot.lastActivityAt = Date.now();
    return true;
  }

  getActive(): SessionSlot | null {
    if (!this.activeId) return null;
    return this.sessions.get(this.activeId) ?? null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  get(id: string): SessionSlot | null {
    return this.sessions.get(id) ?? null;
  }

  /** Resolve a slot from an explicit sessionId, or fall back to active when
   *  the caller didn't supply one. Used by IPC handlers to support both
   *  tab-bound calls (renderer passes id) and legacy calls (no id). */
  resolve(id?: string | null): SessionSlot | null {
    if (id) return this.get(id);
    return this.getActive();
  }

  list(): SessionMeta[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      openedAt: s.openedAt,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  findByCwd(cwd: string): SessionSlot | null {
    for (const s of this.sessions.values()) {
      if (s.cwd === cwd) return s;
    }
    return null;
  }

  size(): number {
    return this.sessions.size;
  }

  values(): IterableIterator<SessionSlot> {
    return this.sessions.values();
  }

  touch(id: string): void {
    const slot = this.sessions.get(id);
    if (slot) slot.lastActivityAt = Date.now();
  }

  private mostRecent(): SessionSlot | null {
    let best: SessionSlot | null = null;
    for (const s of this.sessions.values()) {
      if (!best || s.lastActivityAt > best.lastActivityAt) best = s;
    }
    return best;
  }
}
