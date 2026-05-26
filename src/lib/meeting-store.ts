import type {
  ActivityEntry,
  AgentSource,
  MeetingPlan,
  PendingPermission,
  PlanMeetingTaskInput,
  RendererEvent,
  TranscriptEntry,
  WorkerStatus,
} from '../types';
import { MEETING_TOOL_NAMES } from '../../electron/meeting-tools';
import { extractText, extractToolUses, uid } from './sdk-message';

const MAX_TRANSCRIPT = 500;
const MAX_ACTIVITY = 500;

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
}

export interface MeetingState {
  workers: Map<AgentSource, WorkerState>;
  plan: MeetingPlan | null;
  running: boolean;
  cwd: string | null;
  lastError: string | null;
}

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
  };
}

function emptyState(): MeetingState {
  const workers = new Map<AgentSource, WorkerState>();
  workers.set('talker', createTalkerState());
  return {
    workers,
    plan: null,
    running: false,
    cwd: null,
    lastError: null,
  };
}

class MeetingStore {
  private state: MeetingState = emptyState();
  private listeners: Set<Listener> = new Set();
  private lastSpoken = '';
  private speakCallback: ((text: string) => void) | null = null;
  private lastSession: { cwd: string; greeting?: string } | null = null;
  private endedSources: Set<AgentSource> = new Set();
  private subscribed = false;
  private unsubscribeEvents: (() => void) | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.ensureSubscribed();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MeetingState => this.state;

  setSpeakCallback(cb: ((text: string) => void) | null) {
    this.speakCallback = cb;
  }

  private ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.unsubscribeEvents = window.vibeMeet.onEvent((e) => this.handleEvent(e));
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  private mutate(updater: (s: MeetingState) => MeetingState) {
    this.state = updater(this.state);
    this.notify();
  }

  private ensureWorker(id: AgentSource, init?: Partial<WorkerState>): WorkerState {
    let w = this.state.workers.get(id);
    if (w) return w;
    w = {
      id,
      title: init?.title ?? id,
      role: id === 'talker' ? 'talker' : 'worker',
      status: init?.status ?? 'running',
      deps: init?.deps ?? [],
      transcript: [],
      activity: [],
      pendingPermission: null,
      currentTool: null,
      currentToolInput: null,
      lastText: '',
      endedAt: null,
      summary: '',
    };
    this.state.workers.set(id, w);
    return w;
  }

  private updateWorker(id: AgentSource, patch: (w: WorkerState) => WorkerState) {
    this.mutate((s) => {
      const current = s.workers.get(id) ?? this.ensureWorker(id);
      const next = patch(current);
      const workers = new Map(s.workers);
      workers.set(id, next);
      return { ...s, workers };
    });
  }

