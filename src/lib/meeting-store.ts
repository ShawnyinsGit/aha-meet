import type {
  ActivityEntry,
  AgentSource,
  AttachmentMeta,
  MeetingPlan,
  OpenTabMeta,
  PendingPermission,
  RecentCwdMeta,
  RendererEvent,
  StagedAttachment,
  TranscriptEntry,
  WorkerDeliveryFile,
  WorkerSpecialty,
  WorkerStatus,
  WorkerTaskHistoryEntry,
} from '../types';
import { MEETING_TOOL_NAMES } from '../../electron/meeting-tools';
import { extractText, extractToolUses, uid } from './sdk-message';

const MAX_TRANSCRIPT = 500;
const MAX_ACTIVITY = 500;

const DEFAULT_GREETING = "You're joining a live screen-share meeting with your developer. Greet them in one or two sentences, ask what they want to work on today, and remind them they can share the current screen with the snapshot button when something needs your eyes. Keep it warm and short.";

function appendCapped<T>(arr: T[], items: T[], max: number): T[] {
  if (items.length === 0) return arr;
  if (arr.length + items.length > max) {
    return arr.slice(arr.length + items.length - max).concat(items);
  }
  return arr.concat(items);
}

export interface WorkerState {
  id: AgentSource;
  title: string;
  role: 'talker' | 'worker';
  status: 'idle' | WorkerStatus;
  deps: string[];
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pendingPermission: PendingPermission | null;
  currentTool: string | null;
  currentToolInput: string | null;
  lastText: string;
  endedAt: number | null;
  summary: string;
  specialty: WorkerSpecialty;
  startedAt: number | null;
  taskHistory: WorkerTaskHistoryEntry[];
}

/** Snapshot of one worker's delivered artifacts, displayed in the ScreenStage
 *  "delivery acceptance" panel. Pushed by a `worker-delivery` event from main
 *  when the worker calls `task_done`. Cleared by the user accepting or by a
 *  new delivery from any worker (only the most recent delivery is staged). */
export interface DeliverySnapshot {
  workerId: AgentSource;
  title: string;
  summary: string;
  taskId: string;
  files: WorkerDeliveryFile[];
  receivedAt: number;
}

export interface MeetingState {
  workers: Map<AgentSource, WorkerState>;
  plan: MeetingPlan | null;
  running: boolean;
  lastError: string | null;
  /** Most recent delivery awaiting user acceptance. Null when nothing is
   *  staged. Replaced (not queued) when another worker finishes — pick the
   *  freshest one. */
  currentDelivery: DeliverySnapshot | null;
}

/** Tab metadata projected from each slot. Drives the TabStrip rendering. */
export interface TabMeta {
  id: string;
  cwd: string;
  /** placeholder = restored from settings but Orchestrator not yet spawned.
   *  Clicking the tab calls resumePlaceholder() which kicks off sessions:open. */
  placeholder: boolean;
  status: 'idle' | 'running' | 'error';
  unreadCount: number;
  isActive: boolean;
  openedAt: number;
}

/** Returned by getLobbyData() so the Lobby can render Active + Recent without
 *  reaching into store internals. */
export interface LobbyData {
  active: TabMeta[];
  recent: RecentCwdMeta[];
}

interface SlotInternal {
  id: string;                              // sessionId for live slots; `placeholder:<cwd>` for restored-but-not-yet-spawned
  cwd: string;
  placeholder: boolean;
  openedAt: number;
  state: MeetingState;
  unreadCount: number;
  // Per-slot scratch
  lastSpoken: string;
  endedSources: Set<AgentSource>;
  intendedExit: boolean;
  greeting: string | undefined;
  /** Flips to true once the on-disk transcript has been spliced in. Until
   *  then, append-persist is suppressed so the load doesn't immediately echo
   *  every restored entry back to disk (it's already there). */
  historyLoaded: boolean;
  /** B3 — talker text that arrived while this slot was NOT active. Replayed
   *  to speakCallback on setActive() if still fresh, so the user doesn't lose
   *  a narration just because they were focused elsewhere when it landed.
   *  Single-entry latching (most recent wins) keeps a long-ignored tab from
   *  dumping a backlog when the user finally clicks in. */
  pendingSpeak: { text: string; ts: number } | null;
}

/** B3 — drop a pending replay older than this so a long-backgrounded tab
 *  doesn't blast a stale reply at the user when they switch in. */
const PENDING_SPEAK_TTL_MS = 30_000;

type Listener = () => void;

function createTalkerState(): WorkerState {
  return {
    id: 'talker',
    title: 'Talker',
    role: 'talker',
    status: 'idle',
    deps: [],
    transcript: [],
    activity: [],
    pendingPermission: null,
    currentTool: null,
    currentToolInput: null,
    lastText: '',
    endedAt: null,
    summary: '',
    specialty: 'general',
    startedAt: null,
    taskHistory: [],
  };
}

function emptyState(): MeetingState {
  const workers = new Map<AgentSource, WorkerState>();
  workers.set('talker', createTalkerState());
  return {
    workers,
    plan: null,
    running: false,
    lastError: null,
    currentDelivery: null,
  };
}

