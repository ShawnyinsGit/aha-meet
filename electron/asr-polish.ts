// asr-polish.ts — Polish raw ASR output into clean written text via the
// configured LLM. Reuses the same API credentials (key, base URL, model) that
// the Claude subprocess uses. On any failure (no key, API error, timeout) the
// raw text is returned unchanged so the user's message is never lost.

import { createRequire } from 'node:module';
import { getSettings } from './store.js';

const require_ = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

const SYSTEM_PROMPT_ZH = `你是一个口语整理助手。将用户的口语化输入转换为清晰、规范的书面语，同时完整保留原始含义和所有关键信息。

规则：
- 去除口头禅（"那个"、"就是"、"嗯"、"然后那个"等）
- 修正不完整的句子，使其语法正确
- 保留所有专有名词、数字、路径、代码标识符
- 如果输入已经是书面语，原样返回
- 不要添加原文中没有的信息
- 不要输出任何解释，只返回整理后的文本

直接输出整理后的文本，不要任何前缀或标记。`;

const SYSTEM_PROMPT_EN = `You are a speech-to-text polisher. Convert colloquial spoken input into clear, grammatically correct written text while preserving all meaning and key information.

Rules:
- Remove filler words ("um", "uh", "like", "you know", "so basically", etc.)
- Fix incomplete or run-on sentences into proper grammar
- Preserve all proper nouns, numbers, paths, and code identifiers exactly
- If the input is already clean written text, return it as-is
- Do not add information not present in the original
- Output only the polished text, no explanations or prefixes`;

const POLISH_TIMEOUT_MS = 10_000;

function detectLanguage(text: string): 'zh' | 'en' {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  return cjk > latin * 0.3 ? 'zh' : 'en';
}

function getClientAndModel(): { client: AnthropicClient; model: string } | null {
  const settings = getSettings();
  if (settings.authMode !== 'apikey' || !settings.anthropicApiKey) return null;

  try {
    const Anthropic = require_('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    const client = new Ctor({
      apiKey: settings.anthropicApiKey,
      baseURL: settings.anthropicBaseUrl || undefined,
    });
    const model = settings.anthropicModel || 'claude-sonnet-4-20250514';
    return { client, model };
  } catch (err) {
    console.warn('[asr-polish] failed to load Anthropic SDK:', err);
    return null;
  }
}

export async function polishAsrText(rawText: string): Promise<string> {
  const trimmed = rawText.trim();
  if (!trimmed) return rawText;

  const ctx = getClientAndModel();
  if (!ctx) return rawText;

  const lang = detectLanguage(trimmed);
  const systemPrompt = lang === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;

  try {
    const result = await withTimeout(
      ctx.client.messages.create({
        model: ctx.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: trimmed }],
      }),
      POLISH_TIMEOUT_MS,
    );

    const text = extractText(result);
    return text || rawText;
  } catch (err) {
    console.warn('[asr-polish] LLM call failed, using raw text:', err);
    return rawText;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(result: any): string {
  if (!result?.content || !Array.isArray(result.content)) return '';
  const textBlock = result.content.find((b: { type?: string }) => b.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') return '';
  return textBlock.text.trim();
}
