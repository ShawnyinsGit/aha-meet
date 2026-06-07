import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve as pathResolve, sep } from 'node:path';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const UNSAFE_RE = /[/\\:*?"<>|]/g;
const CTRL_RE = /[\x00-\x1f\x7f]/g;

function sanitizeTitle(raw: string): string {
  let name = raw.replace(UNSAFE_RE, '-').replace(CTRL_RE, '').trim();
  if (name.length > 60) name = name.slice(0, 60);
  if (!name) name = `delivery-${Date.now()}`;
  return name;
}

export function snapshotDeliveryFilesSync(
  cwd: string,
  title: string,
  absolutePaths: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (absolutePaths.length === 0) return result;

  const destDir = pathResolve(cwd, 'deliveries', sanitizeTitle(title));
  const resolvedCwd = pathResolve(cwd);

  for (const absPath of absolutePaths) {
    try {
      if (!isAbsolute(absPath)) continue;
      const resolved = pathResolve(absPath);

      const normalised = resolved + sep;
      const cwdNormalised = resolvedCwd + sep;
      if (!normalised.startsWith(cwdNormalised) && resolved !== resolvedCwd) {
        console.warn('[delivery-snapshot] skipping file outside cwd:', absPath);
        continue;
      }

      let stat;
      try {
        stat = statSync(resolved);
      } catch {
        console.warn('[delivery-snapshot] file not found:', absPath);
        continue;
      }
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        console.warn('[delivery-snapshot] skipping large file:', absPath, stat.size);
        continue;
      }

      const rel = relative(resolvedCwd, resolved);
      const snapshotRel = `deliveries/${sanitizeTitle(title)}/${rel}`;
      const dest = pathResolve(destDir, rel);

      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(resolved, dest);
      result.set(absPath, snapshotRel);
    } catch (err) {
      console.warn('[delivery-snapshot] copy failed for', absPath, err);
    }
  }

  return result;
}