function emptySlot(id: string, cwd: string): SlotInternal {
  return {
    id,
    cwd,
    placeholder: false,
    openedAt: Date.now(),
    state: emptyState(),
    unreadCount: 0,
    lastSpoken: '',
    endedSources: new Set(),
    intendedExit: false,
    greeting: undefined,
    historyLoaded: false,
    pendingSpeak: null,
  };
}

const PLACEHOLDER_PREFIX = 'placeholder:';
function placeholderId(cwd: string): string {
  return `${PLACEHOLDER_PREFIX}${cwd}`;
}

class MeetingStore {
  private slots = new Map<string, SlotInternal>();
  private activeId: string | null = null;
  private recentCwds: RecentCwdMeta[] = [];
  private restoreHydrated = false;
  /** Sticky empty state returned by getSnapshot() when no slot is active.
   *  Held as a stable reference so useSyncExternalStore's identity check
   *  doesn't fire spurious renders. */
  private readonly EMPTY: MeetingState = emptyState();
  /** Cached tab projection. Recomputed on demand and invalidated on every
   *  slot mutation. Required so useSyncExternalStore receives a stable
   *  reference across renders — otherwise React tear-loops. */
  private cachedTabs: TabMeta[] | null = null;
  /** activeCwd cache uses a separate "fresh" flag because null is a valid value
   *  (no active slot). */
  private cachedActiveCwd: string | null = null;
  private cachedActiveCwdFresh = false;
  /** Lobby projection cache. Invalidated whenever tabs or recents change. */
  private cachedLobbyData: LobbyData | null = null;

