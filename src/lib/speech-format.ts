// Preprocess assistant text into something a TTS engine can actually speak
// like a person. Markdown, code fences, and tool noise all read terribly when
// spoken verbatim — we summarise instead of literal-narrating.

export type Locale = 'zh' | 'en';

// Strict mode drops any chunk with zero CJK characters; off mode passes
// everything through unchanged. Default is strict because the worker's
// English thinking + tool noise was the original complaint.
export type SpeechFilterMode = 'strict' | 'off';

const ZH_CODE_NARRATIONS = [
  '我写了一段代码，需要看吗？',
  '代码我已经放在那边了，要不要我给你过一下？',
  '改好了，你那边方便看下吗？',
];

const EN_CODE_NARRATIONS = [
  'I wrote some code — want me to walk you through it?',
  'The change is in — want to take a look?',
  'Pushed an edit — let me know if you want me to explain it.',
];

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function detectLocale(text: string): Locale {
  // Any CJK character → zh; otherwise en. Mixed strings → bias by ratio.
  let zh = 0;
  let en = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK Unified Ideographs
    if (c >= 0x4e00 && c <= 0x9fff) zh++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) en++;
  }
  return zh > en ? 'zh' : 'en';
}

// Strip markdown noise so the TTS doesn't say "asterisk asterisk bold".
export function stripMarkdownForSpeech(input: string): string {
  let s = input;

  // Remove fenced code blocks but remember whether any existed.
  s = s.replace(/```[\s\S]*?```/g, ' [[CODE_BLOCK]] ');
  // Inline backticks
  s = s.replace(/`([^`]*)`/g, '$1');
  // Bold / italics
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/_([^_]+)_/g, '$1');
  // Links [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Images ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Headings, blockquotes, list bullets
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  // Horizontal rules
  s = s.replace(/^[-=*_]{3,}$/gm, '');
  // HTML tags
  s = s.replace(/<\/?[^>]+>/g, '');
  // Collapse whitespace
  s = s.replace(/ /g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{2,}/g, '. ');
  s = s.replace(/\n/g, ' ');
  return s.trim();
}

// Replace the code-block placeholder with a short spoken summary, if any.
export function summariseForSpeech(text: string, raw: string): string {
  if (!text.includes('[[CODE_BLOCK]]')) return text;
  const locale = detectLocale(raw);
  const pool = locale === 'zh' ? ZH_CODE_NARRATIONS : EN_CODE_NARRATIONS;

  // Estimate line count from raw to make the narration specific.
  const matches = raw.match(/```[\s\S]*?```/g) ?? [];
  const lines = matches.reduce((n, block) => n + block.split('\n').length - 2, 0);

  const narration = lines > 0
    ? (locale === 'zh'
        ? `我写了大概 ${lines} 行代码，要不要看？`
        : `I wrote about ${lines} lines of code — want to see it?`)
    : pickOne(pool);

  return text.replace(/\[\[CODE_BLOCK\]\]/g, narration);
}

// Split into spoken-length chunks. Each chunk gets a locale tag so the TTS
// layer can pick the right voice per sentence (zh sentence → Tingting,
// en sentence → Samantha/Siri).
export function splitSentences(text: string): Array<{ text: string; locale: Locale }> {
  const out: Array<{ text: string; locale: Locale }> = [];
  // Split on sentence enders for both languages, keeping the punctuation.
  const parts = text
    .split(/(?<=[。！？!?.])\s+|(?<=[。！？!?.])(?=[^\s])/u)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    // Further chunk overly long parts so TTS stays interruptible.
    if (part.length <= 140) {
      out.push({ text: part, locale: detectLocale(part) });
    } else {
      // Break on commas / ；/ ,
      const subs = part.split(/(?<=[，,；;])\s*/).filter(Boolean);
      let buf = '';
      for (const s of subs) {
        if ((buf + s).length > 140 && buf) {
          out.push({ text: buf.trim(), locale: detectLocale(buf) });
          buf = s;
        } else {
          buf += s;
        }
      }
      if (buf.trim()) out.push({ text: buf.trim(), locale: detectLocale(buf) });
    }
  }
  return out;
}

// Tool-noise scrubber. The orchestrator forwards strings like
// "worker started Read: /Users/x/foo.tsx" → talker → TTS, and the user
// doesn't want any of that read aloud. We swap the recognisable shapes for
// short Chinese narrations and let `filterByMode` drop whatever's left if
// strict mode is on. Patterns are intentionally conservative — we'd rather
// miss a noise line than swallow something the user wanted to hear.
const TOOL_NAME_GROUP = '(Read|Edit|MultiEdit|Write|Bash|Grep|Glob|WebFetch|WebSearch|Task|TodoWrite|NotebookEdit)';

export function scrubToolNoise(input: string): string {
  let s = input;

  // "worker started Foo: details" → "正在 <verb>"
  s = s.replace(
    new RegExp(`worker started ${TOOL_NAME_GROUP}(?::[^\\n。!?]*)?`, 'gi'),
    (_m, tool: string) => zhVerbForTool(tool, 'start'),
  );
  // "worker finished Foo" → "<verb>完了"
  s = s.replace(
    new RegExp(`worker finished ${TOOL_NAME_GROUP}`, 'gi'),
    (_m, tool: string) => zhVerbForTool(tool, 'finish'),
  );
  // Standalone meta lines.
  s = s.replace(/worker turn complete\.?/gi, '处理完了。');
  s = s.replace(/worker thought:\s*/gi, '');

  // Bare "Tool: /some/path" or "Tool /some/path" — only when the path looks
  // like a real one (starts with / or ~ or a Windows drive letter).
  s = s.replace(
    new RegExp(`\\b${TOOL_NAME_GROUP}\\b[:\\s]+(?:["'\\\`])?(?:[~/]|[A-Za-z]:\\\\)[^\\s"'\\\`，。!?；;]+`, 'g'),
    (_m, tool: string) => zhVerbForTool(tool, 'start'),
  );

  // Long absolute paths floating on their own.
  s = s.replace(/(?:["'`])?(?:\/[^\s"'`，。!?；;]+){2,}(?:["'`])?/g, '某个文件');
  s = s.replace(/(?:["'`])?~\/[^\s"'`，。!?；;]+(?:["'`])?/g, '某个文件');

  // Common command-line invocations.
  s = s.replace(/\b(?:npm|pnpm|yarn|npx)\s+(?:run\s+)?[\w:-]+(?:\s+[-\w./=]+)*/gi, '命令');
  s = s.replace(/\b(?:git|gh)\s+[\w-]+(?:\s+[-\w./=]+)*/gi, 'git 操作');
  s = s.replace(/\b(?:tsc|eslint|prettier|vitest|jest|cargo|go|hvigorw|ohpm)\s+[-\w./=:]+(?:\s+[-\w./=:]+)*/gi, '命令');
  s = s.replace(/\bcd\s+\S+/g, '切目录');

  // Collapse the residue.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\s+([，。！？；])/g, '$1');
  return s.trim();
}

function zhVerbForTool(tool: string, phase: 'start' | 'finish'): string {
  const t = tool.toLowerCase();
  if (phase === 'start') {
    if (t === 'read') return '在看文件';
    if (t === 'edit' || t === 'multiedit') return '在改代码';
    if (t === 'write') return '在写文件';
    if (t === 'bash') return '在跑命令';
    if (t === 'grep' || t === 'glob') return '在找东西';
    if (t === 'webfetch' || t === 'websearch') return '在查资料';
    if (t === 'task') return '在派子任务';
    if (t === 'todowrite') return '在记任务';
    if (t === 'notebookedit') return '在改 notebook';
    return '在调用工具';
  }
  if (t === 'read') return '看完了';
  if (t === 'edit' || t === 'multiedit' || t === 'write') return '改完了';
  if (t === 'bash') return '跑完了';
  if (t === 'grep' || t === 'glob') return '找完了';
  if (t === 'webfetch' || t === 'websearch') return '查完了';
  if (t === 'task') return '子任务完成';
  if (t === 'todowrite') return '任务记好了';
  return '工具完成';
}

function hasCjk(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) return true;
  }
  return false;
}

