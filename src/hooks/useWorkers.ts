import { useCallback, useSyncExternalStore } from 'react';
import { meetingStore, type DeliverySnapshot, type WorkerState } from '../lib/meeting-store';
import type { SpeakHandle } from '../lib/speech-session';
import type { MeetingPlan, StagedAttachment } from '../types';

export interface UseWorkersResult {
  workers: Map<string, WorkerState>;
  workerList: WorkerState[];
  plan: MeetingPlan | null;
  running: boolean;
  cwd: string | null;
  lastError: string | null;
  currentDelivery: DeliverySnapshot | null;
  restartSession: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendImage: (dataUrl: string, caption: string) => Promise<void>;
  sendAttachments: (staged: StagedAttachment[], text: string) => Promise<{ ok: boolean; error?: string }>;
  publishDroppedFiles: (files: File[]) => void;
  onDroppedFiles: (cb: (files: File[]) => void) => () => void;
  resolvePermission: (id: string, decision: 'allow' | 'deny') => Promise<void>;
  interrupt: () => Promise<void>;
  endSession: () => Promise<void>;
  setSpeakCallback: (cb: SpeakHandle | null) => void;
  acceptDelivery: () => void;
  reviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}

export function useWorkers(): UseWorkersResult {
  const state = useSyncExternalStore(meetingStore.subscribe, meetingStore.getSnapshot);
  // cwd changes when the active tab flips — subscribe to the tab listener too
  // so consumers re-render on tab switches without dragging cwd into the
  // active-slot state shape.
  const cwd = useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getActiveCwd);

  const setSpeakCallback = useCallback((cb: SpeakHandle | null) => {
    meetingStore.setSpeakCallback(cb);
  }, []);

  const restartSession = useCallback(() => meetingStore.restartSession(), []);
  const sendText = useCallback((text: string) => meetingStore.sendText(text), []);
  const sendImage = useCallback((dataUrl: string, caption: string) => meetingStore.sendImage(dataUrl, caption), []);
  const sendAttachments = useCallback(
    (staged: StagedAttachment[], text: string) => meetingStore.sendAttachments(staged, text),
    [],
  );
  const publishDroppedFiles = useCallback((files: File[]) => meetingStore.publishDroppedFiles(files), []);
  const onDroppedFiles = useCallback(
    (cb: (files: File[]) => void) => meetingStore.onDroppedFiles(cb),
    [],
  );
  const resolvePermission = useCallback(
    (id: string, decision: 'allow' | 'deny') => meetingStore.resolvePermission(id, decision),
    [],
  );
  const interrupt = useCallback(() => meetingStore.interrupt(), []);
  const endSession = useCallback(() => meetingStore.endSession(), []);
  const acceptDelivery = useCallback(() => meetingStore.acceptDelivery(), []);
  const reviseDelivery = useCallback(
    (feedback: string) => meetingStore.reviseDelivery(feedback),
    [],
  );

  return {
    workers: state.workers,
    workerList: Array.from(state.workers.values()),
    plan: state.plan,
    running: state.running,
    cwd,
    lastError: state.lastError,
    currentDelivery: state.currentDelivery,
    restartSession,
    sendText,
    sendImage,
    sendAttachments,
    publishDroppedFiles,
    onDroppedFiles,
    resolvePermission,
    interrupt,
    endSession,
    setSpeakCallback,
    acceptDelivery,
    reviseDelivery,
  };
}
