import { createHash, randomBytes } from "node:crypto";
import {
  modelList,
  parseOpenAIChatUsage,
  parseOpenAIResponsesUsage,
  type CredentialsWrite,
  type HttpExchange,
  type JsonGetRequest,
  type JsonPostRequest,
  type KeepaliveInput,
  type KeepaliveResult,
  type ModelList,
  type OAuthExchangeInput,
  type OAuthStartContext,
  type OAuthStartResult,
  type PluginContext,
  type ProviderConnection,
  type SubscriptionInput,
  type SubscriptionResult,
  type SubscriptionUsage,
  type ViatePlugin,
} from "@viateai/sdk";
import { chatCompletionToResponse, responsesRequestToChat, streamResponses } from "./responses.js";
import {
  CLAUDE_CODE_VERSION,
  buildAnthropicRequest,
  streamAnthropicToOpenAI,
  toOpenAIChatCompletion,
} from "./translate.js";

const PROVIDER_ID = "claude";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
const MODELS_URL = "https://api.anthropic.com/v1/models";
const REDIRECT_URI = "http://localhost:54545/callback";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SUBSCRIPTION_DUE_MS = 10 * 60 * 1000;
const AUTHORIZE_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REFRESH_SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const BASE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
const FALLBACK_MODELS = [
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-opus-4-7", "Claude Opus 4.7"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
] as const;

export type ClaudeCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  email?: string;
  accountId?: string;
  organizationId?: string;
  organizationName?: string;
  deviceId: string;
  sessionId: string;
};

export const plugin: ViatePlugin = {
  id: PROVIDER_ID,
  register(ctx: PluginContext) {
    ctx.registerProvider({
      id: PROVIDER_ID,
      credentialsForm: [
        { key: "accessToken", label: "Access token", kind: "secret" },
        { key: "refreshToken", label: "Refresh token", kind: "secret" },
      ],
      normalizeCredentials,
      startOAuth,
      exchangeOAuth,
      keepalive,
      subscription,
      chatCompletions,
      responses,
      listModels,
    });
  },
};

export default plugin;

export function parseCredentials(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Claude OAuth token is required");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown;
  return { accessToken: trimmed };
}

export function normalizeCredentials(input: unknown): CredentialsWrite {
  const source = record(input) ?? {};
  const nestedAccount = record(source.account);
  const nestedOrg = record(source.organization);
  const accessToken = firstString(
    typeof input === "string" ? input.trim() : undefined,
    stringValue(source.access_token),
    stringValue(source.accessToken),
    stringValue(source.token),
  );
  if (!accessToken) throw new Error("Claude OAuth credentials contain no access token");
  const refreshToken = firstString(stringValue(source.refresh_token), stringValue(source.refreshToken));
  const email = firstString(
    stringValue(source.email),
    stringValue(nestedAccount?.email_address),
    stringValue(nestedAccount?.email),
  );
  const accountId = firstString(
    stringValue(source.accountId),
    stringValue(source.account_uuid),
    stringValue(nestedAccount?.uuid),
  );
  const organizationId = firstString(
    stringValue(source.organizationId),
    stringValue(source.organization_uuid),
    stringValue(nestedOrg?.uuid),
  );
  const organizationName = firstString(
    stringValue(source.organizationName),
    stringValue(source.organization_name),
    stringValue(nestedOrg?.name),
  );
  const expiresAt = resolveExpiresAt(source);
  const deviceId = validDevice(firstString(stringValue(source.deviceId), stringValue(source.device_id))) ?? randomBytes(32).toString("hex");
  const sessionId = validSession(firstString(stringValue(source.sessionId), stringValue(source.session_id))) ?? crypto.randomUUID();
  const credentials: ClaudeCredentials = {
    accessToken,
    deviceId,
    sessionId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(organizationName ? { organizationName } : {}),
  };
  return {
    credentials,
    displayLabel: email ?? organizationName ?? `Claude …${accessToken.slice(-6)}`,
  };
}

export async function startOAuth(ctx: OAuthStartContext): Promise<OAuthStartResult> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = new URL(ctx.callbackUrl);
  const state = callback.searchParams.get("state") || crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code: "true",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: AUTHORIZE_SCOPE,
    state,
  });
  return {
    type: "authorization_url",
    authorizationUrl: `${AUTH_URL}?${params.toString()}`,
    session: { verifier, redirectUri: REDIRECT_URI },
  };
}

export async function exchangeOAuth(input: OAuthExchangeInput): Promise<CredentialsWrite> {
  const session = record(input.session);
  const verifier = stringValue(session?.verifier);
  const parsed = splitCode(input.code);
  const code = parsed.code;
  const state = parsed.state ?? stringValue(input.state) ?? "";
  if (!verifier || !code) throw new Error("Claude OAuth callback is missing code or PKCE verifier");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: axiosHeaders(),
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  });
  const token = await responseRecord(response, "Claude token exchange failed");
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error("Claude token response did not include an access token");
  const identity = await lookupIdentity(accessToken);
  return normalizeCredentials({ ...token, ...fillIdentity(token, identity), access_token: accessToken });
}

