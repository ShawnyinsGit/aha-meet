// Parses an incoming attachment payload (raw bytes + mime + name) into either
// extracted text (for documents) or a passthrough base64 image. Lives in main
// so the renderer never has to ship docx/pdf libs.

import mammoth from 'mammoth';
import { errorMessage } from '../format-error.js';

export type AttachmentKind = 'text' | 'image' | 'word' | 'pdf';

export interface RawAttachmentItem {
  name: string;
  mime: string;
  sizeBytes: number;
  dataBase64: string;
}

export interface ParsedAttachment {
  name: string;
  mime: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** Decoded raw bytes — kept for workspace fallback path. */
  buffer: Buffer;
  /** Extracted text for text/word/pdf kinds; undefined for image. */
  text?: string;
  /** Image media type ("image/png" etc.) — only set when kind === 'image'. */
  imageMediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
}

const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'yaml', 'yml', 'toml', 'ini', 'env',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'csv', 'tsv',
]);

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/x-yaml'];

const IMAGE_MIME_WHITELIST: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

export function classifyKind(name: string, mime: string): AttachmentKind | null {
  const lowerMime = (mime || '').toLowerCase();
  if (lowerMime === PDF_MIME) return 'pdf';
  if (lowerMime === WORD_MIME) return 'word';
  if (IMAGE_MIME_WHITELIST.has(lowerMime)) return 'image';
  if (TEXT_MIME_PREFIXES.some((p) => lowerMime.startsWith(p))) return 'text';

  const ext = extensionOf(name);
  if (!ext) return null;
  if (ext === 'docx') return 'word';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

function extensionOf(name: string): string | null {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

export async function parseAttachment(item: RawAttachmentItem): Promise<ParsedAttachment> {
  const buffer = Buffer.from(item.dataBase64, 'base64');
  return parseAttachmentBuffer({
    name: item.name,
    mime: item.mime,
    sizeBytes: item.sizeBytes,
    buffer,
  });
}

export interface RawAttachmentBuffer {
  name: string;
  mime: string;
  sizeBytes: number;
  buffer: Buffer;
}

/**
 * Buffer-native variant of parseAttachment: skips the base64 round-trip on
 * paths that already hold raw bytes (e.g. documents.ts reads files directly
 * with fs.readFile and never needed the encode/decode dance).
 */
export async function parseAttachmentBuffer(item: RawAttachmentBuffer): Promise<ParsedAttachment> {
  const kind = classifyKind(item.name, item.mime);
  if (!kind) {
    throw new Error(`unsupported attachment type: ${item.name} (${item.mime || 'no mime'})`);
  }
  const { buffer } = item;

  if (kind === 'text') {
    return { name: item.name, mime: item.mime, sizeBytes: item.sizeBytes, kind, buffer, text: buffer.toString('utf8') };
  }

  if (kind === 'image') {
    const mt = normalizeImageMime(item.mime, item.name);
    return { name: item.name, mime: item.mime, sizeBytes: item.sizeBytes, kind, buffer, imageMediaType: mt };
  }

  if (kind === 'word') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return { name: item.name, mime: item.mime, sizeBytes: item.sizeBytes, kind, buffer, text: result.value ?? '' };
    } catch (err: unknown) {
      throw new Error(`failed to parse word document ${item.name}: ${errorMessage(err)}`);
    }
  }

  // kind === 'pdf'
  try {
    const text = await extractPdfText(buffer);
    return { name: item.name, mime: item.mime, sizeBytes: item.sizeBytes, kind, buffer, text };
  } catch (err: unknown) {
    throw new Error(`failed to parse pdf ${item.name}: ${errorMessage(err)}`);
  }
}

function normalizeImageMime(mime: string, name: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const m = (mime || '').toLowerCase();
  if (m === 'image/png') return 'image/png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/webp') return 'image/webp';
  const ext = extensionOf(name);
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

// pdfjs ships an ESM-only build; load it lazily so a renderer-driven
// "only docx today" session never pays the parse cost.
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

async function extractPdfText(buffer: Buffer): Promise<string> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  const pdfjs = await pdfjsPromise;
  // No worker on the Node side — the legacy build supports synchronous fallback.
  // GlobalWorkerOptions.workerSrc must be left empty; we set disableWorker via loadingTask opts.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it: unknown) => {
        if (typeof it === 'object' && it !== null && 'str' in it) {
          return (it as { str: string }).str;
        }
        return '';
      })
      .join('');
    pages.push(`--- page ${i} ---\n${pageText}`);
  }
  try { await doc.cleanup(); } catch { /* ignore */ }
  try { await doc.destroy(); } catch { /* ignore */ }
  return pages.join('\n\n');
}

export function formatInlineTextBlock(p: ParsedAttachment): string {
  const sizeLabel = formatBytes(p.sizeBytes);
  const header = `--- attached: ${p.name} (${p.kind}, ${sizeLabel}) ---`;
  const footer = `--- end ${p.name} ---`;
  const body = (p.text ?? '').trim();
  if (!body) {
    return `${header}\n[empty — likely a scanned PDF or unsupported encoding; if you need its content, ask the user to provide an OCR'd version or an image.]\n${footer}`;
  }
  return `${header}\n${body}\n${footer}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
