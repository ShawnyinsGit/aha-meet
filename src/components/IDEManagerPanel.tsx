// IDEManagerPanel — settings panel for managing AI IDE backends.
// Shows installed IDEs, available IDEs, and lets the user switch the default
// IDE used for independent editor windows.

import { useEffect, useState } from 'react';
import { Check, Download, Settings, Star } from 'lucide-react';

interface IDEInfo {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  version?: string;
  isDefault: boolean;
  iconId: string;
}

const AVAILABLE_IDES: IDEInfo[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    description: '开源 AI coding agent，terminal + desktop + IDE',
    installed: true,
    isDefault: true,
    iconId: 'opencode',
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    description: 'Nous Research 开源 CLI agent，自我改进技能',
    installed: false,
    isDefault: false,
    iconId: 'hermes',
  },
  {
    id: 'pi',
    name: 'Pi Agent',
    description: '极简 agent harness，轻量可扩展',
    installed: false,
    isDefault: false,
    iconId: 'pi',
  },
];

export function IDEManagerPanel() {
  const [ides, setIdes] = useState<IDEInfo[]>(AVAILABLE_IDES);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    // TODO: load actual installed state from backend registry
    // For now, use static data
  }, []);

  const handleSetDefault = (id: string) => {
    setIdes((prev) =>
      prev.map((ide) => ({
        ...ide,
        isDefault: ide.id === id,
      })),
    );
    // TODO: persist to settings
  };

  const handleInstall = async (id: string) => {
    setInstalling(id);
    // TODO: trigger actual installation
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setIdes((prev) =>
      prev.map((ide) =>
        ide.id === id ? { ...ide, installed: true } : ide,
      ),
    );
    setInstalling(null);
  };

  const installedIdes = ides.filter((ide) => ide.installed);
  const availableIdes = ides.filter((ide) => !ide.installed);
  const defaultIde = ides.find((ide) => ide.isDefault);

  return (
    <section className="ide-manager-panel">
      <div className="ide-manager-header">
        <h2 className="ide-manager-title">IDE 管理</h2>
        <p className="ide-manager-desc">
          管理用于独立编辑器窗口的 AI IDE。点击数字员工的"详情"按钮时，将使用默认 IDE 打开编辑器。
        </p>
      </div>

      {/* Current default */}
      {defaultIde && (
        <div className="ide-manager-current">
          <div className="ide-manager-current-label">当前默认 IDE</div>
          <div className="ide-manager-ide-card ide-manager-ide-card-default">
            <div className="ide-manager-ide-icon">
              <Star size={20} />
            </div>
            <div className="ide-manager-ide-info">
              <div className="ide-manager-ide-name">{defaultIde.name}</div>
              <div className="ide-manager-ide-desc">{defaultIde.description}</div>
            </div>
            <div className="ide-manager-ide-badge ui-badge ui-badge-accent">默认</div>
          </div>
        </div>
      )}

      {/* Installed IDEs */}
      <div className="ide-manager-section">
        <div className="ide-manager-section-title">已安装 IDE</div>
        {installedIdes.length === 0 ? (
          <div className="ide-manager-empty">暂无已安装 IDE</div>
        ) : (
          <div className="ide-manager-list">
            {installedIdes.map((ide) => (
              <div key={ide.id} className="ide-manager-ide-card">
                <div className="ide-manager-ide-icon">
                  <Settings size={20} />
                </div>
                <div className="ide-manager-ide-info">
                  <div className="ide-manager-ide-name">{ide.name}</div>
                  <div className="ide-manager-ide-desc">{ide.description}</div>
                </div>
                {ide.isDefault ? (
                  <div className="ide-manager-ide-badge ui-badge ui-badge-accent">默认</div>
                ) : (
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    onClick={() => handleSetDefault(ide.id)}
                  >
                    设为默认
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Available IDEs */}
      <div className="ide-manager-section">
        <div className="ide-manager-section-title">可安装 IDE</div>
        {availableIdes.length === 0 ? (
          <div className="ide-manager-empty">暂无可安装 IDE</div>
        ) : (
          <div className="ide-manager-list">
            {availableIdes.map((ide) => (
              <div key={ide.id} className="ide-manager-ide-card">
                <div className="ide-manager-ide-icon">
                  <Download size={20} />
                </div>
                <div className="ide-manager-ide-info">
                  <div className="ide-manager-ide-name">{ide.name}</div>
                  <div className="ide-manager-ide-desc">{ide.description}</div>
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-primary"
                  onClick={() => handleInstall(ide.id)}
                  disabled={installing === ide.id}
                >
                  {installing === ide.id ? '安装中...' : '安装'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="ide-manager-info">
        <Check size={14} />
        <span>OpenCode 已内置打包，无需额外安装。Hermes Agent 和 Pi Agent 将在后续版本支持。</span>
      </div>
    </section>
  );
}
