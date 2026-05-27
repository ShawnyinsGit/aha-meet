// orchestrator-types.ts — type definitions shared between orchestrator.ts,
// meeting-mcp.ts and recap.ts. Pulled out so submodules don't need to import
// the orchestrator class just to reach a type.
//
// These mirror the renderer-side types in src/types.ts: we can't cross the
// tsconfig rootDir boundary so the shapes are duplicated. Keep both files in
// sync when adding fields.

import type { ClaudeSession, SessionEvent } from './claude-session.js';

export type OrchestratorSource = 'talker' | string;

export type WorkerStatusKind = 'pending' | 'running' | 'done' | 'failed';

export type WorkerSpecialtyKind =
  | 'general'
  | 'frontend'
  | 'backend'
  | 'electron'
  | 'devops'
  | 'test'
  | 'docs'
  | 'review';

export interface MeetingPlanNode {
  id: string;
  title: string;
  status: WorkerStatusKind;
  deps: string[];
}

export interface MeetingPlan {
  nodes: MeetingPlanNode[];
}

// Orchestrator-only events (alongside session events emitted from a worker/talker).
export type OrchestratorOnlyEvent =
  | { kind: 'worker-spawned'; workerId: string; title: string; deps: string[]; specialty: WorkerSpecialtyKind }
  | { kind: 'worker-ended'; workerId: string; status: WorkerStatusKind; summary?: string }
  | { kind: 'plan-updated'; plan: MeetingPlan }
  | { kind: 'decision-pending'; decisionId: string; question: string; path: string; recommendedTitle: string; calendarOk: boolean; remindersOk: boolean }
  | { kind: 'decision-resolved'; decisionId: string; question: string; path: string; conclusion: string };

export type EmittedEvent = SessionEvent | OrchestratorOnlyEvent;

export interface OrchestratorEvent {
  source: OrchestratorSource;
  event: EmittedEvent;
}

export interface TalkerTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface WorkerLiveStatus {
  lastAssistantText: string;
  currentTool: string | null;
  currentToolInput: string | null;
  lastUpdateTs: number;
  busy: boolean;
}

export interface WorkerTaskHistoryEntry {
  id: string;
  title: string;
  status: WorkerStatusKind;
  startedAt: number;
  finishedAt: number;
  summary?: string;
}

export interface WorkerHandle {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  status: WorkerStatusKind;
  session: ClaudeSession | null;
  summary: string;
  live: WorkerLiveStatus;
  pendingDelegateAck: boolean;
  queuedAddenda: string[];
  bufferedUpdates: string[];
  flushTimer: NodeJS.Timeout | null;
  specialty: WorkerSpecialtyKind;
  startedAt: number;
  currentTaskId: string;
  taskSeq: number;
  taskHistory: WorkerTaskHistoryEntry[];
}

export interface RecentFileEdit {
  workerId: string;
  ts: number;
}
