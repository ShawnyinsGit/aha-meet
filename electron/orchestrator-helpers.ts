// orchestrator-helpers.ts — stateless utilities and shared constants pulled
// out of orchestrator.ts so the class file stays focused on lifecycle and
// state. Anything here is pure (no I/O, no module-level mutables) and
// safe to import from worker/talker submodules.

import type { WorkerSpecialtyKind } from './orchestrator-types.js';

// File-edit collision tracking.
export const FILE_COLLISION_WINDOW_MS = 30_000;
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

// Per-session cap on save_memory tool calls. Prevents a runaway agent from
// flooding memory.json mid-meeting; the end-of-meeting recap is a separate
// path that runs once and is bounded by the recap prompt itself.
export const SAVE_MEMORY_PER_SESSION_LIMIT = 20;
export const MEMORY_TOKEN_BUDGET = 800;
export const RECAP_TRANSCRIPT_CHAR_CAP = 12_000;
export const RECAP_MIN_TRANSCRIPT_ENTRIES = 4;

// Sliding-window cap on the in-memory talker transcript. Long meetings would
// otherwise accumulate every turn forever, growing the array and the per-recap
// serialization cost (B5). 200 turns ≈ 100 user + 100 assistant which is well
// above any normal recap horizon — older context lives in memory.json anyway.
export const TALKER_TRANSCRIPT_MAX_ENTRIES = 200;

// Specialty inference: ordered list — first match wins. Electron checked
// before frontend (electron apps contain frontend keywords); review/test/
// devops/docs checked before generic frontend/backend so that a "code review"
// task isn't miscategorized as backend just because it mentions an API.
const SPECIALTY_PATTERNS: Array<[WorkerSpecialtyKind, RegExp]> = [
  ['review', /\b(code\s*review|review|审查|复审|复核|审阅|lint|reviewer|审一遍)\b/i],
  ['test', /\b(test|tests|spec|specs|coverage|e2e|playwright|jest|vitest|测试|跑测|单测|集成测试|tdd)\b/i],
  ['docs', /\b(docs?|documentation|readme|changelog|文档|说明|注释|docstring|codemap)\b/i],
  ['devops', /\b(ci|cd|pipeline|deploy|deployment|docker|k8s|kubernetes|helm|terraform|infra|infrastructure|github\s*action|workflow|release|发布|部署|构建脚本)\b/i],
  ['electron', /\b(electron|preload|ipc|main\.ts|main\.cjs|electron-builder|nativeImage|browserwindow|webcontents|主进程|渲染进程)\b/i],
  ['backend', /\b(api|endpoint|server|route|router|controller|service|orm|database|db|sql|schema|migration|后端|接口|服务端|node\.?js|express|nest|fastapi|django|flask|gorilla|gin|axum|rocket)\b/i],
  ['frontend', /\b(ui|ux|component|css|html|tsx|jsx|react|vue|svelte|tailwind|style|styles|button|modal|drawer|panel|前端|界面|页面|组件|样式|hooks?)\b/i],
];

export function inferSpecialty(text: string): WorkerSpecialtyKind {
  const blob = text || '';
  for (const [kind, re] of SPECIALTY_PATTERNS) {
    if (re.test(blob)) return kind;
  }
  return 'general';
}

// B9: previously these helpers silently swallowed exceptions and returned
// "" / []. That made SDK shape drift (e.g. an upgrade that renames
// message.content to message.parts) invisible — worker output just disappears
// with no clue why. Now we log the offending message structure + stack so
// next time the SDK changes shape, the symptom is one console.error away.
function summarizeShape(value: unknown, depth: number = 0): unknown {
  if (depth > 3) return '…';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return `<string len=${(value as string).length}>`;
  if (t === 'number' || t === 'boolean') return t;
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((v) => summarizeShape(v, depth + 1));
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).slice(0, 8)) {
      out[k] = summarizeShape((value as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return t;
}

export function extractText(message: any): string {
  try {
    const content = message?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join(' ')
        .trim();
    }
  } catch (err) {
    console.error('[orchestrator-helpers] extractText failed; message shape:', summarizeShape(message), err);
  }
  return '';
}

export function extractToolUses(message: any): Array<{ name: string; input: any }> {
  const out: Array<{ name: string; input: any }> = [];
  try {
    const content = message?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') out.push({ name: b.name, input: b.input });
      }
    }
  } catch (err) {
    console.error('[orchestrator-helpers] extractToolUses failed; message shape:', summarizeShape(message), err);
  }
  return out;
}

export function summariseToolInput(_name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const keys = ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'description'];
  for (const k of keys) {
    if (typeof input[k] === 'string' && input[k].length > 0) {
      const v = String(input[k]);
      return v.length > 80 ? `${v.slice(0, 77)}…` : v;
    }
  }
  return '';
}

export function extractFilePath(input: any): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[k] === 'string' && input[k].length > 0) return input[k];
  }
  return null;
}

export function condense(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function titleFromDescription(desc: string): string {
  const single = desc.replace(/\s+/g, ' ').trim();
  return single.length > 48 ? `${single.slice(0, 46)}…` : single;
}
