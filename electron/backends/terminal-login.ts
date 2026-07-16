import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergedSubprocessEnv } from '../settings-loader.js';

export async function runTerminalLogin(
  binary: string,
  args: string[],
  verify: () => Promise<{ loggedIn: boolean }>,
): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    const code = await new Promise<number | null>((resolve, reject) => {
      const proc = spawn(binary, args, { env: mergedSubprocessEnv(), stdio: 'inherit' });
      proc.once('error', reject);
      proc.once('close', resolve);
    }).catch(() => null);
    if (code !== 0) return { ok: false, error: `登录命令退出（code ${code ?? 'unknown'}）` };
    return (await verify()).loggedIn ? { ok: true } : { ok: false, error: '登录命令已结束，但未检测到有效凭据。' };
  }

  const statusPath = join(tmpdir(), `ahameet-login-${randomUUID()}.status`);
  const command = `${[binary, ...args].map(shellQuote).join(' ')}; rc=$?; printf '%s' "$rc" > ${shellQuote(statusPath)}`;
  const script = `tell application "Terminal"\nactivate\ndo script "${escapeAppleScript(command)}"\nend tell`;
  const opened = await new Promise<boolean>((resolve) => {
    const proc = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    proc.once('error', () => resolve(false));
    proc.once('close', (code) => resolve(code === 0));
  });
  if (!opened) return { ok: false, error: '无法打开 Terminal，请手动执行登录命令。' };

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const code = (await readFile(statusPath, 'utf8')).trim();
      await rm(statusPath, { force: true });
      if (code !== '0') return { ok: false, error: `登录未完成（exit ${code || 'unknown'}）` };
      return (await verify()).loggedIn ? { ok: true } : { ok: false, error: '登录命令已结束，但未检测到有效凭据。' };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await rm(statusPath, { force: true });
  return { ok: false, error: '登录等待超时，请重试。' };
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