export async function keepalive(input: KeepaliveInput): Promise<KeepaliveResult> {
  const credentials = readCredentials(input.credentials);
  const dueMs = millisecondsUntilRefresh(credentials.expiresAt);
  if (dueMs > 0) return { status: "ok", nextDueMs: dueMs };
  if (!credentials.refreshToken) {
    const error = "Claude access token expired";
    input.log.warn({ status: "needs_reauth", error }, "token refresh failed");
    return { status: "needs_reauth", error };
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { ...axiosHeaders(), "anthropic-beta": "oauth-2025-04-20" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      scope: REFRESH_SCOPE,
    }),
    signal: input.signal,
  });
  const token = record(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const detail = firstString(stringValue(token.error_description), stringValue(record(token.error)?.message), stringValue(token.error));
    const status = response.status === 400 || response.status === 401 ? "needs_reauth" : "failed";
    const error = `Claude token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`;
    input.log.warn({ status, error, httpStatus: response.status }, "token refresh failed");
    return { status, error, ...(status === "failed" ? { nextDueMs: retryAfterMs(response) } : {}) };
  }
  const normalized = normalizeCredentials({
    ...credentials,
    ...token,
    refresh_token: stringValue(token.refresh_token) ?? credentials.refreshToken,
    deviceId: credentials.deviceId,
    sessionId: credentials.sessionId,
    organizationId: credentials.organizationId,
    organizationName: credentials.organizationName,
  });
  const refreshed = normalized.credentials as ClaudeCredentials;
  return { status: "ok", ...normalized, nextDueMs: millisecondsUntilRefresh(refreshed.expiresAt) };
}

export async function subscription(input: SubscriptionInput): Promise<SubscriptionResult> {
  const credentials = readCredentials(input.credentials);
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      signal: input.signal,
    });
  } catch {
    input.log.warn({ status: "failed", error: "Claude usage request failed" }, "subscription refresh failed");
    return { status: "failed", error: "Claude usage request failed", nextDueMs: SUBSCRIPTION_DUE_MS };
  }
  if (response.status === 401 || response.status === 403) {
    const error = "Claude session expired";
    input.log.warn({ status: "needs_reauth", error, httpStatus: response.status }, "subscription refresh failed");
    return { status: "needs_reauth", error };
  }
  if (!response.ok) {
    const error = `Claude usage endpoint error (${response.status})`;
    input.log.warn({ status: "failed", error, httpStatus: response.status }, "subscription refresh failed");
    return { status: "failed", error, nextDueMs: SUBSCRIPTION_DUE_MS };
  }
  const data = record(await response.json().catch(() => null));
  if (!data) {
    const error = "Claude usage response was not JSON";
    input.log.warn({ status: "failed", error }, "subscription refresh failed");
    return { status: "failed", error, nextDueMs: SUBSCRIPTION_DUE_MS };
  }
  const usages: SubscriptionUsage[] = [];
  pushWindow(usages, data.five_hour, "five_hour", "5-hour limit", "Session");
  pushWindow(usages, data.seven_day, "seven_day", "Weekly limit", "Week");
  pushWindow(usages, data.seven_day_opus, "seven_day_opus", "Weekly Opus", "Week");
  pushWindow(usages, data.seven_day_sonnet, "seven_day_sonnet", "Weekly Sonnet", "Week");
  const extra = extraUsage(record(data.extra_usage));
  if (extra) usages.push(extra);
  return {
    status: "ok",
    plan: credentials.organizationName ?? "Claude",
    usages,
    nextDueMs: SUBSCRIPTION_DUE_MS,
  };
}

export async function chatCompletions(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  const credentials = readCredentials(connection.credentials);
  const built = buildAnthropicRequest(record(request.body) ?? {}, credentials);
  let upstream: Response;
  try {
    upstream = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: inferenceHeaders(credentials, request.headers["anthropic-beta"]),
      body: built.bytes,
      signal: request.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (upstream.status >= 400) {
    return { status: upstream.status, headers: pickContentType(upstream.headers), body: upstream.body };
  }
  if (built.stream) {
    return {
      status: upstream.status,
      headers: { "content-type": "text/event-stream" },
      body: streamAnthropicToOpenAI(upstream.body, built.model),
      parseUsage: parseOpenAIChatUsage,
    };
  }
  const text = await upstream.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return {
      status: 502,
      headers: { "content-type": "application/json" },
      body: jsonBody({ error: { message: "upstream response was not JSON", type: "viate_error" } }),
    };
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: jsonBody(toOpenAIChatCompletion(built.model, payload)),
    parseUsage: parseOpenAIChatUsage,
  };
}