export function filterByMode(
  chunks: Array<{ text: string; locale: Locale }>,
  mode: SpeechFilterMode,
): Array<{ text: string; locale: Locale }> {
  if (mode === 'off') return chunks;
  // Strict mode's goal: when a Chinese-dominant reply contains stray English
  // (worker tool noise, untranslated identifiers), drop the English chunks
  // so the user only hears the Chinese narration.
  //
  // BUT if the WHOLE reply has no CJK at all, it's a real English reply (user
  // asked in English, talker followed suit). Silencing it entirely was the
  // bug the user reported as "回复给我的没有播报声音". In that case fall
  // back to playing everything — better to hear an English reply than nothing.
  const anyCjk = chunks.some((c) => hasCjk(c.text));
  if (!anyCjk) {
    return chunks.filter((c) => c.text.replace(/[\s\p{P}]/gu, '').length >= 2);
  }
  // Mixed-language reply: keep CJK chunks; require ≥2 meaningful chars so
  // single-punctuation or single-char residue doesn't surface.
  return chunks.filter((c) => {
    if (!hasCjk(c.text)) return false;
    const meaningful = c.text.replace(/[\s\p{P}]/gu, '');
    return meaningful.length >= 2;
  });
}

export function prepareForSpeech(
  raw: string,
  mode: SpeechFilterMode = 'strict',
): Array<{ text: string; locale: Locale }> {
  const stripped = stripMarkdownForSpeech(raw);
  const summarised = summariseForSpeech(stripped, raw);
  const scrubbed = mode === 'off' ? summarised : scrubToolNoise(summarised);
  const chunks = splitSentences(scrubbed);
  return filterByMode(chunks, mode);
}
