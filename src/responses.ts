import { randomBytes } from "node:crypto";
import { takeSseData } from "./translate.js";

type Rejected = { ok: false; status: number; message: string };
type ChatMessage = Record<string, unknown>;

export type ResponsesChat =
  | { ok: true; chat: Record<string, unknown> }
  | Rejected;

type Piece =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "message"; id: string; text: string }
  | { kind: "tool"; id: string; callId: string; name: string; arguments: string };

export type ResponsesStreamState = {
  id: string;
  createdAt: number;
  model: string;
  seq: number;
  started: boolean;
  completed: boolean;
  pieces: Piece[];
  toolAt: Map<number, number>;
  usage?: Record<string, unknown>;
};

export function responsesRequestToChat(body: Record<string, unknown>): ResponsesChat {
  if (present(body.previous_response_id)) return reject(400, "previous_response_id is not supported; send the full input");
  if (body.conversation != null) return reject(400, "conversation state is not supported; send the full input");
  if (body.background === true) return reject(400, "background responses are not supported");
  const model = stringValue(body.model);
  if (!model) return reject(400, "model is required");
  const messages: ChatMessage[] = [];
  const instructions = stringValue(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  const input = readInput(body.input);
  if (!input.ok) return input;
  messages.push(...input.messages);
  const tools = readTools(body.tools);
  if (!tools.ok) return tools;
  const toolChoice = readToolChoice(body.tool_choice);
  if (!toolChoice.ok) return toolChoice;
  const chat: Record<string, unknown> = { model, messages };
  if (body.stream === true) chat.stream = true;
  const maxOutput = numberValue(body.max_output_tokens);
  if (maxOutput !== undefined) chat.max_tokens = maxOutput;
  const temperature = numberValue(body.temperature);
  if (temperature !== undefined) chat.temperature = temperature;
  const topP = numberValue(body.top_p);
  if (topP !== undefined) chat.top_p = topP;
  if (stringValue(body.reasoning_effort) || record(body.reasoning)?.effort) {
    chat.reasoning_effort = stringValue(body.reasoning_effort) ?? stringValue(record(body.reasoning)?.effort);
  }
  if (tools.tools) chat.tools = tools.tools;
  if (toolChoice.choice !== undefined) chat.tool_choice = toolChoice.choice;
  return { ok: true, chat };
}

export function chatCompletionToResponse(completion: unknown): Record<string, unknown> {
  const root = record(completion);
  const state = createResponsesStream(stringValue(root?.model) ?? "");
  const choice = record(arrayAt(root?.choices, 0));
  const message = record(choice?.message);
  consumeChatChunks([{
    choices: [{
      delta: {
        ...(typeof message?.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
        ...(typeof message?.content === "string" ? { content: message.content } : {}),
        ...(Array.isArray(message?.tool_calls) ? { tool_calls: message.tool_calls } : {}),
      },
      finish_reason: stringValue(choice?.finish_reason) ?? "stop",
    }],
    ...(root?.usage ? { usage: root.usage } : {}),
  }], state);
  finishResponsesStream(state);
  return snapshot(state);
}

export function createResponsesStream(model: string): ResponsesStreamState {
  return {
    id: `resp_${randomBytes(12).toString("hex")}`,
    createdAt: Math.floor(Date.now() / 1000),
    model,
    seq: 0,
    started: false,
    completed: false,
    pieces: [],
    toolAt: new Map(),
  };
}

export function consumeChatChunks(chunks: unknown[], state: ResponsesStreamState): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    const root = record(chunk);
    if (!root) continue;
    events.push(...ensureStarted(state));
    const mapped = responsesUsage(record(root.usage));
    if (mapped) state.usage = mapped;
    const choice = record(arrayAt(root.choices, 0));
    const delta = record(choice?.delta) ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) events.push(...appendText(state, "reasoning", delta.reasoning_content));
    if (typeof delta.content === "string" && delta.content) events.push(...appendText(state, "message", delta.content));
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) events.push(...appendTool(state, call));
    }
  }
  return events;
}

export function finishResponsesStream(state: ResponsesStreamState): Array<Record<string, unknown>> {
  if (state.completed) return [];
  const events = ensureStarted(state);
  for (const piece of state.pieces) {
    events.push({ type: "response.output_item.done", output_index: outputIndexOf(state, piece.id), item: itemOf(piece, true) });
  }
  state.completed = true;
  events.push({ type: "response.completed", response: snapshot(state) });
  return events;
}

