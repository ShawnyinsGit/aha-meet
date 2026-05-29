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

/** One file delivered by a worker turn. Path is absolute; the renderer
 *  fetches contents via `documents.read`. */
export interface WorkerDeliveryFile {
  path: string;
}

/** Every event from main is tagged with the sessionId of the slot that
 *  emitted it. Renderer's multi-slot store routes the event to the right
 *  MeetingState by id; absent or unknown ids are dropped. */
export type RendererEvent =
  | { kind: 'message'; message: any; source?: AgentSource; sessionId?: string }
  | { kind: 'permission-request'; id: string; toolName: string; input: Record<string, unknown>; toolUseID: string; source?: AgentSource; sessionId?: string }
  | { kind: 'error'; error: string; source?: AgentSource; sessionId?: string }
  | { kind: 'ended'; source?: AgentSource; sessionId?: string }
  | { kind: 'worker-spawned'; workerId: string; title: string; deps: string[]; specialty: WorkerSpecialty; source?: AgentSource; sessionId?: string }
  | { kind: 'worker-ended'; workerId: string; status: WorkerStatus; summary?: string; source?: AgentSource; sessionId?: string }
  | { kind: 'worker-delivery'; workerId: string; title: string; summary: string; taskId: string; files: WorkerDeliveryFile[]; source?: AgentSource; sessionId?: string }
  | { kind: 'plan-updated'; plan: MeetingPlan; source?: AgentSource; sessionId?: string }
  | { kind: 'decision-pending'; decisionId: string; question: string; path: string; recommendedTitle: string; calendarOk: boolean; remindersOk: boolean; source?: AgentSource; sessionId?: string }
  | { kind: 'decision-resolved'; decisionId: string; question: string; path: string; conclusion: string; source?: AgentSource; sessionId?: string }
  | { kind: 'session-ready'; source?: AgentSource; sessionId?: string }
  | { kind: 'session-start-failed'; error: string; source?: AgentSource; sessionId?: string };

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
  currentProjectId: (sessionId?: string | null) => Promise<string | null>;
}

export interface AuthApi {
  getConfig: () => Promise<{ authMode: 'apikey' | 'subscription' | null; hasApiKey: boolean }>;
  setApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  setMode: (mode: 'apikey' | 'subscription' | null) => Promise<{ ok: boolean; error?: string }>;
  loginSubscription: () => Promise<{ ok: boolean; error?: string }>;
  checkSubscriptionStatus: () => Promise<{ loggedIn: boolean }>;
}

export type AttachmentKind = 'text' | 'image' | 'word' | 'pdf';

export interface StagedAttachment {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** Base64 payload sent across IPC; cleared after send. */
  dataBase64: string;
}

export interface AttachmentMeta {
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
}

export interface AttachmentSendWire {
  name: string;
  mime: string;
  sizeBytes: number;
  dataBase64: string;
}

/** Tab/meeting metadata describing one open slot. Returned by sessions:list. */
export interface SessionMeta {
  id: string;
  cwd: string;
  openedAt: number;
  lastActivityAt: number;
}

export interface RecentCwdMeta {
  path: string;
  lastOpenedAt: number;
}

export interface OpenTabMeta {
  cwd: string;
  openedAt: number;
}

export interface SessionsApi {
  open: (
    cwd: string,
    greeting?: string,
  ) => Promise<
    | { ok: true; sessionId: string; cwd: string; status?: 'starting' }
    | { ok: false; error: 'duplicate'; sessionId: string; cwd?: string }
    | { ok: false; error: string }
  >;
  close: (id: string) => Promise<{ ok: boolean; activeId?: string | null; error?: string }>;
  setActive: (id: string) => Promise<{ ok: boolean; error?: string }>;
  list: () => Promise<{ ok: true; sessions: SessionMeta[]; activeId: string | null }>;
  listRestore: () => Promise<{
    ok: true;
    openTabs: OpenTabMeta[];
    recentCwds: RecentCwdMeta[];
    lastActiveCwd: string | null;
  }>;
}

export interface VibeMeetApi {
  sessions: SessionsApi;
  sendUserText: (sessionId: string | null, text: string) => Promise<{ ok: boolean; error?: string }>;
  sendUserImage: (sessionId: string | null, dataUrl: string, caption: string) => Promise<{ ok: boolean; error?: string }>;
  sendUserAttachments: (
    sessionId: string | null,
    items: AttachmentSendWire[],
    caption: string,
  ) => Promise<{ ok: boolean; error?: string; inlinedCount?: number; workspaceCount?: number }>;
  resolvePermission: (sessionId: string | null, id: string, decision: 'allow' | 'deny', message?: string) => Promise<{ ok: boolean }>;
  interrupt: (sessionId: string | null) => Promise<{ ok: boolean }>;
  setPermissionMode: (sessionId: string | null, mode: string) => Promise<{ ok: boolean }>;
  setAutoApprove: (scope: AutoApproveScope) => Promise<{ ok: boolean; autoApproveScope?: AutoApproveScope }>;
  endSession: (sessionId: string | null) => Promise<{ ok: boolean }>;
  pickCwd: () => Promise<string | null>;
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
  requestMicPermission: () => Promise<boolean>;
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
  documents: DocumentsApi;
  transcripts: TranscriptsApi;
  steerWorker: (
    sessionId: string | null,
    workerId: string,
    addendum: string,
  ) => Promise<{ ok: true; queued: boolean } | { ok: false; error: string; reason?: string }>;
  onEvent: (cb: (e: RendererEvent) => void) => () => void;
}

export interface TranscriptsApi {
  load: (
    cwd: string,
  ) => Promise<{ ok: true; entries: TranscriptEntry[] } | { ok: false; error: string }>;
  append: (
    cwd: string,
    entry: TranscriptEntry,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  clear: (cwd: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export type DeliveryFileKind = AttachmentKind | 'video' | 'binary' | 'missing';

export interface DocumentReadOk {
  ok: true;
  path: string;
  name: string;
  sizeBytes: number;
  kind: DeliveryFileKind;
  text?: string;
  truncated?: boolean;
  /** Raw bytes for image/video kinds — main hands these over via structured
   *  clone, so the renderer can wrap them in a Blob and use object URLs
   *  instead of base64 data URLs. */
  data?: Uint8Array;
  /** Legacy base64 payload kept for one transition release. New code should
   *  prefer `data`. */
  dataBase64?: string;
  mediaType?: string;
}

export interface DocumentReadErr {
  ok: false;
  error: string;
  code?: 'not-in-cwd' | 'no-session' | 'missing' | 'too-large' | 'read-failed' | 'invalid-path';
}

export type DocumentReadResult = DocumentReadOk | DocumentReadErr;

export interface DocumentsApi {
  read: (sessionId: string | null, path: string) => Promise<DocumentReadResult>;
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
  attachments?: AttachmentMeta[];
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
