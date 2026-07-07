// React hook for the embedded browser.
// Subscribes to browserStore and manages bounds synchronization via
// ResizeObserver on the viewport container.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { browserStore } from '../lib/browser-store';

export function useBrowser() {
  const state = useSyncExternalStore(browserStore.subscribe, browserStore.getSnapshot);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Use a ref for `state.visible` so the syncBounds callback (which has
  // empty deps for stability) always reads the current value instead of
  // a stale closure capture.
  const visibleRef = useRef(state.visible);
  useEffect(() => { visibleRef.current = state.visible; }, [state.visible]);

  const syncBounds = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Skip bounds sync when browser overlay is hidden — prevents race where
    // setBounds repositions the WebContentsView after setVisible(false) was
    // sent but before the main process has processed it.
    if (!visibleRef.current) return;
    const rect = el.getBoundingClientRect();
    // The viewport div's position relative to the window content area.
    // Electron's WebContentsView uses coordinates relative to the BrowserWindow's
    // content area. Since the renderer's HTML starts at (0,0) of the content
    // area, getBoundingClientRect() gives us the right values.
    browserStore.setBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1,
    });
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    // Sync bounds on resize and window move
    const observer = new ResizeObserver(() => {
      // Defer bounds sync until after layout settles — prevents race where
      // gallery expansion triggers ResizeObserver before the browser has
      // finished recalculating the viewport's position.
      requestAnimationFrame(syncBounds);
    });
    observer.observe(el);

    // Also sync on window resize (covers window-level layout changes)
    const onResize = () => syncBounds();
    window.addEventListener('resize', onResize);

    // Initial sync after a frame to ensure layout is settled
    requestAnimationFrame(syncBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [syncBounds, state.visible]);

  const openTab = useCallback((url?: string) => browserStore.openTab(url), []);
  const closeTab = useCallback((tabId: string) => browserStore.closeTab(tabId), []);
  const setActiveTab = useCallback((tabId: string) => browserStore.setActiveTab(tabId), []);
  const navigate = useCallback((tabId: string, url: string) => browserStore.navigate(tabId, url), []);
  const goBack = useCallback((tabId: string) => browserStore.goBack(tabId), []);
  const goForward = useCallback((tabId: string) => browserStore.goForward(tabId), []);
  const reload = useCallback((tabId: string) => browserStore.reload(tabId), []);
  const toggleVisible = useCallback(() => browserStore.toggleVisible(), []);

  return {
    state,
    viewportRef,
    openTab,
    closeTab,
    setActiveTab,
    navigate,
    goBack,
    goForward,
    reload,
    toggleVisible,
  };
}
