// Lightweight external store for embedded browser state.
// Follows the same subscribe/getSnapshot pattern as meeting-store.ts so
// components can use useSyncExternalStore.

import type { BrowserStateSnapshot, BrowserTabInfo } from '../types';

type Listener = () => void;

const initialState: BrowserStateSnapshot = {
  tabs: [],
  activeTabId: null,
  visible: false,
};

class BrowserStore {
  private state: BrowserStateSnapshot = { ...initialState };
  private listeners = new Set<Listener>();

  constructor() {
    if (typeof window !== 'undefined' && window.vibeMeet?.browser) {
      window.vibeMeet.browser.onStateUpdate((snap) => {
        this.state = snap;
        this.notify();
      });
      // Fetch initial state
      window.vibeMeet.browser.getState().then((snap) => {
        this.state = snap;
        this.notify();
      }).catch(() => { /* ignore */ });
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): BrowserStateSnapshot => this.state;

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  // --- Actions ---

  async openTab(url?: string): Promise<BrowserTabInfo | null> {
    if (!window.vibeMeet?.browser) return null;
    const result = await window.vibeMeet.browser.openTab(url);
    return result.ok ? result.tab : null;
  }

  async closeTab(tabId: string): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.closeTab(tabId);
  }

  async setActiveTab(tabId: string): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.setActive(tabId);
  }

  async navigate(tabId: string, url: string): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.navigate(tabId, url);
  }

  async goBack(tabId: string): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.back(tabId);
  }

  async goForward(tabId: string): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.forward(tabId);
  }

  async reload(tabId: string): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.reload(tabId);
  }

  async setBounds(bounds: { x: number; y: number; width: number; height: number; dpr: number }): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.setBounds(bounds);
  }

  async setVisible(visible: boolean): Promise<void> {
    if (!window.vibeMeet?.browser) return;
    await window.vibeMeet.browser.setVisible(visible);
  }

  async toggleVisible(): Promise<void> {
    const nextVisible = !this.state.visible;
    await this.setVisible(nextVisible);
    // Auto-open a tab when showing the browser for the first time
    if (nextVisible && this.state.tabs.length === 0) {
      await this.openTab();
    }
  }
}

export const browserStore = new BrowserStore();
