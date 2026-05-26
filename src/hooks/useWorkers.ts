import { useCallback, useSyncExternalStore } from 'react';
import { meetingStore, type WorkerState } from '../lib/meeting-store';
import type { MeetingPlan, PlanMeetingTaskInput } from '../types';

export interface UseWorkersResult {
  workers: Map<string, WorkerState>;
  workerList: WorkerState[];
  plan: MeetingPlan | null;
  running: boolean;
  cwd: string | null;
  lastError: string | null;
  startSession: (cwd: string, greeting?: string) => Promise<void>;
  restartSession: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendImage: (dataUrl: string, caption: string) => Promise<void>;
  resolvePermission: (id: string, decision: 'allow' | 'deny') => Promise<void>;
  interrupt: () => Promise<void>;
  endSession: () => Promise<void>;
  planMeeting: (tasks: PlanMeetingTaskInput[]) => Promise<{ ok: boolean; error?: string }>;
  setSpeakCallback: (cb: ((text: string) => void) | null) => void;
}

export function useWorkers(): UseWorkersResult {
  const state = useSyncExternalStore(meetingStore.subscribe, meetingStore.getSnapshot);

  const setSpeakCallback = useCallback((cb: ((text: string) => void) | null) => {
    meetingStore.setSpeakCallback(cb);
  }, []);

  const startSession = useCallback((cwd: string, greeting?: string) => {
    return meetingStore.startSession(cwd, greeting);
  }, []);

  const restartSession = useCallback(() => meetingStore.restartSession(), []);
  const sendText = useCallback((text: string) => meetingStore.sendText(text), []);
  const sendImage = useCallback((dataUrl: string, caption: string) => meetingStore.sendImage(dataUrl, caption), []);
  const resolvePermission = useCallback(
    (id: string, decision: 'allow' | 'deny') => meetingStore.resolvePermission(id, decision),
    [],
  );
  const interrupt = useCallback(() => meetingStore.interrupt(), []);
  const endSession = useCallback(() => meetingStore.endSession(), []);
  const planMeeting = useCallback(
    (tasks: PlanMeetingTaskInput[]) => meetingStore.planMeeting(tasks),
    [],
  );

  return {
    workers: state.workers,
    workerList: Array.from(state.workers.values()),
    plan: state.plan,
    running: state.running,
    cwd: state.cwd,
    lastError: state.lastError,
    startSession,
    restartSession,
    sendText,
    sendImage,
    resolvePermission,
    interrupt,
    endSession,
    planMeeting,
    setSpeakCallback,
  };
}
