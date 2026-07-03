// StageWindow store — manages dynamic multi-window tabs in the stage area.
// Follows the same subscribe/getSnapshot pattern as browser-store for
// useSyncExternalStore compatibility.

import { browserStore } from './browser-store';

export type StageWindowType = 'activity' | 'browser' | 'terminal' | 'file' | 'delivery';

export interface StageWindow {
  id: string;
  type: StageWindowType;
  title: string;
  browserTabId?: string;
  filePath?: string;
}

export interface StageWindowState {
  windows: StageWindow[];
  activeWindowId: string | null;
}

type Listener = () => void;

let nextId = 1;
function genId(): string {
  return `sw-${Date.now()}-${nextId++}`;
}

const ACTIVITY_TAB_ID = 'activity-default';

const initialState: StageWindowState = {
  windows: [{ id: ACTIVITY_TAB_ID, type: 'activity', title: '活动' }],
  activeWindowId: ACTIVITY_TAB_ID,
};

class StageWindowStore {
  private state: StageWindowState = { ...initialState };
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): StageWindowState => this.state;

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  private update(partial: Partial<StageWindowState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  async createWindow(type: StageWindowType): Promise<void> {
    if (type === 'activity') {
      this.setActiveWindow(ACTIVITY_TAB_ID);
      return;
    }

    const id = genId();

    if (type === 'browser') {
      const tab = await browserStore.openTab();
      if (!tab) return;
      const window: StageWindow = {
        id,
        type: 'browser',
        title: '新标签页',
        browserTabId: tab.id,
      };
      browserStore.subscribe(() => {
        const snap = browserStore.getSnapshot();
        const bTab = snap.tabs.find((t) => t.id === tab.id);
        if (bTab) {
          const current = this.state.windows.find((w) => w.id === id);
          if (current && current.title !== bTab.title && bTab.title !== '新标签页') {
            this.update({
              windows: this.state.windows.map((w) =>
                w.id === id ? { ...w, title: bTab.title } : w,
              ),
            });
          }
        }
      });
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
      await browserStore.setActiveTab(tab.id);
    } else {
      const title = type === 'terminal' ? '终端' : type === 'file' ? '文件' : '交付';
      const window: StageWindow = { id, type, title };
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
    }
  }

  async closeWindow(id: string): Promise<void> {
    if (id === ACTIVITY_TAB_ID) return;
    const win = this.state.windows.find((w) => w.id === id);
    if (!win) return;

    if (win.type === 'browser' && win.browserTabId) {
      await browserStore.closeTab(win.browserTabId);
    }

    const newWindows = this.state.windows.filter((w) => w.id !== id);
    let newActiveId = this.state.activeWindowId;
    if (newActiveId === id) {
      newActiveId = newWindows.length > 0
        ? newWindows[newWindows.length - 1].id
        : ACTIVITY_TAB_ID;
    }

    this.update({ windows: newWindows, activeWindowId: newActiveId });

    if (newActiveId) {
      const nextWin = newWindows.find((w) => w.id === newActiveId);
      if (nextWin?.type === 'browser' && nextWin.browserTabId) {
        await browserStore.setActiveTab(nextWin.browserTabId);
        await browserStore.setVisible(true);
      } else {
        await browserStore.setVisible(false);
      }
    }
  }

  async setActiveWindow(id: string): Promise<void> {
    const win = this.state.windows.find((w) => w.id === id);
    if (!win) return;

    // Hide browser overlay when switching away from a browser tab
    const prevWin = this.state.windows.find((w) => w.id === this.state.activeWindowId);
    if (prevWin?.type === 'browser' && win.type !== 'browser') {
      await browserStore.setVisible(false);
    }

    this.update({ activeWindowId: id });

    if (win.type === 'browser' && win.browserTabId) {
      await browserStore.setActiveTab(win.browserTabId);
      await browserStore.setVisible(true);
    }
  }

  renameWindow(id: string, title: string): void {
    this.update({
      windows: this.state.windows.map((w) =>
        w.id === id ? { ...w, title } : w,
      ),
    });
  }

  openFile(filePath: string): void {
    const existing = this.state.windows.find((w) => w.type === 'file' && w.filePath === filePath);
    if (existing) {
      this.setActiveWindow(existing.id);
      return;
    }
    const fileWindows = this.state.windows.filter((w) => w.type === 'file');
    for (const fw of fileWindows) {
      void this.closeWindow(fw.id);
    }
    const id = genId();
    const fileName = filePath.split('/').pop() || filePath;
    const window: StageWindow = { id, type: 'file', title: fileName, filePath };
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
  }

  openDelivery(): void {
    const existing = this.state.windows.find((w) => w.type === 'delivery');
    if (existing) {
      this.setActiveWindow(existing.id);
      return;
    }
    const id = genId();
    const window: StageWindow = { id, type: 'delivery', title: '交付验收' };
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
  }

  removeByType(type: StageWindowType): void {
    const toRemove = this.state.windows.filter((w) => w.type === type);
    for (const w of toRemove) {
      void this.closeWindow(w.id);
    }
  }
}

export const stageWindowStore = new StageWindowStore();
