// electron-builder afterPack hook.
//
// Re-signs the bundled whisper.cpp helpers (whisper-cli, whisper-server, and
// their colocated .dylib/.so dependencies) with a Developer ID Application
// certificate, hardened runtime, and the helper entitlements plist. This is
// required for notarization — extraResources land in the bundle ad-hoc signed,
// and notarytool rejects ad-hoc executables inside a Developer-ID-signed app.
//
// Identity is read from $APPLE_HELPER_IDENTITY (preferred), then $CSC_NAME,
// then the mac.identity configured in electron-builder.json. If none is set
// the hook logs a warning and skips re-signing — useful for local dev builds
// that won't be notarized.
//
// Timestamping is enabled by default (required for notarize). Set
// $SKIP_NOTARIZE_TIMESTAMP=1 for offline builds.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELPER_BINARIES = ['whisper-cli', 'whisper-server'];
const ENTITLEMENTS_REL = 'build/entitlements.whisper.plist';

function log(msg) {
  process.stdout.write(`[sign-helpers] ${msg}\n`);
}

function resolveIdentity(context) {
  if (process.env.APPLE_HELPER_IDENTITY) return process.env.APPLE_HELPER_IDENTITY;
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  const macCfg = context?.packager?.platformSpecificBuildOptions;
  if (macCfg?.identity && macCfg.identity !== null) return macCfg.identity;
  return null;
}

function codesign(target, identity, entitlements, withTimestamp) {
  const args = ['--force', '--options', 'runtime', '--sign', identity];
  if (withTimestamp) args.push('--timestamp');
  else args.push('--timestamp=none');
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(target);
  const r = spawnSync('codesign', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`codesign failed for ${target}: ${r.stderr || r.stdout}`);
  }
}

function signTree(whisperDir, identity, entitlements, withTimestamp) {
  const entries = readdirSync(whisperDir);

  // Sign leaf libraries first; binaries reference them so the binary's signed
  // hash must include the post-resign library hashes.
  const libs = entries.filter((f) => f.endsWith('.dylib') || f.endsWith('.so'));
  for (const lib of libs) {
    const fp = join(whisperDir, lib);
    if (!statSync(fp).isFile()) continue;
    codesign(fp, identity, null, withTimestamp);
    log(`signed lib ${lib}`);
  }

  for (const name of HELPER_BINARIES) {
    const fp = join(whisperDir, name);
    if (!existsSync(fp)) {
      log(`warn: ${name} not present under ${whisperDir} — skip`);
      continue;
    }
    codesign(fp, identity, entitlements, withTimestamp);
    log(`signed binary ${name}`);
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    log(`skip: platform=${context.electronPlatformName}`);
    return;
  }

  const identity = resolveIdentity(context);
  if (!identity) {
    log('warn: no signing identity available (set APPLE_HELPER_IDENTITY); leaving helpers ad-hoc signed');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const whisperDir = join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'whisper');
  if (!existsSync(whisperDir)) {
    log(`warn: ${whisperDir} not found — nothing to sign`);
    return;
  }

  const entitlements = join(context.packager.projectDir, ENTITLEMENTS_REL);
  if (!existsSync(entitlements)) {
    throw new Error(`entitlements plist missing at ${entitlements}`);
  }

  const withTimestamp = process.env.SKIP_NOTARIZE_TIMESTAMP !== '1';
  log(`identity=${identity} timestamp=${withTimestamp} dir=${whisperDir}`);
  signTree(whisperDir, identity, entitlements, withTimestamp);
  log('done');
}