export async function responses(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  const converted = responsesRequestToChat(record(request.body) ?? {});
  if (!converted.ok) throw Object.assign(new Error(converted.message), { statusCode: converted.status });
  const result = await chatCompletions({ ...request, body: converted.chat }, connection);
  if (result.status >= 400) return result;
  const model = stringValue(converted.chat.model) ?? "";
  if (converted.chat.stream === true) {
    return {
      ...result,
      headers: { "content-type": "text/event-stream" },
      body: streamResponses(result.body, model),
      parseUsage: parseOpenAIResponsesUsage,
    };
  }
  const completion: unknown = JSON.parse(await new Response(result.body).text());
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: jsonBody(chatCompletionToResponse(completion)),
    parseUsage: parseOpenAIResponsesUsage,
  };
}

export async function listModels(request: JsonGetRequest, connection: ProviderConnection): Promise<ModelList> {
  const credentials = readCredentials(connection.credentials);
  try {
    const collected: Array<{ id: string; name?: string; owned_by: string; context_length?: number }> = [];
    let afterId: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(MODELS_URL);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credentials.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        },
        signal: request.signal,
      });
      if (!response.ok) return fallbackModels();
      const payload: unknown = JSON.parse(await response.text());
      const pageModels = readModelPage(payload);
      collected.push(...pageModels.models);
      if (!pageModels.next || pageModels.next === afterId) break;
      afterId = pageModels.next;
    }
    if (collected.length === 0) return fallbackModels();
    return modelList(collected);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fallbackModels();
  }
}

async function lookupIdentity(accessToken: string): Promise<Record<string, string>> {
  const profile = await fetch(PROFILE_URL, { headers: { ...axiosHeaders(), authorization: `Bearer ${accessToken}`, "cache-control": "no-cache" } })
    .then(async (response) => response.ok ? record(await response.json()) : undefined)
    .catch(() => undefined);
  const account = record(profile?.account);
  const organization = record(profile?.organization);
  const identity: Record<string, string> = {};
  assign(identity, "email", firstString(stringValue(account?.email), stringValue(account?.email_address)));
  assign(identity, "accountId", stringValue(account?.uuid));
  assign(identity, "organizationId", stringValue(organization?.uuid));
  assign(identity, "organizationName", stringValue(organization?.name));
  if (identity.email && identity.accountId) return identity;
  const bootstrap = await fetch(`${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent("claude-opus-4-8")}`, {
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "anthropic-beta": "oauth-2025-04-20",
    },
  }).then(async (response) => response.ok ? record(await response.json()) : undefined).catch(() => undefined);
  const oauth = record(bootstrap?.oauth_account);
  assign(identity, "email", identity.email ?? stringValue(oauth?.account_email));
  assign(identity, "accountId", identity.accountId ?? stringValue(oauth?.account_uuid));
  assign(identity, "organizationId", identity.organizationId ?? stringValue(oauth?.organization_uuid));
  assign(identity, "organizationName", identity.organizationName ?? stringValue(oauth?.organization_name));
  return identity;
}

function fillIdentity(token: Record<string, unknown>, identity: Record<string, string>): Record<string, unknown> {
  const account = record(token.account);
  const organization = record(token.organization);
  return {
    email: identity.email ?? stringValue(account?.email_address),
    accountId: identity.accountId ?? stringValue(account?.uuid),
    organizationId: identity.organizationId ?? stringValue(organization?.uuid),
    organizationName: identity.organizationName ?? stringValue(organization?.name),
  };
}