  private handleEvent(e: RendererEvent) {
    const source: AgentSource = e.source ?? 'talker';
    if (e.kind === 'worker-spawned') {
      // Workers can be observed via their own session events before the
      // worker-spawned event arrives; pre-create the row defensively.
      this.mutate((s) => {
        const workers = new Map(s.workers);
        const existing = workers.get(e.workerId);
        const next: WorkerState = existing
          ? { ...existing, title: e.title, deps: e.deps, status: 'running' }
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
            };
        workers.set(e.workerId, next);
        return { ...s, workers };
      });
      return;
    }
    if (e.kind === 'worker-ended') {
      this.updateWorker(e.workerId, (w) => ({
        ...w,
        status: e.status,
        endedAt: Date.now(),
        summary: e.summary ?? w.summary,
        currentTool: null,
        currentToolInput: null,
      }));
      return;
    }
    if (e.kind === 'plan-updated') {
      this.mutate((s) => ({ ...s, plan: e.plan }));
      return;
    }
    if (e.kind === 'error') {
      this.updateWorker(source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Error', detail: e.error, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
      this.mutate((s) => ({ ...s, lastError: e.error }));
      return;
    }
    if (e.kind === 'ended') {
      this.endedSources.add(source);
      this.updateWorker(source, (w) => ({
        ...w,
        status: w.status === 'idle' || w.role === 'talker' ? 'idle' : (w.status === 'running' ? 'done' : w.status),
        endedAt: Date.now(),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: `${source} ended`, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
      // Only flip global running off when the Talker is gone. Workers come
      // and go but the meeting keeps running until the Talker dies.
      if (source === 'talker') {
        this.mutate((s) => ({
          ...s,
          running: false,
          lastError: s.lastError ?? 'Session ended unexpectedly.',
        }));
      }
      return;
    }
    if (e.kind === 'permission-request') {
      this.updateWorker(source, (w) => ({
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
      return;
    }
    if (e.kind === 'message') {
      this.handleMessage(source, e.message);
    }
  }

  private handleMessage(source: AgentSource, msg: any) {
    const type = msg?.type;
    if (type === 'assistant') {
      const content = msg?.message?.content;
      const text = extractText(content);
      const tools = extractToolUses(content);
      // Capture whether we should speak BEFORE the mutation so the callback
      // runs outside the updater — calling side effects (TTS, React state
      // updates) inside mutate() leads to subtle timing bugs.
      const shouldSpeak = source === 'talker' && text.trim().length > 0 && text !== this.lastSpoken;
      if (shouldSpeak) this.lastSpoken = text;
      this.updateWorker(source, (w) => {
        let next: WorkerState = w;
        if (text.trim().length > 0) {
          if (source === 'talker') {
            next = {
              ...next,
              transcript: appendCapped(
                next.transcript,
                [{ id: uid(), role: 'assistant', text, ts: Date.now() }],
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
      // Fire TTS callback AFTER the mutation completes so side effects
      // (speechSynthesis, React state updates) don't run inside the updater.
      if (shouldSpeak) this.speakCallback?.(text);
      return;
    }
    if (type === 'user') {
      const content = msg?.message?.content;
      if (!Array.isArray(content)) return;
      const results = content.filter((b: any) => b?.type === 'tool_result');
      if (results.length === 0 || source === 'talker') return;
      this.updateWorker(source, (w) => ({
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
      this.updateWorker(source, (w) => ({
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
      this.updateWorker(source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: 'System', detail: msg?.subtype ?? '', ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
    }
  }

  async startSession(cwd: string, greeting?: string) {
    this.lastSpoken = '';
    this.endedSources = new Set();
    this.lastSession = { cwd, greeting };
    this.state = emptyState();
    this.notify();
    const res = await window.vibeMeet.startSession(cwd, greeting);
    if (res.ok) {
      this.mutate((s) => ({ ...s, running: true, cwd: res.cwd ?? cwd }));
    }
  }

  async restartSession() {
    const last = this.lastSession;
    if (!last) return;
    try { await window.vibeMeet.endSession(); } catch { /* ignore */ }
    this.lastSpoken = '';
    this.endedSources = new Set();
    this.state = emptyState();
    this.notify();
    const res = await window.vibeMeet.startSession(last.cwd, last.greeting);
    if (res.ok) {
      this.mutate((s) => ({ ...s, running: true, cwd: res.cwd ?? last.cwd }));
    }
  }

  async sendText(text: string) {
    if (!text.trim()) return;
    this.updateWorker('talker', (w) => ({
      ...w,
      transcript: appendCapped(
        w.transcript,
        [{ id: uid(), role: 'user', text, ts: Date.now() }],
        MAX_TRANSCRIPT,
      ),
    }));
    await window.vibeMeet.sendUserText(text);
  }

  async sendImage(dataUrl: string, caption: string) {
    this.updateWorker('talker', (w) => ({
      ...w,
      transcript: appendCapped(
        w.transcript,
        [{ id: uid(), role: 'user', text: `🖼 ${caption || 'Shared current screen'}`, ts: Date.now() }],
        MAX_TRANSCRIPT,
      ),
    }));
    await window.vibeMeet.sendUserImage(dataUrl, caption);
  }

  async resolvePermission(id: string, decision: 'allow' | 'deny') {
    await window.vibeMeet.resolvePermission(id, decision);
    // Clear pending on whichever worker held it.
    this.mutate((s) => {
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
    await window.vibeMeet.interrupt();
    this.updateWorker('talker', (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{ id: uid(), kind: 'system', title: 'Interrupted', ts: Date.now() }],
        MAX_ACTIVITY,
      ),
    }));
  }

  async endSession() {
    await window.vibeMeet.endSession();
    this.endedSources = new Set();
    this.mutate((s) => ({ ...s, running: false }));
  }

  async planMeeting(tasks: PlanMeetingTaskInput[]) {
    return window.vibeMeet.planMeeting(tasks);
  }
}

export const meetingStore = new MeetingStore();
