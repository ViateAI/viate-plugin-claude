import { randomBytes } from "node:crypto";
import { billingHeader, signClaudeBody } from "./cch.js";

export const CLAUDE_CODE_VERSION = "2.1.321";
export const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const DEFAULT_MAX_TOKENS = 8192;
const THINKING_BUDGET: Record<string, number> = { low: 1024, medium: 4096, high: 16_000, xhigh: 32_000, max: 32_000 };

type Block = Record<string, unknown>;

export type AnthropicRequest = {
  bytes: Uint8Array;
  model: string;
  stream: boolean;
};

export function buildAnthropicRequest(
  body: Record<string, unknown>,
  identity: { deviceId: string; sessionId: string; accountId?: string },
): AnthropicRequest {
  const model = stringValue(body.model);
  if (!model) throw badRequest("model is required");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const converted = toMessages(messages, systemText(body.system));
  if (converted.messages.length === 0) throw badRequest("messages are required");
  const maxTokens = positiveInt(body.max_tokens) ?? positiveInt(body.max_completion_tokens) ?? DEFAULT_MAX_TOKENS;
  const messageText = firstUserText(converted.messages);
  const system: Block[] = [
    { type: "text", text: billingHeader(CLAUDE_CODE_VERSION, messageText) },
    { type: "text", text: CLAUDE_IDENTITY },
    ...converted.system.map((text) => ({ type: "text", text })),
  ];
  const request: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system,
    messages: converted.messages,
  };
  const temperature = numberValue(body.temperature);
  if (temperature !== undefined) request.temperature = temperature;
  const topP = numberValue(body.top_p);
  if (topP !== undefined) request.top_p = topP;
  const stop = stopSequences(body.stop);
  if (stop) request.stop_sequences = stop;
  const tools = toTools(body.tools, body.tool_choice);
  if (tools) {
    request.tools = tools.tools;
    if (tools.toolChoice) request.tool_choice = tools.toolChoice;
  }
  const thinking = thinkingConfig(body.reasoning_effort, maxTokens);
  if (thinking) request.thinking = thinking;
  request.metadata = {
    user_id: JSON.stringify({
      device_id: identity.deviceId,
      ...(identity.accountId ? { account_uuid: identity.accountId } : {}),
      session_id: identity.sessionId,
    }),
  };
  const stream = body.stream === true;
  if (stream) request.stream = true;
  return { bytes: signClaudeBody(Buffer.from(JSON.stringify(request))), model, stream };
}

