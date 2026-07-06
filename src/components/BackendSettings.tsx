// BackendSettings.tsx — per-CLI-backend auth configuration panel.
//
// Displays a card for each registered CLI backend (Claude Code, Codex, Kimi,
// Qoder) with auth status, API key input, base URL, model selector, and
// a "set as default" toggle. Only shown in the SettingsWindow.

import { useCallback, useEffect, useState } from 'react';
import type { BackendInfo } from '../types';

export function BackendSettings() {
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingApiKey, setEditingApiKey] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.vibeMeet.backendAuth.list();
      setBackends(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSetApiKey = useCallback(async (backendId: string) => {
    const key = editingApiKey[backendId] ?? '';
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setApiKey(backendId, key);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save API key');
      } else {
        setEditingApiKey((e) => { const next = { ...e }; delete next[backendId]; return next; });
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [editingApiKey, reload]);

  const handleSetBaseUrl = useCallback(async (backendId: string, url: string) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setBaseUrl(backendId, url);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save base URL');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleSetModel = useCallback(async (backendId: string, model: string) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setModel(backendId, model);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save model');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleSetDefault = useCallback(async (backendId: string) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setDefault(backendId);
      if (!r.ok) {
        setError(r.error ?? 'Failed to set default');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, backendId: string) => {
    if (e.key === 'Enter') {
      void handleSetApiKey(backendId);
    }
  }, [handleSetApiKey]);

  if (loading) {
    return <div className="backend-settings-loading">加载中…</div>;
  }

  return (
    <div className="backend-settings">
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">后端管理 · Backends</div>
          <div className="drawer-settings-hint">
            配置各 CLI 后端的认证信息。已认证的后端可作为会议 Host 使用。
          </div>
        </div>
      </div>

      {error && (
        <div className="backend-settings-error">
          <span>✕ {error}</span>
          <button type="button" className="backend-settings-error-dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="backend-settings-list">
        {backends.map((b) => (
          <BackendCard
            key={b.id}
            backend={b}
            editingApiKey={editingApiKey[b.id] ?? ''}
            saving={saving[b.id] ?? false}
            onApiKeyChange={(val) => setEditingApiKey((e) => ({ ...e, [b.id]: val }))}
            onSaveApiKey={() => handleSetApiKey(b.id)}
            onSaveBaseUrl={(url) => handleSetBaseUrl(b.id, url)}
            onSaveModel={(model) => handleSetModel(b.id, model)}
            onSetDefault={() => handleSetDefault(b.id)}
            onKeyDown={(e) => handleKeyDown(e, b.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface BackendCardProps {
  backend: BackendInfo;
  editingApiKey: string;
  saving: boolean;
  onApiKeyChange: (val: string) => void;
  onSaveApiKey: () => void;
  onSaveBaseUrl: (url: string) => void;
  onSaveModel: (model: string) => void;
  onSetDefault: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

function BackendCard({
  backend: b,
  editingApiKey,
  saving,
  onApiKeyChange,
  onSaveApiKey,
  onSaveBaseUrl,
  onSaveModel,
  onSetDefault,
  onKeyDown,
}: BackendCardProps) {
  const hasAuth = b.hasApiKey || b.authMode !== 'none';

  return (
    <div className={`backend-card ${b.isDefault ? 'backend-card-default' : ''} ${!b.available ? 'backend-card-unavailable' : ''}`}>
      <div className="backend-card-header">
        <div className="backend-card-icon">
          <BackendIcon iconId={b.iconId} />
        </div>
        <div className="backend-card-info">
          <div className="backend-card-name">{b.displayName}</div>
          <div className="backend-card-status">
            <span className={`backend-status-dot ${hasAuth ? 'status-ok' : 'status-none'}`} />
            {hasAuth ? '已配置' : '未配置'}
            {b.isDefault && <span className="backend-default-badge">默认</span>}
            {!b.available && <span className="backend-unavailable-badge">未安装</span>}
          </div>
        </div>
        <div className="backend-card-actions">
          {!b.isDefault && b.available && (
            <button
              type="button"
              className="backend-btn backend-btn-sm"
              onClick={onSetDefault}
              disabled={saving}
            >
              设为默认
            </button>
          )}
        </div>
      </div>

      {b.available && (
        <div className="backend-card-body">
          <div className="backend-field">
            <label className="backend-field-label">API Key</label>
            <div className="backend-field-row">
              <input
                className="backend-field-input"
                type="password"
                value={editingApiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={b.hasApiKey ? '已保存 (输入新值覆盖)' : '输入 API Key'}
                disabled={saving}
              />
              <button
                type="button"
                className="backend-btn backend-btn-sm"
                onClick={onSaveApiKey}
                disabled={saving || editingApiKey.length === 0}
              >
                {saving ? '…' : '保存'}
              </button>
            </div>
          </div>

          <div className="backend-field">
            <label className="backend-field-label">Base URL</label>
            <input
              className="backend-field-input"
              type="text"
              defaultValue={b.baseUrl ?? ''}
              onBlur={(e) => {
                if (e.target.value !== (b.baseUrl ?? '')) {
                  onSaveBaseUrl(e.target.value);
                }
              }}
              placeholder="https://api.example.com/v1"
              disabled={saving}
            />
          </div>

          <div className="backend-field">
            <label className="backend-field-label">Model</label>
            {b.models && b.models.length > 0 ? (
              <select
                className="backend-field-select"
                defaultValue={b.model ?? b.defaultModel ?? ''}
                onChange={(e) => onSaveModel(e.target.value)}
                disabled={saving}
              >
                <option value="">默认 ({b.defaultModel ?? 'auto'})</option>
                {b.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                className="backend-field-input"
                type="text"
                defaultValue={b.model ?? ''}
                onBlur={(e) => {
                  if (e.target.value !== (b.model ?? '')) {
                    onSaveModel(e.target.value);
                  }
                }}
                placeholder={b.defaultModel ?? '默认模型'}
                disabled={saving}
              />
            )}
          </div>

          <div className="backend-card-caps">
            {b.supportsMcp && <span className="backend-cap-badge">MCP</span>}
            {b.supportsPermissions && <span className="backend-cap-badge">权限流</span>}
          </div>
        </div>
      )}

      {!b.available && b.installHint && (
        <div className="backend-card-install">
          <code>{b.installHint}</code>
        </div>
      )}
    </div>
  );
}

function BackendIcon({ iconId }: { iconId: string }) {
  switch (iconId) {
    case 'claude':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-6h2v6zm0-8H9V7h6v2z"/>
        </svg>
      );
    case 'codex':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
        </svg>
      );
    case 'kimi':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/>
        </svg>
      );
    case 'qoder':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M7 5h10v2H7V5zm0 4h10v2H7V9zm0 4h7v2H7v-2zm-4 6l4-4v3h10v2H3v-1z"/>
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <circle cx="12" cy="12" r="10"/>
        </svg>
      );
  }
}
