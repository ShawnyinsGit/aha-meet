import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillInfo } from '../types';

type InstallResult = { type: 'success'; skill: SkillInfo } | { type: 'error'; message: string } | null;

export function SkillManagerPanel() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<InstallResult>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.vibeMeet.skills.list();
      console.log('[SkillManager] reload result:', r);
      if (!mountedRef.current) return;
      if (r.ok) {
        setSkills(r.skills);
      } else {
        setError(r.error);
      }
    } catch (err) {
      console.error('[SkillManager] reload error:', err);
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Auto-clear install result after 5 seconds
  useEffect(() => {
    if (!installResult) return;
    const timer = setTimeout(() => {
      if (mountedRef.current) setInstallResult(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [installResult]);

  const handleInstall = useCallback(async () => {
    const source = installSource.trim();
    if (!source) return;
    setInstalling(true);
    setError(null);
    setInstallResult(null);
    try {
      const r = await window.vibeMeet.skills.install(source);
      console.log('[SkillManager] install result:', r);
      if (r.ok) {
        setInstallResult({ type: 'success', skill: r.skill });
        setInstallSource('');
        // Wait longer for filesystem to fully flush before scanning again
        await new Promise((res) => setTimeout(res, 800));
        if (mountedRef.current) await reload();
      } else {
        setInstallResult({ type: 'error', message: r.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SkillManager] install error:', err);
      if (mountedRef.current) {
        setInstallResult({ type: 'error', message: msg });
        setError(msg);
      }
    } finally {
      if (mountedRef.current) setInstalling(false);
    }
  }, [installSource, reload]);

  const handleUninstall = useCallback(async (name: string) => {
    setError(null);
    try {
      const r = await window.vibeMeet.skills.uninstall(name);
      if (!mountedRef.current) return;
      if (r.ok) {
        setConfirmDelete(null);
        await reload();
      } else {
        setError(r.error);
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [reload]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !installing) {
      void handleInstall();
    }
  }, [handleInstall, installing]);

  return (
    <div className="drawer-settings skill-panel">
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">技能管理 · Skills</div>
          <div className="drawer-settings-hint">
            安装或卸载 Skill,Worker Agent 会自动使用已安装的技能来完成工作。
          </div>
        </div>
      </div>

      <div className="skill-install-form">
        <input
          className="skill-install-input"
          type="text"
          value={installSource}
          onChange={(e) => setInstallSource(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入 Skill 链接 (GitHub/HTTP) 或本地路径"
          disabled={installing}
        />
        <button
          type="button"
          className="skill-install-btn"
          onClick={() => void handleInstall()}
          disabled={installing || installSource.trim().length === 0}
        >
          {installing ? '安装中…' : '安装'}
        </button>
      </div>

      {installResult && (
        <div className={`skill-install-result skill-install-result-${installResult.type}`}>
          {installResult.type === 'success' ? (
            <span>✓ 安装成功: <strong>{installResult.skill.name}</strong></span>
          ) : (
            <span>✕ 安装失败: {installResult.message}</span>
          )}
          <button
            type="button"
            className="skill-install-result-dismiss"
            onClick={() => setInstallResult(null)}
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      <div className="skill-meta">
        <span>{loading ? '加载中…' : `${skills.length} 个技能`}</span>
        {error && <span className="skill-error">· {error}</span>}
      </div>

      <div className="skill-list">
        {skills.length === 0 && !loading ? (
          <div className="skill-empty">暂无技能</div>
        ) : (
          skills.map((s) => (
            <div key={s.name} className="skill-item">
              <div className="skill-item-main">
                <span className="skill-item-name">{s.name}</span>
                <span className="skill-item-source">{s.source === 'bundled' ? '内置' : '已安装'}</span>
              </div>
              {s.description && (
                <div className="skill-item-desc">{s.description}</div>
              )}
              <div className="skill-item-actions">
                {s.source === 'user' ? (
                  confirmDelete === s.name ? (
                    <>
                      <button
                        type="button"
                        className="skill-btn skill-btn-danger"
                        onClick={() => void handleUninstall(s.name)}
                      >
                        确认卸载
                      </button>
                      <button
                        type="button"
                        className="skill-btn"
                        onClick={() => setConfirmDelete(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="skill-btn"
                      onClick={() => setConfirmDelete(s.name)}
                    >
                      卸载
                    </button>
                  )
                ) : (
                  <span className="skill-item-readonly">内置技能</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
