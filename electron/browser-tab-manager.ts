// Embedded browser tab manager.
//
// Owns all WebContentsView instances for the built-in browser. The main window
// attaches/detaches views as child views to show/hide the browser panel. Each
// tab's webContents is preserved across visibility toggles so browsing state
// (cookies, history, scroll position) survives.
//
// Bounds synchronization: the renderer measures its .browser-viewport div with
// a ResizeObserver and sends CSS-pixel bounds via browser:set-bounds. We round
// and pass them directly to setBounds() (which operates in logical points).

import { BrowserWindow, WebContentsView, session } from 'electron';
import { randomUUID } from 'node:crypto';

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserStateSnapshot {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  visible: boolean;
}

type StateListener = (state: BrowserStateSnapshot) => void;

const MAX_TABS = 10;
const DEFAULT_URL = 'https://www.google.com';
const BROWSER_PARTITION = 'persist:embedded-browser';

export class BrowserTabManager {
  private tabs = new Map<string, { info: BrowserTabInfo; view: WebContentsView; eventHandler: () => void }>();
  private activeTabId: string | null = null;
  private visible = false;
  private currentBounds = { x: 0, y: 0, width: 0, height: 0 };
  private dpr = 1;
  private window: BrowserWindow | null = null;
  private listeners = new Set<StateListener>();

  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  onStateUpdate(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try { fn(snap); } catch { /* ignore listener errors */ }
    }
  }

  snapshot(): BrowserStateSnapshot {
    return {
      tabs: [...this.tabs.values()].map(({ info }) => ({ ...info })),
      activeTabId: this.activeTabId,
      visible: this.visible,
    };
  }

  async openTab(url?: string): Promise<BrowserTabInfo> {
    if (this.tabs.size >= MAX_TABS) {
      throw new Error(`Maximum ${MAX_TABS} browser tabs reached`);
    }
    const win = this.window;
    if (!win || win.isDestroyed()) {
      throw new Error('No active window');
    }

    // Restrict to http(s) — file:// would let the sandboxed browser read
    // local files (e.g. ~/.ssh/id_rsa) via webContents.
    const targetUrl = url || DEFAULT_URL;
    try {
      const u = new URL(targetUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('Only http(s) URLs are allowed in the embedded browser');
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Only http')) throw err;
      throw new Error(`Invalid URL: ${targetUrl}`);
    }

    const id = randomUUID();
    const browserSession = session.fromPartition(BROWSER_PARTITION);

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: browserSession,
      },
    });

    const info: BrowserTabInfo = {
      id,
      url: url || DEFAULT_URL,
      title: 'New Tab',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
    };

    const eventHandler = this.wireEvents(id, view);
    this.tabs.set(id, { info, view, eventHandler });

    if (this.visible) {
      win.contentView.addChildView(view);
      view.setBounds(this.physicalBounds());
    }

    const loadUrl = url || DEFAULT_URL;
    try {
      await view.webContents.loadURL(loadUrl);
    } catch {
      // Navigation may fail for unreachable URLs; title/URL are updated via events
    }

    this.activeTabId = id;
    this.emit();
    return { ...info };
  }

  closeTab(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;

    // Remove event listeners before destroying the view to prevent memory leaks
    entry.eventHandler();

    const win = this.window;
    if (win && !win.isDestroyed()) {
      win.contentView.removeChildView(entry.view);
    }
    entry.view.webContents.close();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    this.emit();
  }

  setActiveTab(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;

    const win = this.window;
    if (!win || win.isDestroyed()) return;

    // Detach all views, then attach the active one
    for (const [, e] of this.tabs) {
      try { win.contentView.removeChildView(e.view); } catch { /* already detached */ }
    }

    if (this.visible) {
      win.contentView.addChildView(entry.view);
      entry.view.setBounds(this.physicalBounds());
    }

    this.activeTabId = tabId;
    this.emit();
  }

  async navigate(tabId: string, url: string): Promise<{ ok: boolean }> {
    const entry = this.tabs.get(tabId);
    if (!entry) return { ok: false };
    // Restrict to http(s) — see openTab for rationale.
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false };
      }
    } catch {
      return { ok: false };
    }
    try {
      await entry.view.webContents.loadURL(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  goBack(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry && entry.view.webContents.canGoBack()) {
      entry.view.webContents.goBack();
    }
  }

  goForward(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry && entry.view.webContents.canGoForward()) {
      entry.view.webContents.goForward();
    }
  }

  reload(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry) entry.view.webContents.reload();
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number; dpr: number }): void {
    this.currentBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    this.dpr = bounds.dpr || 1;

    if (!this.visible) return;
    const active = this.getActiveView();
    if (active) {
      active.setBounds(this.physicalBounds());
    }
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;

    const win = this.window;
    if (!win || win.isDestroyed()) {
      this.visible = false;
      this.emit();
      return;
    }

    if (visible) {
      // Detach all, then attach active
      for (const [, e] of this.tabs) {
        try { win.contentView.removeChildView(e.view); } catch { /* ok */ }
      }
      const active = this.getActiveView();
      if (active) {
        win.contentView.addChildView(active);
        active.setBounds(this.physicalBounds());
      }
    } else {
      for (const [, e] of this.tabs) {
        try { win.contentView.removeChildView(e.view); } catch { /* ok */ }
      }
    }
    this.emit();
  }

  async capturePage(tabId?: string): Promise<{ pngBase64: string; width: number; height: number } | null> {
    const id = tabId || this.activeTabId;
    if (!id) return null;
    const entry = this.tabs.get(id);
    if (!entry) return null;
    try {
      const img = await entry.view.webContents.capturePage();
      return {
        pngBase64: img.toPNG().toString('base64'),
        width: img.getSize().width,
        height: img.getSize().height,
      };
    } catch {
      return null;
    }
  }

  getActiveWebContents(): Electron.WebContents | null {
    const id = this.activeTabId;
    if (!id) return null;
    const entry = this.tabs.get(id);
    return entry ? entry.view.webContents : null;
  }

  async sendInputEvent(event: { type: string; x: number; y: number; button: string; clickCount?: number }): Promise<boolean> {
    const wc = this.getActiveWebContents();
    if (!wc) return false;
    try {
      // Send mouseDown then mouseUp to simulate a click
      wc.sendInputEvent({
        type: 'mouseDown',
        x: event.x,
        y: event.y,
        button: event.button as 'left' | 'middle' | 'right',
        clickCount: event.clickCount || 1,
      });
      wc.sendInputEvent({
        type: 'mouseUp',
        x: event.x,
        y: event.y,
        button: event.button as 'left' | 'middle' | 'right',
        clickCount: event.clickCount || 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  async sendKeys(text: string): Promise<boolean> {
    const wc = this.getActiveWebContents();
    if (!wc) return false;
    try {
      for (const char of text) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: char });
        wc.sendInputEvent({ type: 'keyUp', keyCode: char });
      }
      return true;
    } catch {
      return false;
    }
  }

  async sendKey(key: string, modifiers: string[]): Promise<boolean> {
    const wc = this.getActiveWebContents();
    if (!wc) return false;
    try {
      const modFlags = this.buildModifierFlags(modifiers);
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: modFlags });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      return true;
    } catch {
      return false;
    }
  }

  async scroll(_x: number, _y: number, direction: string, amount: number): Promise<boolean> {
    const wc = this.getActiveWebContents();
    if (!wc) return false;
    try {
      const deltaX = direction === 'left' ? -amount * 40 : direction === 'right' ? amount * 40 : 0;
      const deltaY = direction === 'up' ? -amount * 40 : direction === 'down' ? amount * 40 : 0;
      wc.sendInputEvent({
        type: 'mouseWheel',
        x: _x,
        y: _y,
        deltaX,
        deltaY,
      });
      return true;
    } catch {
      return false;
    }
  }

  async executeJavaScript(code: string): Promise<{ value?: unknown; error?: string }> {
    const wc = this.getActiveWebContents();
    if (!wc) return { error: 'No active browser tab' };
    try {
      const value = await wc.executeJavaScript(code);
      return { value };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPageText(selector?: string): Promise<string | null> {
    const wc = this.getActiveWebContents();
    if (!wc) return null;
    try {
      const code = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`
        : `document.body?.innerText || ''`;
      return await wc.executeJavaScript(code);
    } catch {
      return null;
    }
  }

  destroy(): void {
    const win = this.window;
    for (const [, entry] of this.tabs) {
      if (win && !win.isDestroyed()) {
        try { win.contentView.removeChildView(entry.view); } catch { /* ok */ }
      }
      try { entry.view.webContents.close(); } catch { /* ok */ }
    }
    this.tabs.clear();
    this.activeTabId = null;
    this.visible = false;
    this.listeners.clear();
  }

  // --- Private helpers ---

  private buildModifierFlags(modifiers: string[]): Array<'shift' | 'control' | 'alt' | 'meta'> {
    const flags: Array<'shift' | 'control' | 'alt' | 'meta'> = [];
    for (const m of modifiers) {
      switch (m.toLowerCase()) {
        case 'command':
        case 'cmd':
          flags.push('meta');
          break;
        case 'control':
        case 'ctrl':
          flags.push('control');
          break;
        case 'option':
        case 'alt':
          flags.push('alt');
          break;
        case 'shift':
          flags.push('shift');
          break;
      }
    }
    return flags;
  }

  private getActiveView(): WebContentsView | null {
    if (!this.activeTabId) return null;
    const entry = this.tabs.get(this.activeTabId);
    return entry ? entry.view : null;
  }

  private physicalBounds(): { x: number; y: number; width: number; height: number } {
    return {
      x: Math.round(this.currentBounds.x),
      y: Math.round(this.currentBounds.y),
      width: Math.round(this.currentBounds.width),
      height: Math.round(this.currentBounds.height),
    };
  }

  private wireEvents(tabId: string, view: WebContentsView): () => void {
    const wc = view.webContents;
    const updateInfo = () => {
      const entry = this.tabs.get(tabId);
      if (!entry) return;
      entry.info.url = wc.getURL();
      entry.info.title = wc.getTitle();
      entry.info.isLoading = wc.isLoading();
      entry.info.canGoBack = wc.canGoBack();
      entry.info.canGoForward = wc.canGoForward();
      this.emit();
    };

    wc.on('did-navigate', updateInfo);
    wc.on('did-navigate-in-page', updateInfo);
    wc.on('page-title-updated', updateInfo);
    wc.on('did-start-loading', updateInfo);
    wc.on('did-stop-loading', updateInfo);
    wc.on('did-fail-load', updateInfo);

    // Intercept window.open() to open new tabs instead of popup windows
    wc.setWindowOpenHandler(({ url }) => {
      void this.openTab(url).catch((err) => {
        console.warn('[browser-tab] openTab from window.open failed:', err);
      });
      return { action: 'deny' };
    });

    // Return cleanup function that removes all registered listeners
    return () => {
      wc.removeListener('did-navigate', updateInfo);
      wc.removeListener('did-navigate-in-page', updateInfo);
      wc.removeListener('page-title-updated', updateInfo);
      wc.removeListener('did-start-loading', updateInfo);
      wc.removeListener('did-stop-loading', updateInfo);
      wc.removeListener('did-fail-load', updateInfo);
    };
  }
}
