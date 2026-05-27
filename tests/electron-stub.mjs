// Loader hook that stubs `import 'electron'` for tests run under plain Node.
// Orchestrator → memory.ts → store.ts pulls in `electron.app.getPath()`; we
// only need a no-op shim that the test never actually exercises (the test
// stops before any code path that touches userData).

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const stubUrl = pathToFileURL(
  resolvePath(dirname(fileURLToPath(import.meta.url)), 'electron-stub-impl.mjs'),
).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: stubUrl, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
