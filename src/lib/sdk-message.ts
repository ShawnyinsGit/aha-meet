// Helpers for unpacking SDK message shapes coming from Claude Agent SDK.
// Centralised here so the orchestrator-side and renderer-side extractors
// can't drift.

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text ?? '';
        return '';
      })
      .join('');
  }
  return '';
}

export interface ExtractedToolUse {
  name: string;
  input: any;
  id: string;
}

export function extractToolUses(content: unknown): ExtractedToolUse[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => ({ name: b.name, input: b.input, id: b.id }));
}
