import { useSyncExternalStore, useCallback } from 'react';
import { stageWindowStore, type StageWindowType } from '../lib/stage-window-store';

export function useStageWindows() {
  const state = useSyncExternalStore(
    stageWindowStore.subscribe,
    stageWindowStore.getSnapshot,
    stageWindowStore.getSnapshot,
  );

  const createWindow = useCallback((type: StageWindowType) => {
    void stageWindowStore.createWindow(type);
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
    stageWindowStore.openFile(filePath);
  }, []);

  const openDelivery = useCallback(() => {
    stageWindowStore.openDelivery();
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