function inferenceHeaders(credentials: ClaudeCredentials, inboundBeta: string | undefined): Record<string, string> {
  const betas = [...BASE_BETAS];
  for (const beta of (inboundBeta ?? "").split(",")) {
    const trimmed = beta.trim();
    if (trimmed && !betas.includes(trimmed)) betas.push(trimmed);
  }
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${credentials.accessToken}`,
    "user-agent": USER_AGENT,
    "x-app": "cli",
    "anthropic-beta": betas.join(","),
    "anthropic-version": "2023-06-01",
    "x-claude-code-session-id": credentials.sessionId,
    "x-client-request-id": crypto.randomUUID(),
    "x-stainless-lang": "js",
    "x-stainless-runtime": "node",
    "x-stainless-package-version": "0.128.0",
    "x-stainless-runtime-version": process.version,
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
  };
}

function axiosHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": "axios/1.15.2",
    "accept-encoding": "gzip, compress, deflate, br",
  };
}

function readModelPage(payload: unknown): { models: Array<{ id: string; name?: string; owned_by: string; context_length?: number }>; next: string | null } {
  const root = record(payload);
  const data = root && Array.isArray(root.data) ? root.data : [];
  const models: Array<{ id: string; name?: string; owned_by: string; context_length?: number }> = [];
  for (const item of data) {
    const model = record(item);
    const id = model ? stringValue(model.id) : undefined;
    if (!id) continue;
    const name = stringValue(model?.display_name) ?? stringValue(model?.name);
    const context = typeof model?.max_input_tokens === "number"
      ? model.max_input_tokens
      : typeof model?.context_length === "number" ? model.context_length : undefined;
    models.push({
      id,
      owned_by: "anthropic",
      ...(name && name !== id ? { name } : {}),
      ...(context && context > 0 ? { context_length: context } : {}),
    });
  }
  const lastId = root ? stringValue(root.last_id) : undefined;
  return { models, next: root?.has_more === true && lastId ? lastId : null };
}

function fallbackModels(): ModelList {
  return modelList(FALLBACK_MODELS.map(([id, name]) => ({ id, name, owned_by: "anthropic" })));
}

function pushWindow(usages: SubscriptionUsage[], value: unknown, type: string, label: string, group: string): void {
  const window = record(value);
  const raw = typeof window?.utilization === "number" && Number.isFinite(window.utilization) ? window.utilization : undefined;
  if (raw === undefined) return;
  const used = Math.round(Math.min(100, Math.max(0, raw)) * 100) / 100;
  const resetsAt = isoTimestamp(window?.resets_at);
  usages.push({
    type,
    label,
    group,
    unit: "percent",
    used,
    limit: 100,
    remaining: Math.round((100 - used) * 100) / 100,
    ...(resetsAt ? { resetsAt } : {}),
  });
}

function extraUsage(value: Record<string, unknown> | undefined): SubscriptionUsage | undefined {
  if (!value || value.is_enabled === false) return undefined;
  const usedCents = typeof value.used_credits === "number" ? value.used_credits : undefined;
  const limitCents = typeof value.monthly_limit === "number" ? value.monthly_limit : undefined;
  if (usedCents === undefined && limitCents === undefined) return undefined;
  const used = usedCents === undefined ? null : usedCents / 100;
  const unlimited = limitCents === 0;
  const limit = limitCents === undefined || unlimited ? null : limitCents / 100;
  const remaining = used !== null && limit !== null ? Math.max(0, limit - used) : null;
  return {
    type: "extra_usage",
    label: "Extra usage",
    group: "Extra",
    unit: "currency",
    currency: stringValue(value.currency) ?? "USD",
    used,
    limit,
    remaining,
    ...(unlimited ? { unlimited: true } : {}),
  };
}

function readCredentials(input: unknown): ClaudeCredentials {
  return normalizeCredentials(input).credentials as ClaudeCredentials;
}

function splitCode(raw: string | undefined): { code?: string; state?: string } {
  let code = raw?.trim();
  if (!code) return {};
  if (code.startsWith("http://") || code.startsWith("https://")) {
    try {
      code = new URL(code).searchParams.get("code") ?? code;
    } catch {
      // Keep the raw value when it is not a URL.
    }
  }
  const hash = code.indexOf("#");
  if (hash < 0) return { code };
  return { code: code.slice(0, hash), state: code.slice(hash + 1) || undefined };
}

function resolveExpiresAt(source: Record<string, unknown>): string | undefined {
  if (typeof source.expires_in === "number" && Number.isFinite(source.expires_in) && source.expires_in > 0) {
    return new Date(Date.now() + source.expires_in * 1000).toISOString();
  }
  const explicit = firstString(stringValue(source.expires_at), stringValue(source.expiresAt), stringValue(source.expired));
  if (explicit && !Number.isNaN(Date.parse(explicit))) return new Date(Date.parse(explicit)).toISOString();
  return undefined;
}

function millisecondsUntilRefresh(expiresAt: string | undefined): number {
  if (!expiresAt) return 60 * 60 * 1000;
  return Math.max(0, Date.parse(expiresAt) - Date.now() - REFRESH_SKEW_MS);
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 5 * 60 * 1000);
  return 5 * 60 * 1000;
}

async function responseRecord(response: Response, prefix: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = record(JSON.parse(text) as unknown) ?? {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = firstString(stringValue(data.error_description), stringValue(record(data.error)?.message), stringValue(data.error))
      ?? text.trim().slice(0, 300);
    throw new Error(`${prefix} (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

function pickContentType(headers: Headers): Record<string, string> {
  const contentType = headers.get("content-type");
  return contentType ? { "content-type": contentType } : {};
}

function jsonBody(value: unknown): ReadableStream<Uint8Array> | null {
  return new Response(JSON.stringify(value)).body;
}

function assign(target: Record<string, string>, key: string, value: string | undefined): void {
  if (value) target[key] = value;
}

function validDevice(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function validSession(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value);
}