  private listeners = new Set<Listener>();
  private tabListeners = new Set<Listener>();
  private speakCallback: ((text: string) => void) | null = null;
  private subscribed = false;
  private unsubscribeEvents: (() => void) | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.ensureSubscribed();
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): MeetingState => {
    const slot = this.activeId ? this.slots.get(this.activeId) : null;
    return slot ? slot.state : this.EMPTY;
  };

  subscribeTabs = (listener: Listener): (() => void) => {
    this.tabListeners.add(listener);
    this.ensureSubscribed();
    return () => { this.tabListeners.delete(listener); };
  };

  getTabs = (): TabMeta[] => {
    if (this.cachedTabs) return this.cachedTabs;
    const tabs: TabMeta[] = [];
    for (const slot of this.slots.values()) {
      tabs.push({
        id: slot.id,
        cwd: slot.cwd,
        placeholder: slot.placeholder,
        status: slot.placeholder
          ? 'idle'
          : slot.state.lastError
            ? 'error'
            : slot.state.running
              ? 'running'
              : 'idle',
        unreadCount: slot.unreadCount,
        isActive: slot.id === this.activeId,
        openedAt: slot.openedAt,
      });
    }
    // Stable order: by openedAt ascending so tabs don't reshuffle on focus.
    tabs.sort((a, b) => a.openedAt - b.openedAt);
    this.cachedTabs = tabs;
    return tabs;
  };

  getActiveId = (): string | null => this.activeId;

  getActiveCwd = (): string | null => {
    // Cached so useSyncExternalStore sees a stable reference across renders
    // until something actually changes (invalidated in invalidateTabCache()).
    if (this.cachedActiveCwdFresh) return this.cachedActiveCwd;
    const slot = this.activeId ? this.slots.get(this.activeId) : null;
    this.cachedActiveCwd = slot ? slot.cwd : null;
    this.cachedActiveCwdFresh = true;
    return this.cachedActiveCwd;
  };

  private invalidateTabCache() {
    this.cachedTabs = null;
    this.cachedActiveCwdFresh = false;
    this.cachedLobbyData = null;
  }

  /** Returns whichever sessionId we should pass to main for active-tab calls.
   *  Placeholder slots have no Orchestrator yet, so we never forward their id. */
  private effectiveSessionId(): string | null {
    if (!this.activeId) return null;
    const slot = this.slots.get(this.activeId);
    if (!slot || slot.placeholder) return null;
    return slot.id;
  }

  getLobbyData = (): LobbyData => {
    if (this.cachedLobbyData) return this.cachedLobbyData;
    this.cachedLobbyData = {
      active: this.getTabs(),
      recent: this.recentCwds,
    };
    return this.cachedLobbyData;
  };

  setSpeakCallback(cb: ((text: string) => void) | null) {
    this.speakCallback = cb;
  }

  private ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.unsubscribeEvents = window.vibeMeet.onEvent((e) => this.handleIncomingEvent(e));
  }

  /** B4 — explicit teardown for the IPC event subscription. The singleton
   *  normally holds this for the whole renderer lifetime (which is fine —
   *  one listener, no accumulation), but tests and secondary renderers can
   *  call dispose() to detach cleanly. */
  dispose(): void {
    if (this.unsubscribeEvents) {
      try { this.unsubscribeEvents(); } catch (err) {
        console.warn('[meeting-store] unsubscribeEvents threw', err);
      }
      this.unsubscribeEvents = null;
    }
    this.subscribed = false;
  }

  private notify(slotId: string) {
    this.invalidateTabCache();
    if (slotId === this.activeId) {
      for (const l of this.listeners) l();
    }
    // Tab status / unread badge can change for any slot, so always nudge tab
    // listeners. Cheap (just badges).
    for (const l of this.tabListeners) l();
  }

  private notifyTabsOnly() {
    this.invalidateTabCache();
    for (const l of this.tabListeners) l();
  }

  private mutateSlot(slotId: string, updater: (s: MeetingState) => MeetingState) {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    slot.state = updater(slot.state);
    this.notify(slotId);
  }

  // --- Transcript persistence ----------------------------------------------

  /** Mirror a newly-appended talker transcript entry to the on-disk JSONL.
   *  Suppressed before historyLoaded flips so the freshly-loaded restore
   *  doesn't double-write. Placeholder slots have no live session and never
   *  emit entries, but we still guard defensively. */
  private persistTalkerEntry(slot: SlotInternal, entry: TranscriptEntry): void {
    if (!slot.historyLoaded || slot.placeholder) return;
    void window.vibeMeet.transcripts.append(slot.cwd, entry).catch(() => {
      /* fire-and-forget — transient FS hiccup shouldn't disrupt the UI */
    });
  }

  /** Splice restored entries into the slot's talker transcript on first
   *  open / placeholder promotion. Always sets historyLoaded=true (even on
   *  error) so subsequent appends start persisting. */
  private async loadHistoryForSlot(slot: SlotInternal): Promise<void> {
    try {
      const r = await window.vibeMeet.transcripts.load(slot.cwd);
      if (r.ok && r.entries.length > 0) {
        const restored = r.entries.slice(-MAX_TRANSCRIPT);
        this.mutateSlot(slot.id, (s) => {
          const workers = new Map(s.workers);
          const talker = workers.get('talker') ?? createTalkerState();
          // Prepend restored; the slot is fresh so existing transcript is
          // typically empty, but if any events landed between slot insert
          // and load resolve we keep them after the restored history.
          const merged = [...restored, ...talker.transcript].slice(-MAX_TRANSCRIPT);
          workers.set('talker', { ...talker, transcript: merged });
          return { ...s, workers };
        });
      } else if (!r.ok) {
        console.warn('[meeting-store] transcript load failed:', r.error);
      }
    } catch (err) {
      console.warn('[meeting-store] transcript load threw:', err);
    } finally {
      slot.historyLoaded = true;
    }
  }

  // --- Slot lifecycle -------------------------------------------------------

  async hydrateRestore(): Promise<void> {
    if (this.restoreHydrated) return;
    this.restoreHydrated = true;
    try {
      const res = await window.vibeMeet.sessions.listRestore();
      if (!res.ok) return;
      this.recentCwds = res.recentCwds ?? [];
      const tabs: OpenTabMeta[] = res.openTabs ?? [];
      for (const t of tabs) {
        if (this.findByCwd(t.cwd)) continue;
        const slot: SlotInternal = {
          ...emptySlot(placeholderId(t.cwd), t.cwd),
          placeholder: true,
          openedAt: t.openedAt,
        };
        this.slots.set(slot.id, slot);
      }
      // Pick an initial active placeholder so the UI knows which tab is
      // selected on cold start — even though no Orchestrator is spawned yet.
      if (!this.activeId && res.lastActiveCwd) {
        const target = this.findByCwd(res.lastActiveCwd);
        if (target) this.activeId = target.id;
      }
      if (!this.activeId) {
        const first = [...this.slots.values()][0];
        if (first) this.activeId = first.id;
      }
      this.notifyTabsOnly();
    } catch (err) {
      console.error('[meeting-store] hydrateRestore failed', err);
    }
  }

  private findByCwd(cwd: string): SlotInternal | null {
    for (const s of this.slots.values()) {
      if (s.cwd === cwd) return s;
    }
    return null;
  }

  async openSession(cwd: string, greeting?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    // Default greeting kicks the Talker into speaking on session start so the
    // user gets an immediate "hello, what should we work on?" instead of a
    // dead-air tab. Without this the SDK input loop sits idle.
    const effectiveGreeting = greeting ?? DEFAULT_GREETING;
    // If a placeholder already exists for this cwd, resume it instead of
    // creating a second tab. Mirrors main-side cwd uniqueness.
    const existing = this.findByCwd(cwd);
    if (existing && existing.placeholder) {
      return this.resumePlaceholder(existing.id, effectiveGreeting);
    }
    if (existing && !existing.placeholder) {
      // Already open — just focus it. Matches main-side duplicate handling.
      await this.setActive(existing.id);
      return { ok: true, sessionId: existing.id };
    }
    const res = await window.vibeMeet.sessions.open(cwd, effectiveGreeting);
    if (!res.ok) {
      if (res.error === 'duplicate' && 'sessionId' in res && res.sessionId) {
        await this.setActive(res.sessionId);
        return { ok: true, sessionId: res.sessionId };
      }
      return { ok: false, error: res.error };
    }
    const slot = emptySlot(res.sessionId, res.cwd);
    slot.greeting = effectiveGreeting;
    slot.state = { ...slot.state, running: true };
    this.slots.set(res.sessionId, slot);
    this.activeId = res.sessionId;
    // Update local recents optimistically so the Lobby reflects the new pick
    // even before next listRestore. Main writes the canonical copy.
    this.recentCwds = [
      { path: res.cwd, lastOpenedAt: Date.now() },
      ...this.recentCwds.filter((r) => r.path !== res.cwd),
    ].slice(0, 10);
    this.notifyTabsOnly();
    this.notify(res.sessionId);
    void this.loadHistoryForSlot(slot);
    return { ok: true, sessionId: res.sessionId };
  }

  async resumePlaceholder(placeholderSlotId: string, greeting?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const ph = this.slots.get(placeholderSlotId);
    if (!ph || !ph.placeholder) return { ok: false, error: 'not-placeholder' };
    const effectiveGreeting = greeting ?? DEFAULT_GREETING;
    const res = await window.vibeMeet.sessions.open(ph.cwd, effectiveGreeting);
    if (!res.ok) {
      if (res.error === 'duplicate' && 'sessionId' in res && res.sessionId) {
        // Race: another tab already opened it. Drop our placeholder and focus
        // the winner.
        this.slots.delete(placeholderSlotId);
        this.activeId = res.sessionId;
        this.notifyTabsOnly();
        return { ok: true, sessionId: res.sessionId };
      }
      return { ok: false, error: res.error };
    }
    // Promote placeholder → live slot. Preserve openedAt so tab position is
    // stable across the resume.
    const promoted = emptySlot(res.sessionId, res.cwd);
    promoted.openedAt = ph.openedAt;
    promoted.greeting = effectiveGreeting;
    promoted.state = { ...promoted.state, running: true };
    this.slots.delete(placeholderSlotId);
    this.slots.set(res.sessionId, promoted);
    this.activeId = res.sessionId;
    this.notifyTabsOnly();
    this.notify(res.sessionId);
    void this.loadHistoryForSlot(promoted);
    return { ok: true, sessionId: res.sessionId };
  }

  async setActive(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    // Switch main first, then flip local activeId. If we set activeId
    // synchronously and then await the IPC, any event main emits between the
    // local switch and the main-process switch lands in the wrong slot
    // (renderer's activeId already pointing at the new id while main still
    // routes its events to the old one, or vice-versa). Bail without
    // switching when the IPC fails so we don't desync.
    if (!slot.placeholder) {
      try {
        const res = await window.vibeMeet.sessions.setActive(id);
        if (!res || res.ok === false) {
          console.warn('[meeting-store] setActive IPC failed, not switching local active', { id, res });
          return;
        }
      } catch (err) {
        console.warn('[meeting-store] setActive IPC threw, not switching local active', { id, err });
        return;
      }
    }
    this.activeId = id;
    slot.unreadCount = 0;
    // B3: replay the freshest backgrounded talker text on switch-in so the
    // user hears what landed while focused elsewhere. Stale (>TTL) replays
    // are dropped to avoid an avalanche when re-opening an idle tab.
    const pending = slot.pendingSpeak;
    slot.pendingSpeak = null;
    if (
      pending &&
      Date.now() - pending.ts <= PENDING_SPEAK_TTL_MS &&
      pending.text !== slot.lastSpoken &&
      this.speakCallback
    ) {
      slot.lastSpoken = pending.text;
      try { this.speakCallback(pending.text); } catch (err) {
        console.warn('[meeting-store] pendingSpeak replay threw', err);
      }
    }
    this.notifyTabsOnly();
    this.notify(id);
  }

  async closeTab(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (!slot.placeholder) {
      try { await window.vibeMeet.sessions.close(id); } catch (err) {
        console.warn('[meeting-store] sessions.close (closeTab) failed', { id, err });
      }
    }
    this.slots.delete(id);
    if (this.activeId === id) {
      const next = [...this.slots.values()].sort((a, b) => b.openedAt - a.openedAt)[0];
      this.activeId = next ? next.id : null;
    }
    // Reflect closure into recents so the Lobby shows the just-closed cwd
    // near the top. Main writes the canonical copy via sessions:close.
    if (!this.findByCwd(slot.cwd)) {
      this.recentCwds = [
        { path: slot.cwd, lastOpenedAt: Date.now() },
        ...this.recentCwds.filter((r) => r.path !== slot.cwd),
      ].slice(0, 10);
    }
    this.notifyTabsOnly();
    if (this.activeId) this.notify(this.activeId);
    else for (const l of this.listeners) l();
  }

  // --- Event routing --------------------------------------------------------

  private handleIncomingEvent(e: RendererEvent) {
    // sessionId is always present on events from the multi-tab main; older
    // unsourced events (defensive only) get dropped silently because we can't
    // route them. We also let the active slot absorb sessionId-less events if
    // it's the only live one — but most callsites in main now tag every
    // emit, so the fallback is rare.
    const sessionId = (e as { sessionId?: string }).sessionId;
    let targetId: string | null = sessionId ?? null;
    if (!targetId) {
      // Fallback: deliver to active slot if it's a live (non-placeholder) one.
      const active = this.activeId ? this.slots.get(this.activeId) : null;
      if (active && !active.placeholder) targetId = active.id;
    }
    if (!targetId) return;
    const slot = this.slots.get(targetId);
    if (!slot || slot.placeholder) return;
    this.handleEventForSlot(slot, e);
  }

  private bumpUnread(slot: SlotInternal) {
    if (slot.id === this.activeId) return;
    slot.unreadCount += 1;
  }

  private handleEventForSlot(slot: SlotInternal, e: RendererEvent) {
    const source: AgentSource = e.source ?? 'talker';
    if (e.kind === 'worker-spawned') {
      this.mutateSlot(slot.id, (s) => {
        const workers = new Map(s.workers);
        const existing = workers.get(e.workerId);
        const now = Date.now();
        const isReassign = !!(existing && existing.endedAt !== null);
        const archivedHistory: WorkerTaskHistoryEntry[] = isReassign
          ? [
              ...existing!.taskHistory,
              {
                id: `${e.workerId}-task-${existing!.taskHistory.length + 1}`,
                title: existing!.title,
                status: existing!.status === 'idle' ? 'done' : existing!.status,
                startedAt: existing!.startedAt ?? existing!.endedAt!,
                finishedAt: existing!.endedAt!,
                summary: existing!.summary || undefined,
              },
            ]
          : existing?.taskHistory ?? [];
        const next: WorkerState = existing
          ? {
              ...existing,
              title: e.title,
              deps: e.deps,
              status: 'running',
              specialty: e.specialty,
              startedAt: now,
              endedAt: null,
              summary: '',
              currentTool: null,
              currentToolInput: null,
              pendingPermission: null,
              lastText: '',
              activity: isReassign ? [] : existing.activity,
              transcript: isReassign ? [] : existing.transcript,
              taskHistory: archivedHistory,
            }
          : {
              id: e.workerId,
              title: e.title,
              role: 'worker',
              status: 'running',
              deps: e.deps,
              transcript: [],
              activity: [],
              pendingPermission: null,
              currentTool: null,
              currentToolInput: null,
              lastText: '',
              endedAt: null,
              summary: '',
              specialty: e.specialty,
              startedAt: now,
              taskHistory: [],
            };
        workers.set(e.workerId, next);
        return { ...s, workers };
      });
      return;
    }
    if (e.kind === 'worker-ended') {
      this.updateWorker(slot, e.workerId, (w) => ({
        ...w,
        status: e.status,
        endedAt: Date.now(),
        summary: e.summary ?? w.summary,
        currentTool: null,
        currentToolInput: null,
      }));
      return;
    }
    if (e.kind === 'worker-delivery') {
      // Stage this delivery for the ScreenStage acceptance panel. Replaces
      // any prior pending delivery — only the freshest one is shown so the
      // user always knows which worker just handed something off.
      this.mutateSlot(slot.id, (s) => ({
        ...s,
        currentDelivery: {
          workerId: e.workerId,
          title: e.title,
          summary: e.summary,
          taskId: e.taskId,
          files: e.files,
          receivedAt: Date.now(),
        },
      }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'plan-updated') {
      this.mutateSlot(slot.id, (s) => ({ ...s, plan: e.plan }));
      return;
    }
    if (e.kind === 'error') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Error', detail: e.error, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
      this.mutateSlot(slot.id, (s) => ({ ...s, lastError: e.error }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'ended') {
      slot.endedSources.add(source);
      this.updateWorker(slot, source, (w) => ({
        ...w,
        status: w.status === 'idle' || w.role === 'talker' ? 'idle' : (w.status === 'running' ? 'done' : w.status),
        endedAt: Date.now(),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: `${source} ended`, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
      if (source === 'talker') {
        const intended = slot.intendedExit;
        this.mutateSlot(slot.id, (s) => ({
          ...s,
          running: false,
          lastError: intended ? s.lastError : (s.lastError ?? 'Session ended unexpectedly.'),
        }));
      }
      return;
    }
    if (e.kind === 'permission-request') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        pendingPermission: { id: e.id, toolName: e.toolName, input: e.input, toolUseID: e.toolUseID },
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'tool-call',
            title: `Permission asked: ${e.toolName}`,
            detail: JSON.stringify(e.input).slice(0, 200),
            ts: Date.now(),
            source,
          }],
          MAX_ACTIVITY,
        ),
      }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'decision-pending') {
      const sideChannels = [
        e.calendarOk ? '日历' : null,
        e.remindersOk ? '提醒' : null,
      ].filter(Boolean);
      const sideNote = sideChannels.length > 0
        ? ` · 已发到${sideChannels.join('/')}`
        : '';
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'system',
            title: `等你确认：${e.question}`,
            detail: `推荐方案：${e.recommendedTitle}${sideNote}`,
            ts: Date.now(),
            source: 'talker',
            actionPath: e.path,
          }],
          MAX_ACTIVITY,
        ),
      }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'decision-resolved') {
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'system',
            title: `用户已确认：${e.question}`,
            detail: e.conclusion,
            ts: Date.now(),
            source: 'talker',
            actionPath: e.path,
          }],
          MAX_ACTIVITY,
        ),
      }));
      return;
    }
    if (e.kind === 'message') {
      this.handleMessage(slot, source, e.message);
    }
  }

  private updateWorker(slot: SlotInternal, id: AgentSource, patch: (w: WorkerState) => WorkerState) {
    this.mutateSlot(slot.id, (s) => {
      const current = s.workers.get(id) ?? this.makeBlankWorker(id);
      const next = patch(current);
      const workers = new Map(s.workers);
      workers.set(id, next);
      return { ...s, workers };
    });
  }

  private makeBlankWorker(id: AgentSource): WorkerState {
    return {
      id,
      title: id,
      role: id === 'talker' ? 'talker' : 'worker',
      status: 'running',
      deps: [],
      transcript: [],
      activity: [],
      pendingPermission: null,
      currentTool: null,
      currentToolInput: null,
      lastText: '',
      endedAt: null,
      summary: '',
      specialty: 'general',
      startedAt: null,
      taskHistory: [],
    };
  }

  private handleAgentApiError(slot: SlotInternal, source: AgentSource, code: string) {
    const friendly = (() => {
      switch (code) {
        case 'invalid_request':
          return '上下文超出模型窗口（可能是附件太大）。请清空会话或重新发起,然后用更小的附件或拆分发送。';
        case 'rate_limit':
          return '触发模型限流,稍后再试。';
        case 'max_output_tokens':
          return '模型输出超过上限,请缩小一次提问的范围。';
        case 'server_error':
          return '模型服务暂时不可用,稍后再试。';
        case 'authentication_failed':
          return '认证失败,请检查 ANTHROPIC_API_KEY 配置。';
        case 'billing_error':
          return '账户额度问题,请检查计费状态。';
        case 'model_not_found':
          return '模型不可用,请检查配置中的模型 ID。';
        default:
          return `Agent API error: ${code}`;
      }
    })();
    this.updateWorker(slot, source, (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{ id: uid(), kind: 'error', title: 'API error', detail: friendly, ts: Date.now(), source }],
        MAX_ACTIVITY,
      ),
    }));
    this.mutateSlot(slot.id, (s) => ({ ...s, lastError: friendly }));
    this.bumpUnread(slot);
  }

  private handleMessage(slot: SlotInternal, source: AgentSource, msg: any) {
    const type = msg?.type;
    if (type === 'assistant') {
      if (typeof msg?.error === 'string' && msg.error.length > 0) {
        this.handleAgentApiError(slot, source, msg.error as string);
        return;
      }
      const content = msg?.message?.content;
      const text = extractText(content);
      const tools = extractToolUses(content);
      // TTS: only the active slot's talker speaks immediately. For background
      // tabs we stash the most recent talker text in pendingSpeak so setActive
      // can replay it on switch-in (B3 — previously the gate dropped these
      // messages entirely once activeId drifted off mid-reply).
      const isTalkerText = source === 'talker' && text.trim().length > 0;
      const shouldSpeak =
        isTalkerText &&
        text !== slot.lastSpoken &&
        slot.id === this.activeId;
      if (shouldSpeak) slot.lastSpoken = text;
      if (isTalkerText && slot.id !== this.activeId && text !== slot.lastSpoken) {
        slot.pendingSpeak = { text, ts: Date.now() };
      }
      // Stamp the talker transcript entry once outside updateWorker so the
      // same id/ts gets mirrored to disk (otherwise the persist step would
      // generate a fresh uid + new Date.now() and disagree with what the UI
      // shows).
      const talkerEntry: TranscriptEntry | null =
        source === 'talker' && text.trim().length > 0
          ? { id: uid(), role: 'assistant', text, ts: Date.now() }
          : null;
      this.updateWorker(slot, source, (w) => {
        let next: WorkerState = w;
        if (text.trim().length > 0) {
          if (source === 'talker' && talkerEntry) {
            next = {
              ...next,
              transcript: appendCapped(
                next.transcript,
                [talkerEntry],
                MAX_TRANSCRIPT,
              ),
              lastText: text,
            };
          } else {
            next = {
              ...next,
              lastText: text,
              activity: appendCapped(
                next.activity,
                [{
                  id: uid(),
                  kind: 'system',
                  title: 'Worker thought',
                  detail: text.slice(0, 300),
                  ts: Date.now(),
                  source,
                }],
                MAX_ACTIVITY,
              ),
            };
          }
        }
        if (tools.length > 0) {
          const visible = tools.filter(
            (t) => !(source === 'talker' && MEETING_TOOL_NAMES.has(t.name)),
          );
          if (visible.length > 0) {
            const last = visible[visible.length - 1];
            const input = typeof last.input === 'object' && last.input !== null
              ? JSON.stringify(last.input).slice(0, 80)
              : String(last.input ?? '');
            next = {
              ...next,
              currentTool: last.name,
              currentToolInput: input,
              activity: appendCapped(
                next.activity,
                visible.map((t) => ({
                  id: uid(),
                  kind: 'tool-call' as const,
                  title: `Tool: ${t.name}`,
                  detail: JSON.stringify(t.input).slice(0, 200),
                  ts: Date.now(),
                  source,
                })),
                MAX_ACTIVITY,
              ),
            };
          }
        }
        return next;
      });
      if (talkerEntry) this.persistTalkerEntry(slot, talkerEntry);
      if (shouldSpeak) this.speakCallback?.(text);
      if (source === 'talker' && text.trim().length > 0) this.bumpUnread(slot);
      return;
    }
    if (type === 'user') {
      const content = msg?.message?.content;
      if (!Array.isArray(content)) return;
      const results = content.filter((b: any) => b?.type === 'tool_result');
      if (results.length === 0 || source === 'talker') return;
      this.updateWorker(slot, source, (w) => ({
        ...w,
        currentTool: null,
        currentToolInput: null,
        activity: appendCapped(
          w.activity,
          results.map((r: any) => ({
            id: uid(),
            kind: 'tool-result' as const,
            title: `Tool result${r.is_error ? ' (error)' : ''}`,
            detail: typeof r.content === 'string'
              ? r.content.slice(0, 300)
              : JSON.stringify(r.content).slice(0, 300),
            ts: Date.now(),
            source,
          })),
          MAX_ACTIVITY,
        ),
      }));
      return;
    }
    if (type === 'result') {
      if (source === 'talker') return;
      this.updateWorker(slot, source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: 'Worker turn complete', detail: msg?.subtype ?? '', ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
      return;
    }
    if (type === 'system') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: 'System', detail: msg?.subtype ?? '', ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
    }
  }

  // --- Active-slot send API (back-compat for components/hooks) --------------

  async restartSession() {
    const id = this.activeId;
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot || slot.placeholder) return;
    const cwd = slot.cwd;
    const greeting = slot.greeting;
    slot.intendedExit = true;
    try { await window.vibeMeet.endSession(id); } catch (err) {
      console.warn('[meeting-store] endSession (restart) failed', { id, err });
    }
    try { await window.vibeMeet.sessions.close(id); } catch (err) {
      console.warn('[meeting-store] sessions.close (restart) failed', { id, err });
    }
    this.slots.delete(id);
    this.activeId = null;
    this.notifyTabsOnly();
    await this.openSession(cwd, greeting);
  }

  async sendText(text: string) {
    if (!text.trim()) return;
    const id = this.effectiveSessionId();
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot) return;
    const entry: TranscriptEntry = { id: uid(), role: 'user', text, ts: Date.now() };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [entry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, entry);
    await window.vibeMeet.sendUserText(id, text);
  }

  async sendImage(dataUrl: string, caption: string) {
    const id = this.effectiveSessionId();
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot) return;
    const entry: TranscriptEntry = {
      id: uid(),
      role: 'user',
      text: caption || 'Shared current screen',
      imageUrl: dataUrl,
      ts: Date.now(),
    };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [entry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, entry);
    await window.vibeMeet.sendUserImage(id, dataUrl, caption);
  }

  async sendAttachments(
    staged: StagedAttachment[],
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (staged.length === 0 && !text.trim()) return { ok: false, error: 'Nothing to send' };
    const id = this.effectiveSessionId();
    if (!id) return { ok: false, error: 'No active session' };
    const slot = this.slots.get(id);
    if (!slot) return { ok: false, error: 'No active session' };
    const meta: AttachmentMeta[] = staged.map((a) => ({ name: a.name, kind: a.kind, sizeBytes: a.sizeBytes }));
    const transcriptText = text.trim().length > 0 ? text : `Sent ${staged.length} file${staged.length === 1 ? '' : 's'}`;
    const entryId = uid();
    const entry: TranscriptEntry = {
      id: entryId,
      role: 'user',
      text: transcriptText,
      attachments: meta.length > 0 ? meta : undefined,
      ts: Date.now(),
    };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [entry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, entry);
    const wire = staged.map((a) => ({
      name: a.name,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      dataBase64: a.dataBase64,
    }));
    try {
      const res = await window.vibeMeet.sendUserAttachments(id, wire, text);
      if (!res.ok) {
        this.updateWorker(slot, 'talker', (w) => ({
          ...w,
          transcript: w.transcript.filter((t) => t.id !== entryId),
          activity: appendCapped(
            w.activity,
            [{ id: uid(), kind: 'error', title: 'Attachment send failed', detail: res.error, ts: Date.now() }],
            MAX_ACTIVITY,
          ),
        }));
        return { ok: false, error: res.error };
      }
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        transcript: w.transcript.filter((t) => t.id !== entryId),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Attachment send failed', detail: msg, ts: Date.now() }],
          MAX_ACTIVITY,
        ),
      }));
      return { ok: false, error: msg };
    }
  }

  // Window-level drag-and-drop fan-out (unchanged).
  private droppedFileListeners = new Set<(files: File[]) => void>();
  publishDroppedFiles(files: File[]) {
    if (files.length === 0) return;
    for (const cb of this.droppedFileListeners) {
      try { cb(files); } catch (err) {
        console.warn('[meeting-store] droppedFiles subscriber threw', err);
      }
    }
  }
  onDroppedFiles(cb: (files: File[]) => void): () => void {
    this.droppedFileListeners.add(cb);
    return () => { this.droppedFileListeners.delete(cb); };
  }

  async resolvePermission(id: string, decision: 'allow' | 'deny') {
    const sessionId = this.effectiveSessionId();
    if (!sessionId) return;
    await window.vibeMeet.resolvePermission(sessionId, id, decision);
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    this.mutateSlot(slot.id, (s) => {
      const workers = new Map(s.workers);
      for (const [key, w] of workers) {
        if (w.pendingPermission?.id === id) {
          workers.set(key, { ...w, pendingPermission: null });
        }
      }
      return { ...s, workers };
    });
  }

  async interrupt() {
    const id = this.effectiveSessionId();
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot) return;
    await window.vibeMeet.interrupt(id);
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{ id: uid(), kind: 'system', title: 'Interrupted', ts: Date.now() }],
        MAX_ACTIVITY,
      ),
    }));
  }

  async endSession() {
    const id = this.activeId;
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot || slot.placeholder) return;
    slot.intendedExit = true;
    await window.vibeMeet.endSession(id);
    this.mutateSlot(slot.id, (s) => ({ ...s, running: false, lastError: null }));
  }

  // --- Delivery acceptance --------------------------------------------------

  /** Dismiss the staged delivery — user signed off on the work. We don't
   *  echo anything back to the worker; the absence of feedback IS the
   *  acceptance signal (worker has already been disposed by markTaskDone). */
  acceptDelivery() {
    const id = this.effectiveSessionId();
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot || !slot.state.currentDelivery) return;
    this.mutateSlot(slot.id, (s) => ({ ...s, currentDelivery: null }));
  }

  /** Push revision feedback back into the meeting. Tries the worker's
   *  session first via steerWorker; if the worker has already been disposed
   *  (the usual case after markTaskDone), falls back to sending a synthetic
   *  user message to the talker so it can re-delegate. */
  async reviseDelivery(
    feedback: string,
  ): Promise<{ ok: true; route: 'worker' | 'talker'; queued?: boolean } | { ok: false; error: string }> {
    const trimmed = feedback.trim();
    if (!trimmed) return { ok: false, error: 'Empty feedback' };
    const id = this.effectiveSessionId();
    if (!id) return { ok: false, error: 'No active session' };
    const slot = this.slots.get(id);
    if (!slot || !slot.state.currentDelivery) {
      return { ok: false, error: 'No delivery staged' };
    }
    const delivery = slot.state.currentDelivery;
    const workerId = delivery.workerId;

    const directRes = await window.vibeMeet.steerWorker(id, workerId, trimmed);
    if (directRes.ok) {
      this.markDeliveryRevised(slot, workerId, trimmed);
      return { ok: true, route: 'worker', queued: directRes.queued };
    }

    // Worker already torn down (status='done'/'failed' or session gone) —
    // route through the talker so it can re-delegate. We append a transcript
    // entry that mirrors what the user sees so the chat history shows the
    // request, and we let the talker decide how to dispatch it.
    const fileLine = delivery.files.length > 0
      ? `\n相关文件:\n${delivery.files.map((f) => `  - ${f.path}`).join('\n')}`
      : '';
    const synthetic = [
      `刚才 ${workerId}「${delivery.title}」交付的内容我看过了，需要继续改:`,
      trimmed,
      fileLine,
      '请把这条修改意见交回去（可以复用同一个 worker，也可以重新派活）。',
    ].filter(Boolean).join('\n');

    await window.vibeMeet.sendUserText(id, synthetic);
    const revisionEntry: TranscriptEntry = {
      id: uid(),
      role: 'user',
      text: `[对 ${delivery.title} 的修改意见] ${trimmed}`,
      ts: Date.now(),
    };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [revisionEntry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, revisionEntry);
    this.markDeliveryRevised(slot, workerId, trimmed);
    return { ok: true, route: 'talker' };
  }

  private markDeliveryRevised(slot: SlotInternal, workerId: AgentSource, feedback: string) {
    this.mutateSlot(slot.id, (s) => ({ ...s, currentDelivery: null }));
    this.updateWorker(slot, workerId, (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{
          id: uid(),
          kind: 'system',
          title: '用户提出修改意见',
          detail: feedback.slice(0, 300),
          ts: Date.now(),
          source: workerId,
        }],
        MAX_ACTIVITY,
      ),
    }));
  }
}

export const meetingStore = new MeetingStore();