export function encodeResponseEvents(events: Array<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(events.map((event) => {
    const type = typeof event.type === "string" ? event.type : "response";
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join(""));
}

export function streamResponses(body: ReadableStream<Uint8Array> | null, model: string): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const responseState = createResponsesStream(model);
  let pending = "";
  const decoder = new TextDecoder();
  const emit = (events: unknown[]): Uint8Array => encodeResponseEvents(consumeChatChunks(events, responseState));
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const taken = takeSseData(pending);
      pending = taken.rest;
      const encoded = emit(taken.events);
      if (encoded.byteLength > 0) controller.enqueue(encoded);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) {
        const encoded = emit(takeSseData(`${pending}\n\n`).events);
        if (encoded.byteLength > 0) controller.enqueue(encoded);
      }
      const tail = encodeResponseEvents(finishResponsesStream(responseState));
      if (tail.byteLength > 0) controller.enqueue(tail);
    },
  }));
}

function readInput(input: unknown): { ok: true; messages: ChatMessage[] } | Rejected {
  if (typeof input === "string") return { ok: true, messages: input ? [{ role: "user", content: input }] : [] };
  if (input == null) return { ok: true, messages: [] };
  if (!Array.isArray(input)) return reject(400, "input must be a string or an array");
  const messages: ChatMessage[] = [];
  for (const entry of input) {
    const item = record(entry);
    if (!item) continue;
    const type = stringValue(item.type) ?? "";
    if (type === "item_reference") return reject(400, "item references are not supported; send the full input");
    if (type === "function_call") {
      const name = stringValue(item.name);
      const callId = stringValue(item.call_id) ?? stringValue(item.id);
      if (!name || !callId) continue;
      const call = { id: callId, type: "function", function: { name, arguments: argumentsText(item.arguments) } };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.tool_calls)) (last.tool_calls as unknown[]).push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
      continue;
    }
    if (type === "function_call_output") {
      const callId = stringValue(item.call_id) ?? stringValue(item.id);
      if (!callId) continue;
      messages.push({ role: "tool", tool_call_id: callId, content: argumentsText(item.output) });
      continue;
    }
    if (type === "reasoning") continue;
    const role = stringValue(item.role);
    if (type === "message" || role) {
      messages.push({ role: role ?? "user", content: chatContent(item.content) });
    }
  }
  return { ok: true, messages };
}

function readTools(value: unknown): { ok: true; tools?: ChatMessage[] } | Rejected {
  if (value == null) return { ok: true };
  if (!Array.isArray(value)) return reject(400, "tools must be an array");
  const tools: ChatMessage[] = [];
  for (const entry of value) {
    const tool = record(entry);
    if (!tool) continue;
    const nested = record(tool.function);
    const name = stringValue(nested?.name) ?? stringValue(tool.name);
    if (!name || (tool.type && tool.type !== "function" && !nested)) continue;
    tools.push({
      type: "function",
      function: {
        name,
        ...(stringValue(nested?.description) ?? stringValue(tool.description)
          ? { description: stringValue(nested?.description) ?? stringValue(tool.description) }
          : {}),
        ...(record(nested?.parameters) ?? record(tool.parameters)
          ? { parameters: record(nested?.parameters) ?? record(tool.parameters) }
          : {}),
      },
    });
  }
  return { ok: true, ...(tools.length > 0 ? { tools } : {}) };
}

function readToolChoice(value: unknown): { ok: true; choice?: unknown } | Rejected {
  if (value == null || value === "none" || value === "auto" || value === "required") return { ok: true, choice: value ?? undefined };
  const choice = record(value);
  if (!choice) return reject(400, "tool_choice is invalid");
  const name = stringValue(record(choice.function)?.name) ?? stringValue(choice.name);
  if (choice.type === "function" && name) return { ok: true, choice: { type: "function", function: { name } } };
  if (typeof choice.type === "string" && choice.type !== "function") return reject(400, `${choice.type} tool_choice is not supported`);
  return reject(400, "tool_choice is invalid");
}

