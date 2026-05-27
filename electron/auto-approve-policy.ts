// auto-approve-policy.ts — risk classification for tool calls under auto-approve.
//
// Auto-approve was originally a single boolean: when on, every canUseTool call
// short-circuits to allow. That's fine for Read/Grep but dangerous for Write/
// Bash — a renderer compromise (XSS, injected script) could flip the toggle
// or fake the in-renderer approval row and run anything. This module narrows
// auto-approve to demonstrably-safe tools; destructive ones still escalate to
// a user prompt (in Electron, a native OS dialog from main, which a
// compromised renderer cannot fake) even when auto-approve is on.

export type ToolRisk = 'safe' | 'destructive';

// Tools that only READ state — auto-approve is allowed to short-circuit these.
// `Task` delegates to a subagent which runs with its own canUseTool gate, so
// the delegation itself is harmless (the subagent's individual tool calls are
// independently classified by this same module). `TodoWrite` writes only to
// the SDK's own per-session todo store, not the user's filesystem.
const SAFE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'NotebookRead',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'ListMcpResources',
  'ReadMcpResource',
  'ExitPlanMode',
  'BashOutput',
]);

// MCP tools we host in-proc (meeting orchestration). They drive UI/orchestrator
// state, never the user's filesystem, so they are always safe to auto-approve.
const SAFE_MCP_PREFIXES: ReadonlyArray<string> = [
  'mcp__meeting__',
  'mcp__meeting-worker__',
];

export function classifyToolRisk(toolName: string): ToolRisk {
  if (SAFE_BUILTIN_TOOLS.has(toolName)) return 'safe';
  for (const prefix of SAFE_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return 'safe';
  }
  // Fail-safe: unknown tool → destructive. Better to nag the user about a
  // harmless tool than silently auto-allow something we haven't classified.
  return 'destructive';
}
