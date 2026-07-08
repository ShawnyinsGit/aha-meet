import { useSyncExternalStore, useCallback } from 'react';
import { stageWindowStore, type StageWindowType } from '../lib/stage-window-store';

export function useStageWindows() {
  const state = useSyncExternalStore(
    stageWindowStore.subscribe,
    stageWindowStore.getSnapshot,
    stageWindowStore.getSnapshot,
  );

  const createWindow = useCallback((type: StageWindowType, opts?: { workerId?: string; title?: string }) => {
    void stageWindowStore.createWindow(type, opts);
  }, []);

  const closeWindow = useCallback((id: string) => {
    void stageWindowStore.closeWindow(id);
  }, []);

  const setActiveWindow = useCallback((id: string) => {
    void stageWindowStore.setActiveWindow(id);
  }, []);

  const renameWindow = useCallback((id: string, title: string) => {
    stageWindowStore.renameWindow(id, title);
  }, []);

  const openFile = useCallback((filePath: string) => {
    void stageWindowStore.openFile(filePath);
  }, []);

  const openDelivery = useCallback(() => {
    void stageWindowStore.openDelivery();
  }, []);

  return {
    windows: state.windows,
    activeWindowId: state.activeWindowId,
    createWindow,
    closeWindow,
    setActiveWindow,
    renameWindow,
    openFile,
    openDelivery,
  };
}
