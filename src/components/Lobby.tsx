import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Clock, FolderOpen, KeyRound, LogIn, Mic, MonitorUp } from 'lucide-react';
import { meetingStore } from '../lib/meeting-store';

interface LobbyProps {
  lastError?: string | null;
}

type AuthMode = 'apikey' | 'subscription' | null;

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function shortPath(cwd: string): { label: string; parent: string } {
  const parts = cwd.split('/').filter(Boolean);
  const label = parts[parts.length - 1] ?? cwd;
  const parent = parts.slice(0, -1).join('/');
  return { label, parent: parent ? `/${parent}/` : '/' };
}

export function Lobby({ lastError }: LobbyProps) {
  const lobby = useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getLobbyData);

  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [subscriptionLoggedIn, setSubscriptionLoggedIn] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loginStatus, setLoginStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [loginError, setLoginError] = useState<string>('');
  const apiKeyRef = useRef<HTMLInputElement>(null);

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    window.vibeMeet.auth.getConfig().then((cfg) => {
      setAuthMode(cfg.authMode);
      setHasApiKey(cfg.hasApiKey);
    });
    window.vibeMeet.auth.checkSubscriptionStatus().then((s) => {
      setSubscriptionLoggedIn(s.loggedIn);
    });
  }, []);

  const openCwd = useCallback(async (cwd: string) => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const res = await meetingStore.openSession(cwd);
      if (!res.ok) setOpenError(res.error ?? 'Failed to open meeting');
    } finally {
      setOpening(false);
    }
  }, [opening]);

  const pickAndOpen = useCallback(async () => {
    const dir = await window.vibeMeet.pickCwd();
    if (!dir) return;
    await openCwd(dir);
  }, [openCwd]);

  const saveApiKey = useCallback(async () => {
    setApiKeyStatus('saving');
    const res = await window.vibeMeet.auth.setApiKey(apiKeyInput);
    if (res.ok) {
      setApiKeyStatus('saved');
      setHasApiKey(apiKeyInput.trim().length > 0);
      setAuthMode(apiKeyInput.trim().length > 0 ? 'apikey' : null);
      setTimeout(() => setApiKeyStatus('idle'), 2000);
    } else {
      setApiKeyStatus('error');
    }
  }, [apiKeyInput]);

  const loginSubscription = useCallback(async () => {
    setLoginStatus('pending');
    setLoginError('');
    const res = await window.vibeMeet.auth.loginSubscription();
    if (res.ok) {
      setLoginStatus('done');
      setAuthMode('subscription');
      setHasApiKey(false);
      window.vibeMeet.auth.checkSubscriptionStatus().then((s) => {
        setSubscriptionLoggedIn(s.loggedIn);
      });
    } else {
      setLoginStatus('error');
      setLoginError(res.error ?? 'Login failed');
    }
  }, []);

  const authLabel = authMode === 'apikey'
    ? (hasApiKey ? 'API Key ✓' : 'API Key')
    : authMode === 'subscription'
    ? (subscriptionLoggedIn ? 'Claude Account ✓' : 'Claude Account')
    : 'Not configured';

  return (
    <div className="join-screen">
      <div className="join-card lobby-card">
        <div className="join-brand">
          <div className="join-logo">
            <img src="icon-96.png" alt="AhaMeet" className="join-logo-img" />
          </div>
          <div>
            <div className="join-title">AhaMeet</div>
            <div className="join-sub">Pair with Claude over screen + voice</div>
          </div>
        </div>

        <div className="join-auth-section">
          <button
            type="button"
            className="join-auth-toggle"
            onClick={() => setAuthOpen((v) => !v)}
          >
            <KeyRound size={14} aria-hidden="true" />
            <span>Claude authentication — {authLabel}</span>
            <ChevronDown size={14} className={authOpen ? 'join-auth-chevron open' : 'join-auth-chevron'} />
          </button>

          {authOpen && (
            <div className="join-auth-body">
              <p className="join-auth-desc">
                Choose how AhaMeet connects to Claude. Use an API key for programmatic access,
                or log in with your Claude.ai subscription account.
              </p>

              <div className="join-auth-block">
                <div className="join-auth-block-title">
                  <KeyRound size={13} aria-hidden="true" /> API Key
                  {authMode === 'apikey' && hasApiKey && <span className="join-auth-badge active">Active</span>}
                </div>
                <div className="join-auth-row">
                  <input
                    ref={apiKeyRef}
                    type="password"
                    className="join-auth-input"
                    placeholder={hasApiKey ? '••••••••••••••••••••••' : 'sk-ant-...'}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveApiKey()}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="join-auth-btn"
                    onClick={saveApiKey}
                    disabled={apiKeyStatus === 'saving'}
                  >
                    {apiKeyStatus === 'saving' ? 'Saving…'
                      : apiKeyStatus === 'saved' ? 'Saved ✓'
                      : 'Save'}
                  </button>
                </div>
                {apiKeyStatus === 'error' && (
                  <div className="join-auth-error">Failed to save key.</div>
                )}
                {hasApiKey && authMode === 'apikey' && (
                  <div className="join-auth-hint">
                    Leave blank and save to remove the stored key.
                  </div>
                )}
              </div>

              <div className="join-auth-block">
                <div className="join-auth-block-title">
                  <LogIn size={13} aria-hidden="true" /> Claude Account (Pro/Max)
                  {authMode === 'subscription' && subscriptionLoggedIn && (
                    <span className="join-auth-badge active">Active</span>
                  )}
                </div>
                <button
                  type="button"
                  className="join-auth-btn join-auth-btn-login"
                  onClick={loginSubscription}
                  disabled={loginStatus === 'pending'}
                >
                  {loginStatus === 'pending' ? 'Opening browser…'
                    : loginStatus === 'done' ? 'Logged in ✓'
                    : subscriptionLoggedIn ? 'Re-authenticate'
                    : 'Log in with Claude'}
                </button>
                {loginStatus === 'error' && (
                  <div className="join-auth-error">{loginError || 'Login failed.'}</div>
                )}
                <div className="join-auth-hint">
                  Opens a browser window for OAuth. Requires Claude CLI bundled with this app.
                </div>
              </div>
            </div>
          )}
        </div>

        {lobby.recent.length > 0 && (
          <section className="lobby-section">
            <div className="lobby-section-title">
              <Clock size={13} aria-hidden="true" />
              <span>Recent meetings</span>
            </div>
            <ul className="lobby-list">
              {lobby.recent.map((r) => {
                const { label, parent } = shortPath(r.path);
                return (
                  <li key={r.path}>
                    <button
                      type="button"
                      className="lobby-row"
                      onClick={() => openCwd(r.path)}
                      disabled={opening}
                      title={r.path}
                    >
                      <span className="lobby-row-icon" aria-hidden="true">
                        <FolderOpen size={16} />
                      </span>
                      <span className="lobby-row-main">
                        <span className="lobby-row-name">{label}</span>
                        <span className="lobby-row-path">{parent}</span>
                      </span>
                      <span className="lobby-row-meta">{formatRelative(r.lastOpenedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {(lastError || openError) && (
          <div className="join-error">{openError ?? lastError}</div>
        )}

        <button
          type="button"
          className="join-cta lobby-cta"
          onClick={pickAndOpen}
          disabled={opening}
        >
          <FolderOpen size={16} aria-hidden="true" />
          <span>{opening ? 'Opening…' : 'Open another folder'}</span>
        </button>

        <div className="join-hints">
          <span className="join-hint-item"><Mic size={14} aria-hidden="true" /> Voice on by default</span>
          <span className="join-hint-sep">·</span>
          <span className="join-hint-item"><MonitorUp size={14} aria-hidden="true" /> Manual screen snapshots</span>
          <span className="join-hint-sep">·</span>
          <span className="join-hint-item">⌥ Interrupt anytime</span>
        </div>
      </div>
    </div>
  );
}
