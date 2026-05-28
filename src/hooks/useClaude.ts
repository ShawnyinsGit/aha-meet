import { useMemo } from 'react';
import type { ActivityEntry, PendingPermission, TranscriptEntry } from '../types';
import { useWorkers } from './useWorkers';

export interface ClaudeState {
  running: boolean;
  cwd: string | null;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pendingPermission: PendingPermission | null;
  lastError: string | null;
}

const MAX_AGGREGATE_ACTIVITY = 500;

// Backward-compat wrapper around useWorkers. Existing screens (ClaudeWorkspace,
// the single-tile chat surface) consume a flattened view: Talker's transcript +
// merged activity from all sources + the first pending permission found. New
// participant-style UI should call useWorkers directly for per-worker state.
export function useClaude() {
  const w = useWorkers();

  const state = useMemo<ClaudeState>(() => {
    const talker = w.workers.get('talker');
    const transcript = talker?.transcript ?? [];

    // Merge activity from all workers, sort by timestamp, cap to a sane size
    // so legacy screens don't render thousands of rows.
    const merged: ActivityEntry[] = [];
    for (const ws of w.workers.values()) merged.push(...ws.activity);
    merged.sort((a, b) => a.ts - b.ts);
    const activity = merged.length > MAX_AGGREGATE_ACTIVITY
      ? merged.slice(merged.length - MAX_AGGREGATE_ACTIVITY)
      : merged;

    // First pending permission wins for the legacy single-prompt UI; new UI
    // should render per-worker permissions on each WorkerCard.
    let pendingPermission: PendingPermission | null = null;
    for (const ws of w.workers.values()) {
      if (ws.pendingPermission) {
        pendingPermission = ws.pendingPermission;
        break;
      }
    }

    return {
      running: w.running,
      cwd: w.cwd,
      transcript,
      activity,
      pendingPermission,
      lastError: w.lastError,
    };
  }, [w.workers, w.running, w.cwd, w.lastError]);

  return {
    state,
    restartSession: w.restartSession,
    sendText: w.sendText,
    sendImage: w.sendImage,
    sendAttachments: w.sendAttachments,
    publishDroppedFiles: w.publishDroppedFiles,
    onDroppedFiles: w.onDroppedFiles,
    resolvePermission: w.resolvePermission,
    interrupt: w.interrupt,
    endSession: w.endSession,
    setSpeakCallback: w.setSpeakCallback,
  };
}