function chatContent(content: unknown): unknown {
  if (typeof content === "string" || content == null) return content ?? "";
  if (!Array.isArray(content)) return "";
  const parts: Array<Record<string, unknown>> = [];
  for (const entry of content) {
    const part = record(entry);
    if (!part) continue;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts.length > 0 ? parts : "";
}

function appendText(state: ResponsesStreamState, kind: "reasoning" | "message", delta: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const found = [...state.pieces].reverse().find((item): item is Extract<Piece, { kind: "reasoning" | "message" }> => item.kind === kind);
  const reuse = Boolean(found) && (kind !== "reasoning" || state.pieces[state.pieces.length - 1]?.kind === "reasoning");
  const piece = reuse && found
    ? found
    : kind === "reasoning"
      ? { kind: "reasoning" as const, id: nextId(state, "rs"), text: "" }
      : { kind: "message" as const, id: nextId(state, "msg"), text: "" };
  if (!reuse) {
    state.pieces.push(piece);
    events.push({ type: "response.output_item.added", output_index: state.pieces.length - 1, item: itemOf(piece, false) });
  }
  piece.text += delta;
  const outputIndex = outputIndexOf(state, piece.id);
  events.push(kind === "reasoning"
    ? { type: "response.reasoning_summary_text.delta", item_id: piece.id, output_index: outputIndex, summary_index: 0, delta }
    : { type: "response.output_text.delta", item_id: piece.id, output_index: outputIndex, content_index: 0, delta });
  return events;
}

function appendTool(state: ResponsesStreamState, value: unknown): Array<Record<string, unknown>> {
  const call = record(value);
  if (!call) return [];
  const fn = record(call.function) ?? {};
  const index = typeof call.index === "number" && Number.isFinite(call.index) ? call.index : state.toolAt.size;
  const events: Array<Record<string, unknown>> = [];
  let position = state.toolAt.get(index);
  if (position === undefined) {
    const id = nextId(state, "fc");
    const piece: Piece = {
      kind: "tool",
      id,
      callId: stringValue(call.id) ?? id,
      name: stringValue(fn.name) ?? "",
      arguments: "",
    };
    position = state.pieces.length;
    state.pieces.push(piece);
    state.toolAt.set(index, position);
    events.push({ type: "response.output_item.added", output_index: position, item: itemOf(piece, false) });
  }
  const piece = state.pieces[position];
  if (!piece || piece.kind !== "tool") return events;
  if (stringValue(call.id)) piece.callId = stringValue(call.id)!;
  if (stringValue(fn.name)) piece.name = stringValue(fn.name)!;
  if (typeof fn.arguments === "string" && fn.arguments) {
    piece.arguments += fn.arguments;
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: piece.id,
      output_index: position,
      delta: fn.arguments,
    });
  }
  return events;
}

function ensureStarted(state: ResponsesStreamState): Array<Record<string, unknown>> {
  if (state.started) return [];
  state.started = true;
  const response = snapshot(state, "in_progress");
  return [
    { type: "response.created", response },
    { type: "response.in_progress", response },
  ];
}

function snapshot(state: ResponsesStreamState, status = "completed"): Record<string, unknown> {
  return {
    id: state.id,
    object: "response",
    created_at: state.createdAt,
    model: state.model,
    status,
    output: state.pieces.map((piece) => itemOf(piece, status === "completed")),
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

function itemOf(piece: Piece, done: boolean): Record<string, unknown> {
  if (piece.kind === "reasoning") {
    return { type: "reasoning", id: piece.id, status: done ? "completed" : "in_progress", summary: [{ type: "summary_text", text: piece.text }] };
  }
  if (piece.kind === "message") {
    return {
      type: "message",
      id: piece.id,
      role: "assistant",
      status: done ? "completed" : "in_progress",
      content: [{ type: "output_text", text: piece.text, annotations: [] }],
    };
  }
  return { type: "function_call", id: piece.id, call_id: piece.callId, name: piece.name, arguments: piece.arguments, status: done ? "completed" : "in_progress" };
}

function responsesUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  const cached = count(record(usage.prompt_tokens_details)?.cached_tokens);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: count(usage.total_tokens) || input + output,
    input_tokens_details: { cached_tokens: cached },
  };
}

function outputIndexOf(state: ResponsesStreamState, id: string): number {
  const index = state.pieces.findIndex((piece) => piece.id === id);
  return index < 0 ? 0 : index;
}

function nextId(state: ResponsesStreamState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(16)}${randomBytes(4).toString("hex")}`;
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function reject(status: number, message: string): Rejected {
  return { ok: false, status, message };
}

function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayAt(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

