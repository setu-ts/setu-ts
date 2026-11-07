import type { AgentRunEntryRow, AgentRunJson, AgentRunRow } from '@setu-ts/common';
import { AgentRunStateError } from '@setu-ts/common';
import type { ModelMessage, ToolSet } from 'ai';

/** JSON round trip prevents mutable SDK objects escaping into persistence. @internal */
export function json(value: unknown): AgentRunJson {
  // A tool returning nothing records null; JSON.stringify(undefined) is not JSON.
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as AgentRunJson);
}
/** Strip caller-owned tool/approval history; only persisted server entries execute. @internal */
export function inputMessages(input: readonly AgentRunJson[]): readonly AgentRunJson[] {
  const cleaned: AgentRunJson[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentRunStateError();
    const message = value as Record<string, AgentRunJson>;
    if (message.role === 'tool') continue;
    // The SDK refuses system messages in `messages`; the definition owns the system prompt.
    if (message.role !== 'user' && message.role !== 'assistant') throw new AgentRunStateError();
    const content = Array.isArray(message.content)
      ? message.content.filter((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return true;
          const type = (part as Record<string, AgentRunJson>).type;
          return (
            typeof type !== 'string' ||
            ![
              'tool-call',
              'tool-result',
              'tool-approval-request',
              'tool-approval-response',
            ].includes(type)
          );
        })
      : message.content;
    if (Array.isArray(content) && content.length === 0) continue;
    cleaned.push(json({ ...message, ...(content === undefined ? {} : { content }) }));
  }
  return cleaned;
}
/** Rebuild only server-generated history after the original input. @internal */
export function messages(run: AgentRunRow, entries: readonly AgentRunEntryRow[]): ModelMessage[] {
  return json([
    ...run.input,
    ...entries.flatMap((entry) => entry.messages),
  ]) as unknown as ModelMessage[];
}
/** Strip all executable hooks and SDK approvals from tools sent to a model. @internal */
export function schemaOnly(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        inputSchema: tool.inputSchema,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      },
    ]),
  );
}
/**
 * Extract the tool calls this plugin must settle from a model entry. A call the
 * SDK already answered in the same response (invalid input, unknown tool) or a
 * provider-executed call is excluded. @internal
 */
export function calls(
  entry: AgentRunEntryRow,
): { toolCallId: string; toolName: string; input: AgentRunJson }[] {
  const result: { toolCallId: string; toolName: string; input: AgentRunJson }[] = [];
  const settled = new Set<string>();
  for (const message of entry.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as Record<string, AgentRunJson>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content)
      if (
        part &&
        typeof part === 'object' &&
        !Array.isArray(part) &&
        (part as Record<string, AgentRunJson>).type === 'tool-result' &&
        typeof (part as Record<string, AgentRunJson>).toolCallId === 'string'
      )
        settled.add((part as Record<string, AgentRunJson>).toolCallId as string);
  }
  for (const message of entry.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as Record<string, AgentRunJson>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const p = part as Record<string, AgentRunJson>;
      if (
        p.type === 'tool-call' &&
        typeof p.toolCallId === 'string' &&
        typeof p.toolName === 'string' &&
        p.providerExecuted !== true &&
        !settled.has(p.toolCallId) &&
        // A repeated call id would share the first call's approval row.
        !result.some((call) => call.toolCallId === p.toolCallId)
      )
        result.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input ?? null });
    }
  }
  return result;
}
/** A stable deterministic child-row key. @internal */
export function childId(runId: string, seq: number): string {
  return `${runId}.${String(seq).padStart(12, '0')}`;
}