export function toOpenAIChatCompletion(model: string, payload: unknown): Record<string, unknown> {
  const message = record(payload);
  const content = Array.isArray(message?.content) ? message.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const part of content) {
    const block = record(part);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: stringValue(block.id) ?? `toolu_${randomBytes(6).toString("hex")}`,
        type: "function",
        function: {
          name: stringValue(block.name) ?? "tool",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const finish = finishReason(stringValue(message?.stop_reason), toolCalls.length > 0);
  const usage = openAIUsage(record(message?.usage));
  return {
    id: stringValue(message?.id) ?? `chatcmpl-${randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finish,
    }],
    ...(usage ? { usage } : {}),
  };
}

export type ChatStreamState = {
  id: string;
  created: number;
  model: string;
  roleSent: boolean;
  nextTool: number;
  tools: Map<number, number>;
  finish: string | null;
  usage: Record<string, unknown> | null;
  finished: boolean;
};

export function createChatStream(model: string): ChatStreamState {
  return {
    id: `chatcmpl-${randomBytes(8).toString("hex")}`,
    created: Math.floor(Date.now() / 1000),
    model,
    roleSent: false,
    nextTool: 0,
    tools: new Map(),
    finish: null,
    usage: null,
    finished: false,
  };
}

export function anthropicEventsToChunks(events: unknown[], state: ChatStreamState): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const recordEvent = record(event);
    if (!recordEvent) continue;
    const type = stringValue(recordEvent.type);
    if (type === "message_start") {
      const message = record(recordEvent.message);
      const id = stringValue(message?.id);
      if (id) state.id = id;
      const usage = openAIUsage(record(message?.usage));
      if (usage) state.usage = mergeUsage(state.usage, usage);
    } else if (type === "content_block_start") {
      chunks.push(...startBlock(state, numberValue(recordEvent.index) ?? 0, record(recordEvent.content_block)));
    } else if (type === "content_block_delta") {
      chunks.push(...deltaBlock(state, numberValue(recordEvent.index) ?? 0, record(recordEvent.delta)));
    } else if (type === "message_delta") {
      const delta = record(recordEvent.delta);
      state.finish = finishReason(stringValue(delta?.stop_reason), state.nextTool > 0);
      const usage = openAIUsage(record(recordEvent.usage));
      if (usage) state.usage = mergeUsage(state.usage, usage);
      state.finished = true;
      chunks.push(chunk(state, {}, state.finish));
    }
  }
  return chunks;
}

export function finishChatStream(state: ChatStreamState): Array<Record<string, unknown>> {
  if (state.finished) return [];
  state.finished = true;
  return [chunk(state, {}, state.finish ?? (state.nextTool > 0 ? "tool_calls" : "stop"))];
}

export function encodeOpenAISse(frames: Array<Record<string, unknown>>, done = false): Uint8Array {
  const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  if (done) lines.push("data: [DONE]\n\n");
  return new TextEncoder().encode(lines.join(""));
}

export function takeSseData(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events: unknown[] = [];
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore SSE comments and non-JSON frames.
    }
  }
  return { events, rest };
}

export function streamAnthropicToOpenAI(
  body: ReadableStream<Uint8Array> | null,
  model: string,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const state = createChatStream(model);
  let pending = "";
  const decoder = new TextDecoder();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunkBytes, controller) {
      pending += decoder.decode(chunkBytes, { stream: true });
      const taken = takeSseData(pending);
      pending = taken.rest;
      const encoded = encodeOpenAISse(anthropicEventsToChunks(taken.events, state));
      if (encoded.byteLength > 0) controller.enqueue(encoded);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) {
        const taken = takeSseData(`${pending}\n\n`);
        const encoded = encodeOpenAISse(anthropicEventsToChunks(taken.events, state));
        if (encoded.byteLength > 0) controller.enqueue(encoded);
      }
      const tail = encodeOpenAISse(finishChatStream(state), true);
      if (tail.byteLength > 0) controller.enqueue(tail);
    },
  }));
}

function toMessages(
  messages: unknown[],
  extraSystem: string[],
): { system: string[]; messages: Block[] } {
  const system = [...extraSystem];
  const converted: Block[] = [];
  for (const entry of messages) {
    const message = record(entry);
    if (!message) continue;
    const role = stringValue(message.role) ?? "user";
    if (role === "system" || role === "developer") {
      system.push(...textParts(message.content));
      continue;
    }
    if (role === "tool") {
      const toolId = stringValue(message.tool_call_id);
      if (!toolId) continue;
      const result: Block = { type: "tool_result", tool_use_id: toolId, content: textParts(message.content).join("\n") };
      const last = converted[converted.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((part) => record(part)?.type === "tool_result")) {
        (last.content as Block[]).push(result);
      } else {
        converted.push({ role: "user", content: [result] });
      }
      continue;
    }
    const blocks = contentBlocks(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const tool = toolUseBlock(call);
        if (tool) blocks.push(tool);
      }
    }
    if (blocks.length === 0) continue;
    const anthropicRole = role === "assistant" ? "assistant" : "user";
    const last = converted[converted.length - 1];
    if (last?.role === anthropicRole && Array.isArray(last.content)) {
      (last.content as Block[]).push(...blocks);
    } else {
      converted.push({ role: anthropicRole, content: blocks });
    }
  }
  return { system: system.filter((text) => text.trim()), messages: converted };
}

function contentBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const entry of content) {
    const part = record(entry);
    if (!part) continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const image = imageBlock(part);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

function imageBlock(part: Block): Block | undefined {
  const direct = stringValue(part.image_url) ?? stringValue(part.url);
  const nested = record(part.image_url);
  const url = direct ?? stringValue(nested?.url);
  if (!url) return undefined;
  const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (data?.[1] && data[2]) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image", source: { type: "url", url } };
  }
  return undefined;
}

function toolUseBlock(value: unknown): Block | undefined {
  const call = record(value);
  const fn = record(call?.function);
  const name = stringValue(fn?.name);
  const id = stringValue(call?.id);
  if (!call || !name || !id) return undefined;
  let input: unknown = {};
  if (typeof fn?.arguments === "string" && fn.arguments.trim()) {
    try {
      input = JSON.parse(fn.arguments) as unknown;
    } catch {
      input = {};
    }
  } else if (fn?.arguments && typeof fn.arguments === "object") {
    input = fn.arguments;
  }
  return { type: "tool_use", id, name, input };
}

function toTools(
  value: unknown,
  choice: unknown,
): { tools: Block[]; toolChoice?: Block } | undefined {
  if (choice === "none") return undefined;
  if (!Array.isArray(value)) return undefined;
  const tools: Block[] = [];
  for (const entry of value) {
    const tool = record(entry);
    const fn = record(tool?.function) ?? tool;
    const name = stringValue(fn?.name);
    if (!name) continue;
    const parameters = record(fn?.parameters) ?? record(fn?.input_schema) ?? { type: "object", properties: {} };
    tools.push({
      name,
      input_schema: parameters,
      ...(stringValue(fn?.description) ? { description: stringValue(fn?.description) } : {}),
    });
  }
  if (tools.length === 0) return undefined;
  return { tools, toolChoice: toolChoice(choice) };
}

function toolChoice(value: unknown): Block | undefined {
  if (value == null || value === "auto") return undefined;
  if (value === "required") return { type: "any" };
  const choice = record(value);
  const name = stringValue(record(choice?.function)?.name) ?? stringValue(choice?.name);
  if (name) return { type: "tool", name };
  return undefined;
}

function thinkingConfig(effort: unknown, maxTokens: number): Block | undefined {
  const name = stringValue(effort)?.toLowerCase();
  if (!name || name === "none" || name === "minimal") return undefined;
  const budget = THINKING_BUDGET[name] ?? THINKING_BUDGET.medium!;
  if (budget >= maxTokens) return undefined;
  return { type: "enabled", budget_tokens: budget };
}

function startBlock(state: ChatStreamState, index: number, block: Block | undefined): Array<Record<string, unknown>> {
  if (!block) return [];
  if (block.type === "text" && typeof block.text === "string" && block.text) return [textChunk(state, block.text)];
  if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
    return [deltaChunk(state, { reasoning_content: block.thinking })];
  }
  if (block.type === "tool_use") {
    const toolIndex = state.nextTool;
    state.nextTool += 1;
    state.tools.set(index, toolIndex);
    return [deltaChunk(state, {
      tool_calls: [{
        index: toolIndex,
        id: stringValue(block.id) ?? `toolu_${randomBytes(6).toString("hex")}`,
        type: "function",
        function: { name: stringValue(block.name) ?? "tool", arguments: "" },
      }],
    })];
  }
  return [];
}

function deltaBlock(state: ChatStreamState, index: number, delta: Block | undefined): Array<Record<string, unknown>> {
  if (!delta) return [];
  if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) return [textChunk(state, delta.text)];
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
    return [deltaChunk(state, { reasoning_content: delta.thinking })];
  }
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json) {
    const toolIndex = state.tools.get(index);
    if (toolIndex === undefined) return [];
    return [deltaChunk(state, { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] })];
  }
  return [];
}

function textChunk(state: ChatStreamState, text: string): Record<string, unknown> {
  return deltaChunk(state, { content: text });
}

function deltaChunk(state: ChatStreamState, delta: Record<string, unknown>): Record<string, unknown> {
  if (!state.roleSent) {
    state.roleSent = true;
    delta = { role: "assistant", ...delta };
  }
  return chunk(state, delta, null);
}

function chunk(state: ChatStreamState, delta: Record<string, unknown>, finish: string | null): Record<string, unknown> {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish && state.usage ? { usage: state.usage } : {}),
  };
}

function openAIUsage(usage: Block | undefined): Record<string, unknown> | null {
  if (!usage) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  if (input + output + cacheRead + cacheWrite === 0 && usage.input_tokens == null && usage.output_tokens == null) {
    return null;
  }
  return {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: output,
    total_tokens: input + output + cacheRead + cacheWrite,
    prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
  };
}

function mergeUsage(current: Record<string, unknown> | null, next: Record<string, unknown>): Record<string, unknown> {
  if (!current) return next;
  const prompt = Math.max(count(current.prompt_tokens), count(next.prompt_tokens));
  const completion = Math.max(count(current.completion_tokens), count(next.completion_tokens));
  const currentDetails = record(current.prompt_tokens_details);
  const nextDetails = record(next.prompt_tokens_details);
  const cached = Math.max(count(currentDetails?.cached_tokens), count(nextDetails?.cached_tokens));
  const cacheWrite = Math.max(count(currentDetails?.cache_write_tokens), count(nextDetails?.cache_write_tokens));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
  };
}

function firstUserText(messages: Block[]): string {
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) => (record(part)?.type === "text" ? stringValue(record(part)?.text) ?? "" : ""))
      .join("");
    if (text) return text;
  }
  return "";
}

function systemText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  return textParts(value);
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry ? [entry] : [];
    const part = record(entry);
    return typeof part?.text === "string" && part.text ? [part.text] : [];
  });
}

function stopSequences(value: unknown): string[] | undefined {
  if (typeof value === "string" && value) return [value];
  if (!Array.isArray(value)) return undefined;
  const stops = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return stops.length > 0 ? stops : undefined;
}

function finishReason(stop: string | undefined, hasTools: boolean): string {
  if (stop === "max_tokens") return "length";
  if (stop === "tool_use" || hasTools) return "tool_calls";
  return "stop";
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Block | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Block : undefined;
}
