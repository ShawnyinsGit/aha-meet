export type AutoApproveScope = 'off' | 'read' | 'all';

export type AgentSource = 'talker' | string;

export type WorkerStatus = 'pending' | 'running' | 'done' | 'failed';

export type WorkerSpecialty =
  | 'general'
  | 'frontend'
  | 'backend'
  | 'electron'
  | 'devops'
  | 'test'
  | 'docs'
  | 'review';

export interface WorkerTaskHistoryEntry {
  id: string;
  title: string;
  status: WorkerStatus;
  startedAt: number;
  finishedAt: number;
  summary?: string;
}

export interface MeetingPlanNode {
  id: string;
  title: string;
  status: WorkerStatus;
  deps: string[];
}

export interface MeetingPlan {
  nodes: MeetingPlanNode[];
}

export type RendererEvent =
  | { kind: 'message'; message: any; source?: AgentSource }
  | { kind: 'permission-request'; id: string; toolName: string; input: Record<string, unknown>; toolUseID: string; source?: AgentSource }
  | { kind: 'error'; error: string; source?: AgentSource }
  | { kind: 'ended'; source?: AgentSource }
  | { kind: 'worker-spawned'; workerId: string; title: string; deps: string[]; specialty: WorkerSpecialty; source?: AgentSource }
  | { kind: 'worker-ended'; workerId: string; status: WorkerStatus; summary?: string; source?: AgentSource }
  | { kind: 'plan-updated'; plan: MeetingPlan; source?: AgentSource }
  | { kind: 'decision-pending'; decisionId: string; question: string; path: string; recommendedTitle: string; calendarOk: boolean; remindersOk: boolean; source?: AgentSource }
  | { kind: 'decision-resolved'; decisionId: string; question: string; path: string; conclusion: string; source?: AgentSource };

export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
}

export interface VoicePrint {
  embedding: number[];
  model: string;
  secondsCaptured: number;
  enrolledAt: number;
}

export type MemoryCategory = 'point' | 'decision' | 'todo' | 'fact';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  projectId: string;
  sourceMeetingId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryListFilter {
  projectId?: string;
  category?: MemoryCategory;
  query?: string;
}

export interface MemoryUpdatePatch {
  category?: MemoryCategory;
  content?: string;
  tags?: string[];
}

export interface MemoryApi {
  list: (
    filter?: MemoryListFilter | null,
  ) => Promise<{ ok: true; entries: MemoryEntry[] } | { ok: false; error: string }>;
  update: (
    id: string,
    patch: MemoryUpdatePatch,
  ) => Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: string }>;
  delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  currentProjectId: () => Promise<string | null>;
}

export interface AuthApi {
  getConfig: () => Promise<{ authMode: 'apikey' | 'subscription' | null; hasApiKey: boolean }>;
  setApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  setMode: (mode: 'apikey' | 'subscription' | null) => Promise<{ ok: boolean; error?: string }>;
  loginSubscription: () => Promise<{ ok: boolean; error?: string }>;
  checkSubscriptionStatus: () => Promise<{ loggedIn: boolean }>;
}

export interface VibeMeetApi {
  startSession: (cwd: string, greeting?: string) => Promise<{ ok: boolean; cwd?: string; error?: string }>;
  sendUserText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  sendUserImage: (dataUrl: string, caption: string) => Promise<{ ok: boolean; error?: string }>;
  resolvePermission: (id: string, decision: 'allow' | 'deny', message?: string) => Promise<{ ok: boolean }>;
  interrupt: () => Promise<{ ok: boolean }>;
  setPermissionMode: (mode: string) => Promise<{ ok: boolean }>;
  setAutoApprove: (scope: AutoApproveScope) => Promise<{ ok: boolean; autoApproveScope?: AutoApproveScope }>;
  endSession: () => Promise<{ ok: boolean }>;
  pickCwd: () => Promise<string | null>;
  getLastCwd: () => Promise<string | null>;
  getVoiceConfig: () => Promise<{ enabled: boolean; voicePrint: VoicePrint | null }>;
  setVoiceLockEnabled: (on: boolean) => Promise<{ ok: boolean }>;
  setVoicePrint: (vp: VoicePrint | null) => Promise<{ ok: boolean }>;
  getVoicePref: () => Promise<{ selectedVoiceName: string | null; guidanceDismissed: boolean; speechFilterMode: 'strict' | 'off' }>;
  setVoicePref: (patch: { selectedVoiceName?: string | null; guidanceDismissed?: boolean; speechFilterMode?: 'strict' | 'off' }) => Promise<{ ok: boolean }>;
  openVoiceSettings: () => Promise<{ ok: boolean }>;
  getDesktopSources: () => Promise<
    | { ok: true; sources: DesktopSource[] }
    | { ok: false; error: string; status: string }
  >;
  checkScreenPermission: () => Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
  openScreenSettings: () => Promise<{ ok: boolean }>;
  relaunchApp: () => Promise<void>;
  asrAvailable: () => Promise<{ ok: boolean; available: boolean }>;
  transcribePcm: (
    pcm: ArrayBuffer,
    lang?: 'auto' | 'zh' | 'en',
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  auth: AuthApi;
  memory: MemoryApi;
  decisions: {
    open: (path: string) => Promise<{ ok: boolean; error?: string }>;
  };
  onEvent: (cb: (e: RendererEvent) => void) => () => void;
}

declare global {
  interface Window {
    vibeMeet: VibeMeetApi;
  }
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  imageUrl?: string;
}

export interface ActivityEntry {
  id: string;
  kind: 'tool-call' | 'tool-result' | 'system' | 'error';
  title: string;
  detail?: string;
  ts: number;
  source?: AgentSource;
  /** Absolute path to a decision markdown doc; renderer shows an "Open" button when set. */
  actionPath?: string;
}

export interface PendingPermission {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
}
