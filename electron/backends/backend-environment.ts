// Provider-neutral subprocess environment. Backend credentials are deliberately
// absent here and must be added by the owning adapter after this function
// returns. This prevents a Claude-derived meeting environment from leaking
// ANTHROPIC_* values into Codex, Kimi, Qoder, or custom backend processes.

const SAFE_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'USER', 'USERNAME', 'LOGNAME',
  'SHELL', 'ComSpec', 'SYSTEMROOT', 'SystemRoot',
  'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LANGUAGE',
  'TERM', 'COLORTERM',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
]);

function copySafe(source: NodeJS.ProcessEnv | undefined, target: NodeJS.ProcessEnv): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (SAFE_KEYS.has(key) && typeof value === 'string') target[key] = value;
  }
}

export function isolatedSubprocessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copySafe(process.env, env);
  copySafe(extra, env);
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  if (!env.LC_ALL) env.LC_ALL = env.LANG;
  if (!env.TERM) env.TERM = 'xterm-256color';
  return env;
}
