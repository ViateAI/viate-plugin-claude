import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { silentPluginLogger, type ProviderConnection, type ProviderHandler } from "@viateai/sdk";
import {
  chatCompletions,
  exchangeOAuth,
  keepalive,
  listModels,
  normalizeCredentials,
  parseCredentials,
  plugin,
  responses,
  startOAuth,
  subscription,
} from "./index.js";

const originalFetch = globalThis.fetch;
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("claude plugin", () => {
  it("registers the subscription provider", () => {
    const providers: ProviderHandler[] = [];
    plugin.register({
      registerProvider(handler) {
        providers.push(handler);
      },
      log: silentPluginLogger(),
    });
    assert.equal(plugin.id, "claude");
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.id, "claude");
    assert.equal(typeof providers[0]?.startOAuth, "function");
    assert.equal(typeof providers[0]?.exchangeOAuth, "function");
    assert.equal(typeof providers[0]?.keepalive, "function");
    assert.equal(typeof providers[0]?.subscription, "function");
    assert.equal(typeof providers[0]?.chatCompletions, "function");
    assert.equal(typeof providers[0]?.responses, "function");
    assert.equal(typeof providers[0]?.listModels, "function");
  });

  it("normalizes a pasted token and a Claude token payload", () => {
    assert.equal((parseCredentials(" sk-ant-oat ") as { accessToken: string }).accessToken, "sk-ant-oat");
    const normalized = normalizeCredentials({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      account: { uuid: "11111111-1111-4111-8111-111111111111", email_address: "a@example.com" },
      organization: { uuid: "22222222-2222-4222-8222-222222222222", name: "Personal" },
    });
    const credentials = normalized.credentials as { accessToken: string; email?: string; accountId?: string; deviceId: string };
    assert.equal(credentials.accessToken, "access-token");
    assert.equal(credentials.email, "a@example.com");
    assert.equal(credentials.accountId, "11111111-1111-4111-8111-111111111111");
    assert.match(credentials.deviceId, /^[0-9a-f]{64}$/);
    assert.equal(normalized.displayLabel, "a@example.com");
  });

  it("builds the Claude Code authorization URL", async () => {
    const started = await startOAuth({
      connectionId: "c1",
      credentials: {},
      callbackUrl: "http://127.0.0.1:4317/api/admin/oauth/callback?state=state-1",
    });
    assert.equal(started.type, "authorization_url");
    if (started.type !== "authorization_url") return;
    const url = new URL(started.authorizationUrl);
    assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:54545/callback");
    assert.equal(url.searchParams.get("code"), "true");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("scope") ?? "", /user:inference/);
    assert.match(url.searchParams.get("scope") ?? "", /user:sessions:claude_code/);
    assert.equal(url.searchParams.get("state"), "state-1");
  });

  it("exchanges a code fragment and reads the profile", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === TOKEN_URL) {
        const body = String(init?.body);
        assert.match(body, /^\{"grant_type":"authorization_code","code":"auth-code"/);
        assert.match(body, /"code_verifier":"verifier"/);
        assert.match(body, /"state":"from-code"/);
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        });
      }
      assert.equal(url, PROFILE_URL);
      return Response.json({
        account: { uuid: "11111111-1111-4111-8111-111111111111", email: "a@example.com" },
        organization: { uuid: "22222222-2222-4222-8222-222222222222", name: "Max" },
      });
    };
    const normalized = await exchangeOAuth({
      connectionId: "c1",
      credentials: {},
      code: "auth-code#from-code",
      state: "ignored",
      session: { verifier: "verifier" },
    });
    const credentials = normalized.credentials as { email?: string; organizationName?: string; refreshToken?: string };
    assert.equal(credentials.email, "a@example.com");
    assert.equal(credentials.organizationName, "Max");
    assert.equal(credentials.refreshToken, "refresh");
    assert.deepEqual(calls, [TOKEN_URL, PROFILE_URL]);
  });

  it("refreshes an expired token and leaves a live token alone", async () => {
    let called = false;
    globalThis.fetch = async (input, init) => {
      called = true;
      assert.equal(String(input), TOKEN_URL);
      const body = JSON.parse(String(init?.body)) as { grant_type?: string; refresh_token?: string; scope?: string };
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, "old-refresh");
      assert.match(body.scope ?? "", /user:inference/);
      assert.equal(new Headers(init?.headers).get("anthropic-beta"), "oauth-2025-04-20");
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    };
    const live = await keepalive({
      connectionId: "c1",
      credentials: stored({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      signal: AbortSignal.timeout(1000),
      reason: "timer",
      log: silentPluginLogger(),
    });
    assert.equal(live.status, "ok");
    assert.equal(called, false);
    const refreshed = await keepalive({
      connectionId: "c1",
      credentials: stored({ expiresAt: new Date(Date.now() - 1000).toISOString(), refreshToken: "old-refresh" }),
      signal: AbortSignal.timeout(1000),
      reason: "timer",
      log: silentPluginLogger(),
    });
    assert.equal(refreshed.status, "ok");
    const credentials = refreshed.credentials as { accessToken?: string; refreshToken?: string; deviceId?: string };
    assert.equal(credentials.accessToken, "new-access");
    assert.equal(credentials.refreshToken, "new-refresh");
    assert.equal(credentials.deviceId, stored().deviceId);
  });

  it("reports subscription windows and extra usage", async () => {
    globalThis.fetch = async () => Response.json({
      five_hour: { utilization: 25, resets_at: "2026-01-28T15:00:00Z" },
      seven_day: { utilization: 40, resets_at: "2026-02-01T00:00:00Z" },
      extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 10_000, currency: "USD" },
    });
    const result = await subscription({
      connectionId: "c1",
      credentials: stored({ organizationName: "Max" }),
      signal: AbortSignal.timeout(1000),
      log: silentPluginLogger(),
    });
    assert.equal(result.status, "ok");
    assert.equal(result.plan, "Max");
    assert.equal(result.usages?.[0]?.type, "five_hour");
    assert.equal(result.usages?.[0]?.used, 25);
    assert.equal(result.usages?.[1]?.remaining, 60);
    assert.equal(result.usages?.[2]?.unit, "currency");
    assert.equal(result.usages?.[2]?.used, 5);
    assert.equal(result.usages?.[2]?.limit, 100);
  });

  it("translates chat completions onto the Claude messages API", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = async (input, init) => {
      seen = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as Record<string, unknown>,
      };
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2 },
      });
    };
    const credentials = stored();
    const result = await chatCompletions({
      body: {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "Be brief" },
          { role: "user", content: "Hello" },
        ],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
      },
      headers: { "anthropic-beta": "caller-beta" },
    }, connection(credentials));
    assert.equal(result.status, 200);
    assert.equal(seen?.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(seen?.headers.get("authorization"), "Bearer access-token");
    assert.equal(seen?.headers.get("user-agent"), "claude-cli/2.1.321 (external, cli)");
    assert.equal(seen?.headers.get("x-claude-code-session-id"), credentials.sessionId);
    assert.match(seen?.headers.get("anthropic-beta") ?? "", /^claude-code-20250219,oauth-2025-04-20/);
    assert.match(seen?.headers.get("anthropic-beta") ?? "", /caller-beta$/);
    const system = seen?.body.system as Array<{ text: string }>;
    assert.match(system[0]?.text ?? "", /^x-anthropic-billing-header:/);
    assert.match(system[0]?.text ?? "", /cch=[0-9a-f]{5};/);
    assert.notEqual(system[0]?.text.includes("cch=00000;"), true);
    assert.match(system[1]?.text ?? "", /Claude Code/);
    assert.equal(system[2]?.text, "Be brief");
    const metadata = seen?.body.metadata as { user_id: string };
    assert.equal(JSON.parse(metadata.user_id).session_id, credentials.sessionId);
    const tools = seen?.body.tools as Array<{ name: string }>;
    assert.equal(tools[0]?.name, "lookup");
    const completion = JSON.parse(await readStream(result.body)) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };
    assert.equal(completion.choices[0]?.message.content, "Hi");
    assert.equal(completion.usage.prompt_tokens, 5);
  });

  it("streams Anthropic events as OpenAI chunks", async () => {
    globalThis.fetch = async () => new Response([
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const result = await chatCompletions({
      body: { model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "Hello" }] },
      headers: {},
    }, connection(stored()));
    const text = await readStream(result.body);
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  });

  it("translates a responses request into a response object", async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as { messages?: Array<{ role?: string }> };
      assert.equal(body.messages?.[0]?.role, "user");
      return Response.json({
        id: "msg_1",
        type: "message",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    };
    const result = await responses({
      body: { model: "claude-sonnet-4-6", input: "Hello" },
      headers: {},
    }, connection(stored()));
    const payload = JSON.parse(await readStream(result.body)) as { object?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: { input_tokens?: number } };
    assert.equal(result.status, 200);
    assert.equal(payload.object, "response");
    assert.equal(payload.output?.[0]?.content?.[0]?.text, "Hi");
    assert.equal(payload.usage?.input_tokens, 2);
  });

  it("reports cache creation on chat usage and parseUsage", async () => {
    globalThis.fetch = async () => Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
    });
    const result = await chatCompletions({
      body: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hello" }] },
      headers: {},
    }, connection(stored()));
    const completion = JSON.parse(await readStream(result.body)) as {
      usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number } };
    };
    assert.equal(completion.usage.prompt_tokens, 9);
    assert.equal(completion.usage.prompt_tokens_details.cached_tokens, 2);
    assert.equal(completion.usage.prompt_tokens_details.cache_write_tokens, 4);
    assert.deepEqual(result.parseUsage?.([completion]), {
      inputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    });
  });

  it("reports cache creation on responses usage and parseUsage", async () => {
    globalThis.fetch = async () => Response.json({
      id: "msg_1",
      type: "message",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
    });
    const result = await responses({
      body: { model: "claude-sonnet-4-6", input: "Hello" },
      headers: {},
    }, connection(stored()));
    const payload = JSON.parse(await readStream(result.body)) as {
      usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
    };
    assert.equal(payload.usage?.input_tokens, 9);
    assert.equal(payload.usage?.input_tokens_details?.cache_write_tokens, 4);
    assert.deepEqual(result.parseUsage?.([payload]), {
      inputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    });
  });

  it("keeps message_start cache writes after a message_delta that only has output tokens", async () => {
    globalThis.fetch = async () => new Response([
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          usage: { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
        },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      })}\n\n`,
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const result = await chatCompletions({
      body: { model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "Hello" }] },
      headers: {},
    }, connection(stored()));
    const frames = sseDataFrames(await readStream(result.body));
    const cacheWrite = frames.map(frameCacheWrite).findLast((value) => value !== undefined);
    assert.equal(cacheWrite, 4);
    assert.deepEqual(result.parseUsage?.(frames), {
      inputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    });
  });

  it("rejects responses that depend on stored state", async () => {
    await assert.rejects(
      responses({ body: { model: "claude-sonnet-4-6", previous_response_id: "resp_1", input: "Hi" }, headers: {} }, connection(stored())),
      (error: unknown) => {
        assert.equal(error instanceof Error && "statusCode" in error && error.statusCode, 400);
        return true;
      },
    );
  });

  it("uses the static catalog when model listing is rejected", async () => {
    globalThis.fetch = async () => new Response("no", { status: 401 });
    const models = await listModels({ headers: {} }, connection(stored()));
    assert.equal(models.object, "list");
    assert.equal(models.data.some((model) => model.id === "claude-opus-4-8"), true);
  });
});

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    deviceId: "a".repeat(64),
    sessionId: "11111111-2222-4333-8444-555555555555",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function connection(credentials: unknown): ProviderConnection {
  return { connectionId: "c1", providerId: "claude", credentials };
}

async function readStream(body: ReadableStream<Uint8Array> | null): Promise<string> {
  assert.ok(body);
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}

function sseDataFrames(text: string): unknown[] {
  const frames: unknown[] = [];
  for (const part of text.split(/\r?\n\r?\n/)) {
    const data = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    frames.push(JSON.parse(data) as unknown);
  }
  return frames;
}

function frameCacheWrite(frame: unknown): number | undefined {
  if (!frame || typeof frame !== "object" || !("usage" in frame)) return undefined;
  const usage = frame.usage;
  if (!usage || typeof usage !== "object" || !("prompt_tokens_details" in usage)) return undefined;
  const details = usage.prompt_tokens_details;
  if (!details || typeof details !== "object" || !("cache_write_tokens" in details)) return undefined;
  return typeof details.cache_write_tokens === "number" ? details.cache_write_tokens : undefined;
}
