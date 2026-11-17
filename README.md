# @viateai/plugin-claude

Viate provider for a Claude Pro/Max subscription. Provider id: `claude`.

This is separate from `@viateai/plugin-anthropic`, which sends an API key to the Messages API. `claude` signs in with the Claude Code OAuth client and spends the subscription.

The gateway speaks OpenAI chat completions and responses. The plugin translates those onto `POST https://api.anthropic.com/v1/messages?beta=true`.

## Implementation references

The OAuth and request shape follow two public clients:

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) `internal/auth/claude` and `internal/runtime/executor` (Claude executor and `claude_signing.go`). That is the source for the OAuth client id, PKCE authorization on `https://claude.ai/oauth/authorize`, the registered redirect `http://localhost:54545/callback`, the authorize and refresh scopes, token exchange at `https://platform.claude.com/v1/oauth/token`, the Axios-shaped token headers, the `x-anthropic-billing-header` block, and the xxHash64 `cch` over the normalized Messages body. Usage is `GET https://api.anthropic.com/api/oauth/usage`.
- [omp](https://github.com/can1357/oh-my-pi) (`oh-my-pi`) `packages/catalog` auth rule `anthropic` and `packages/ai` Claude Code fingerprint. That is the source for the pinned Claude Code `2.1.321` user agent (`claude-cli/2.1.321 (external, cli)`), the bundled SDK `0.128.0`, the identity line `You are Claude Code, Anthropic's official CLI for Claude.`, the `oauth-2025-04-20` beta on refresh, and the `api/claude_cli/bootstrap` identity lookup when the token response has no account.

CLIProxyAPI's current code exchange posts to `platform.claude.com`. omp's rule still names `api.anthropic.com`. This plugin uses the platform host.

Not copied from those clients: TLS fingerprint impersonation, and prompt cloaking that rewrites the caller's system text.

## Connection

OAuth uses the Claude Code client, so the provider always redirects the browser to `http://localhost:54545/callback`. That address is on the computer running the browser, not on the gateway, and the plugin does not listen there. After login the page fails to load; copy the full address bar into the admin connection dialog. The dialog matches `code` and `state` and exchanges the code at the token endpoint. The gateway never needs port `54545`.

A pasted credential also works. A raw string is the access token. JSON accepts `access_token` or `accessToken`, `refresh_token` or `refreshToken`, and the `account` / `organization` objects returned by the token endpoint.

Stored credentials keep a device id and a session id. Those are sent as `metadata.user_id` and `X-Claude-Code-Session-Id`. Refresh uses the refresh token and keeps the same device, session, and organization.

`keepalive` refreshes the access token five minutes before `expiresAt`. `subscription` maps `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, and `extra_usage`.

`listModels` calls `GET /v1/models` with the OAuth token. If that call is rejected, the catalog falls back to the Claude Code model ids used by the references above.

Chat tools, tool results, text, and image URLs are translated. `previous_response_id`, conversation state, and background responses are rejected; send the full input.

## Install

This package is not published to npm. Clone the repository, compile it, and install that directory. `viate.entry` is `dist/index.js`, and `dist/` is not in git. The installer runs with `ignore-scripts=true`, so it will not compile the package for you.

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
git clone https://github.com/ViateAI/viate-plugin-claude.git
cd viate-plugin-claude
pnpm install
pnpm build
viate plugin add "$PWD"
```

`$PWD` is passed to `pnpm add` by the `viate` process. From the admin plugin source field, use the same directory as an absolute path that process can read.

`@viateai/sdk` is a peer of `1.0.1`; the gateway removes it at install and loads its own copy. `plugin add` stages a pending workspace. Restart the gateway to load it.

To install a newer checkout, pull, run `pnpm install` and `pnpm build` again, then `viate plugin add "$PWD"` again, and restart.

Plugins run in-process. Install only packages you trust. See [Viate](https://github.com/ViateAI/viate).

## Development

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Release Please on `main` owns the version and changelog. Do not edit either by hand.

MIT. See [LICENSE](LICENSE).
