// Browser toolbar: address bar, navigation controls, and tab strip.
// Sits at the top of the browser stage area, above the WebContentsView overlay.

import { useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
} from 'lucide-react';
import type { BrowserTabInfo } from '../types';

interface BrowserToolbarProps {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  onOpenTab: () => void;
  onCloseTab: (id: string) => void;
  onSetActive: (id: string) => void;
  onNavigate: (tabId: string, url: string) => void;
  onBack: (tabId: string) => void;
  onForward: (tabId: string) => void;
  onReload: (tabId: string) => void;
}

const ICON = 16;

export function BrowserToolbar({
  tabs,
  activeTabId,
  onOpenTab,
  onCloseTab,
  onSetActive,
  onNavigate,
  onBack,
  onForward,
  onReload,
}: BrowserToolbarProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const [urlInput, setUrlInput] = useState('');
  const [focused, setFocused] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!activeTabId) return;
    let url = urlInput.trim();
    if (!url) return;
    // Auto-prefix https:// if no scheme
    if (!/^https?:\/\//i.test(url) && !url.startsWith('localhost') && !url.includes('://')) {
      if (url.includes('.') && !url.includes(' ')) {
        url = `https://${url}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }
    onNavigate(activeTabId, url);
  };

  // Sync URL input when active tab changes
  const displayUrl = activeTab?.url ?? '';
  const inputVal = focused ? urlInput : displayUrl;

  return (
    <div className="browser-toolbar">
      {/* Navigation bar — tabs are managed by the stage tab bar above */}
      <div className="browser-navbar">
        <button
          className="browser-nav-btn"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTabId && onBack(activeTabId)}
          title="Back"
        >
          <ArrowLeft size={ICON} />
        </button>
        <button
          className="browser-nav-btn"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTabId && onForward(activeTabId)}
          title="Forward"
        >
          <ArrowRight size={ICON} />
        </button>
        <button
          className="browser-nav-btn"
          disabled={!activeTab}
          onClick={() => activeTabId && onReload(activeTabId)}
          title="Reload"
        >
          <RotateCw size={ICON} />
        </button>

        <form className="browser-url-form" onSubmit={handleSubmit}>
          <input
            className="browser-url-input"
            type="text"
            value={inputVal}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={() => { setFocused(true); setUrlInput(displayUrl); }}
            onBlur={() => setFocused(false)}
            placeholder="Search or enter URL"
            spellCheck={false}
          />
        </form>
      </div>
    </div>
  );
}
