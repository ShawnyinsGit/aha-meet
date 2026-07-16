import { isAbsolute, relative, resolve } from 'node:path';

export interface RendererSecurityOptions {
  isDev: boolean;
  devServerUrl?: string;
}

export type RendererSecurityHeaders = Record<string, string[]>;

export function buildRendererSecurityHeaders(
  options: RendererSecurityOptions,
): RendererSecurityHeaders {
  const devOrigin = options.isDev && options.devServerUrl
    ? new URL(options.devServerUrl).origin
    : '';
  const devWsOrigin = devOrigin.replace(/^http/, 'ws');
  const csp = options.isDev
    ? [
        `default-src 'self' ${devOrigin}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}`,
        `style-src 'self' 'unsafe-inline' ${devOrigin}`,
        `img-src 'self' data: blob: ${devOrigin}`,
        `media-src 'self' blob: data: ${devOrigin}`,
        `font-src 'self' data: ${devOrigin}`,
        `connect-src 'self' ${devOrigin} ${devWsOrigin}`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        // onnxruntime-web currently compiles a generated JS/WASM bridge. Both
        // eval tokens are required by the packaged MicVAD + speaker model.
        `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `media-src 'self' blob: data:`,
        `font-src 'self' data:`,
        `connect-src 'self'`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ');

  return {
    'Content-Security-Policy': [csp],
    'X-Content-Type-Options': ['nosniff'],
    // The threaded ONNX WASM backend gates SharedArrayBuffer on isolation.
    'Cross-Origin-Opener-Policy': ['same-origin'],
    'Cross-Origin-Embedder-Policy': ['require-corp'],
  };
}

export function themeBackgroundColor(dark: boolean): string {
  return dark ? '#1c1c1e' : '#f2f2f7';
}

export function resolveAppAssetPath(bundleRoot: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'app:' || url.host !== 'bundle') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(bundleRoot, `.${requested}`);
  const withinRoot = relative(bundleRoot, target);
  if (withinRoot.startsWith('..') || isAbsolute(withinRoot)) return null;
  return target;
}
