# Starlink Enterprise MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Starlink API](https://img.shields.io/badge/Starlink-Enterprise%20v2-blue)](https://starlink.readme.io/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-green)](https://modelcontextprotocol.io/)
[![Cloud Run](https://img.shields.io/badge/Cloud%20Run-Hosted-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

> 🛰️ **Hosted, multi-account MCP for the Starlink Enterprise API**
> Any AI agent — Claude, ChatGPT, anything that speaks MCP — connects with a real
> Starlink **V2 Service Account**, drives the full Enterprise API, and stays
> connected indefinitely. The Client Secret never touches the model.

## ⚡ Features

- 🔐 **Hosted OAuth proxy with API-key login** — The server *is* the OAuth 2.1 authorization server. But Starlink has no interactive OAuth and no MFA, so the browser login page doesn't ask for a username and password — it asks for a **Service Account Client ID + Client Secret**. The server validates them with a `client_credentials` grant; credentials never enter the model's context.
- 🔁 **Transparent token re-minting** — Starlink bearer tokens are short-lived (~15 min) and have no refresh token. The server stores the service-account credentials alongside the issued MCP token and silently re-mints a fresh bearer before expiry, and again on any `401`. AI sessions stay alive across long conversations.
- 🍪 **Stateless login state** — OAuth pending state rides in HMAC-signed `HttpOnly` cookies, so logins survive container restarts and Cloud Run instance switches.
- 🗄️ **Firestore persistence** — Issued tokens and DCR client registrations survive deploys and scaling events when `MCP_PERSISTENCE=firestore`.
- 🤝 **Claude *and* ChatGPT support** — Public-client dynamic registration (`token_endpoint_auth_method=none`, PKCE only) means ChatGPT connects out of the box alongside confidential clients like Claude.
- 🧬 **55 auto-generated tools from the spec** — The Starlink Enterprise v2 OpenAPI spec, regenerated on every build. Drop in a new spec and rebuild to pick up new endpoints.
- 🎯 **No curated layer needed** — At 55 operations the full tool surface fits comfortably in a model's working memory, so every tool is exposed directly with read/write/destructive annotations.
- ♾️ **Stateless by default** — No `Mcp-Session-Id`, no in-memory session map, no session affinity. Any instance can serve any request, so autoscaling and cold starts stop breaking mid-conversation.
- 🧾 **Typed results** — Every tool declares an `outputSchema` derived from the OpenAPI response, and returns matching `structuredContent`. The model gets a typed object, not an opaque JSON blob.
- 🪛 **Operator-tunable** — Disable globs (`MCP_DISABLED_TOOLS=delete_*,*reboot*`), a semantic destructive toggle (`MCP_DISABLE_DESTRUCTIVE=true`), branded login page (`MCP_LOGIN_HEADER`, `MCP_ICON_URL`). No code change for per-deployment policy.
- 🧪 **A real test suite** — 108 tests, including a draft-2020-12 JSON Schema guard that compiles every tool's input *and* output schema on every run, and end-to-end JSON-RPC over the actual transport.

## 🔑 How auth differs from a username/password MCP

| | Username/password OAuth proxy | This server (Starlink) |
|---|---|---|
| Login page collects | username + password | **Service Account Client ID + Client Secret** |
| Upstream grant | `password` (+ MFA) | `client_credentials` |
| MFA | yes | none (service accounts skip MFA) |
| Refresh | upstream refresh token | **re-run `client_credentials`** (no refresh token) |
| Token TTL | hours | ~15 min, re-minted on expiry / 401 |

The DCR + browser-redirect OAuth shell is identical — what changed is the login form and the upstream grant.

## 🏗️ Architecture

```
AI client (Claude/ChatGPT)
  │  OAuth 2.1 DCR + browser login (PKCE)
  ▼
[ Starlink MCP HTTP server (this repo) ]   ← OAuth proxy, login page (Client ID + Secret), cookies, Firestore
  │  per-account Starlink bearer (client_credentials)
  ▼
[ Starlink Enterprise API  https://www.starlink.com/api ]
```

Each issued MCP bearer maps to a stored upstream Starlink token **plus** the
service-account credentials used to mint it, so the server can re-mint silently.

## 💻 Running locally (stdio)

```bash
npm install
npm run build
export STARLINK_CLIENT_ID=<your-service-account-client-id>
export STARLINK_CLIENT_SECRET=<your-service-account-secret>
npm start                                      # MCP_TRANSPORT defaults to stdio
```

Create a V2 service account at **[Account Settings → API V2 Service Accounts](https://www.starlink.com/account/settings)**
(requires the *Admin* or *Service Account Management* role).

Add this entry to your local MCP client config (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "starlink": {
      "command": "node",
      "args": ["/path/to/starlink-enterprise-mcp/build/index.js"],
      "env": {
        "STARLINK_CLIENT_ID": "...",
        "STARLINK_CLIENT_SECRET": "..."
      }
    }
  }
}
```

You can also set `STARLINK_ACCESS_TOKEN` directly to skip the grant if you
already hold a bearer.

## 🌐 Running as a hosted server (HTTP)

```bash
export MCP_TRANSPORT=http
export MCP_PORT=3000
export MCP_BASE_URL=https://mcp.example.com
export MCP_SESSION_SECRET=<32+ random hex>     # signs login-state cookies
npm start
```

Connect from Claude / ChatGPT by giving it the URL `https://mcp.example.com/mcp`.
The client DCR-registers, redirects the user to `/authorize`, the user pastes
their Service Account Client ID + Secret, and the bearer flows back to the AI
automatically. **No upstream operator credentials are needed in HTTP mode** —
each user brings their own service account.

### Pass-through mode (credentials configured in the MCP client)

Set `MCP_AUTH_MODE=passthrough` and the connector supplies the Starlink Service
Account as its **OAuth client_id + client_secret** (configured in Claude/ChatGPT,
not on a login page). The server treats any presented `client_id` as a dynamic
client, then at the `/token` exchange validates the `client_secret` against
Starlink's `client_credentials` grant — a successful grant *is* the
authentication. The credentials are then bound to that session and re-minted as
usual. No login page, no server-side credentials, fully multi-tenant.

```bash
export MCP_AUTH_MODE=passthrough
```

In the client's connector setup, point it at `https://…/mcp` and enter your
Starlink Service Account **Client ID** and **Client Secret** as the OAuth client
credentials. Requirements: the client must use the authorization-code flow with
PKCE and send the `client_secret` at the token endpoint (`client_secret_post`).

### Single-account mode (skip the login page)

If you set `STARLINK_CLIENT_ID` + `STARLINK_CLIENT_SECRET` on the **server**, the
`/authorize` step auto-logs-in with those and the credential-entry page is never
shown — every user who connects shares that one Starlink account. Leave them
unset for the multi-tenant login-page behavior above.

```bash
export STARLINK_CLIENT_ID=<service-account-id>
export STARLINK_CLIENT_SECRET=<service-account-secret>
```

> Trade-off: in single-account mode the endpoint is only as private as its URL —
> DCR registration is open, so anyone who can reach `/mcp` and complete the
> (credential-free) OAuth flow uses that shared account. Put it behind access
> control, or accept that the URL is the secret.

## ☁️ Cloud Run deployment

Ships with a Cloud Run-friendly `Dockerfile`.

| Component | Purpose |
|---|---|
| Cloud Run service | Runs the HTTP server. No session affinity or `min-instances` needed in the default stateless mode |
| Firestore (native mode) | Persistent token store and DCR client registry |
| Cloud Run SA → `roles/datastore.user` | Firestore access |

Pushes to `main` deploy through `.github/workflows/deploy.yml`, which runs the
suite, builds the image in the runner, pushes it to Artifact Registry, and
deploys it by digest. It then asserts the live revision is that digest, that an
unauthenticated `/mcp` answers 401, and that pass-through advertises no
`registration_endpoint`.

It does not use `gcloud builds submit`. That path stages a source tarball in the
legacy `gs://<project>_cloudbuild` bucket and is refused under the external
account credentials GitHub Actions federates with, whatever storage role the
deploy identity holds.

To deploy by hand from a checkout instead:

```bash
image=<region>-docker.pkg.dev/<project>/cloud-run-source-deploy/starlink-enterprise-mcp
docker build -t "$image:$(git rev-parse HEAD)" .
docker push "$image:$(git rev-parse HEAD)"
gcloud run deploy starlink-enterprise-mcp --image "$image:$(git rev-parse HEAD)" \
  --region=<region> --project=<project> --port=3000
```

Required env vars on Cloud Run:

| Var | Notes |
|---|---|
| `MCP_TRANSPORT=http` | enable the HTTP transport |
| `MCP_BASE_URL` | public URL, e.g. `https://mcp.example.com` |
| `MCP_SESSION_SECRET` | 32+ chars; signs login-state cookies & must be stable across instances |
| `MCP_PERSISTENCE=firestore` | enable Firestore-backed tokens and clients |
| `GOOGLE_CLOUD_PROJECT` | Firestore project ID (auto-set on Cloud Run) |

Transport and protocol options:

| Var | Default | Notes |
|---|---|---|
| `MCP_STATELESS` | `true` | `false` restores `Mcp-Session-Id` sessions (single instance only) |
| `MCP_JSON_RESPONSE` | `false` | Return plain JSON instead of SSE, for intermediaries that break event streams |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated allowlist; a non-matching `Origin` gets 403 |
| `MCP_STRUCTURED_OUTPUT` | `true` | `false` drops `outputSchema` and `structuredContent` together |
| `MCP_TOOLS_PAGE_SIZE` | `0` (one page) | Page size for `tools/list` cursor pagination |
| `MCP_TASKS` | `false` | Enable task augmentation (see above) |
| `MCP_TASKS_COLLECTION` | `mcp_tasks` | Firestore collection for task state |
| `MCP_WEBSITE_URL` | Starlink API docs | `websiteUrl` advertised at initialize |

Also optional: `STARLINK_API_URL`, `STARLINK_TOKEN_URL` (defaults are correct
for production), `MCP_LOGIN_HEADER`, `MCP_ICON_URL`, `MCP_LOGIN_LOGO_URL`,
`MCP_DISABLED_TOOLS`, `MCP_DISABLED_ACTIONS`, `MCP_DISABLE_DESTRUCTIVE`,
`MCP_CORS_ORIGIN`.

> `MCP_ICON_URL` now does double duty: it still serves the favicon and login-page
> logo, and it is also advertised as the server's MCP `icons` entry so clients
> can render it in a connector list.

Other targets: `fly.toml` (Fly.io), `render.yaml` (Render), `railway.toml`
(Railway), `docker-compose.yml`, and `k8s/` manifests (apply with
`kubectl apply -k k8s/`).

> **Security note on persistence.** In HTTP mode the issued-token records hold
> each user's Starlink service-account Client ID + Secret so the server can
> re-mint bearers. Protect the token store accordingly — restrict the Firestore
> collection / file volume, and rotate `MCP_SESSION_SECRET` and service-account
> secrets per Starlink's guidance if exposure is suspected.

## 🔐 OAuth flow (detailed)

1. AI client hits `GET /.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` for discovery.
2. AI client POSTs `/register` (RFC 7591 DCR). Public clients pass `token_endpoint_auth_method=none` and get back a `client_id` only; confidential clients also get a `client_secret`. Registrations persist in Firestore.
3. AI redirects the user's browser to `/authorize?...` with PKCE parameters. The server stores the pending request in a signed cookie (`mcp_pending_auth`, 15 min TTL) and renders the login page.
4. User submits their **Service Account Client ID + Client Secret** → server runs `POST {STARLINK_TOKEN_URL}` with `grant_type=client_credentials`. On success it stores the Starlink token + credentials and issues an authorization code.
5. The server redirects back to the AI client; cookies are cleared.
6. AI exchanges the code at `/token` for the MCP-issued bearer + refresh token.
7. On every `/mcp` request, the server verifies the bearer and transparently re-mints the upstream Starlink token if it's near expiry. On a `401` from the API, the client re-mints and retries once.

## 📐 MCP spec conformance

Targets **MCP 2025-11-25** and negotiates down to any revision the client asks
for (2025-06-18, 2025-03-26, 2024-11-05).

| Feature | Revision | Status |
|---|---|---|
| Streamable HTTP, **stateless** | 2025-03-26 | Default. `MCP_STATELESS=false` for sessions |
| `MCP-Protocol-Version` header validation | 2025-06-18 | Unsupported version → 400 |
| Structured output (`outputSchema` / `structuredContent`) | 2025-06-18 | 52 of 55 tools; `MCP_STRUCTURED_OUTPUT=false` to disable |
| Tool `title` display names | 2025-06-18 | All tools |
| OAuth Resource Server + protected-resource metadata | 2025-06-18 | RFC 9728 discovery, `WWW-Authenticate` |
| No JSON-RPC batching | 2025-06-18 | Not accepted |
| Icons on server and tools | 2025-11-25 (SEP-973) | From `MCP_ICON_URL` |
| `Implementation.description`, `title`, `websiteUrl` | 2025-11-25 | Sent at initialize |
| Invalid `Origin` → **403** | 2025-11-25 | Via `MCP_ALLOWED_ORIGINS` |
| Validation errors as tool errors, not protocol errors | 2025-11-25 (SEP-1303) | Arguments validated, types coerced |
| Tool-name format guidance | 2025-11-25 (SEP-986) | Validated at startup |
| JSON Schema 2020-12 as default dialect | 2025-11-25 (SEP-1613) | Input and output schemas |
| Tasks (durable requests, polling, deferred results) | 2025-11-25 (SEP-1686) | Opt-in via `MCP_TASKS=true` |
| `tools/list` cursor pagination | 2024-11-05 | Opt-in via `MCP_TOOLS_PAGE_SIZE` |
| `logging` capability + `logging/setLevel` | 2024-11-05 | Supported |

Not implemented, and why: **resources** and **prompts** (this server exposes an
API surface, not documents or templates), **completions** (nothing to complete
without prompts or resource templates), **sampling**, **elicitation**, and
**roots** (client-side features this server has no use for — every tool call is
fully specified by its arguments).

### Stateless vs. session mode

Stateless is the default. Each request gets a fresh `Server` and transport, and
no `Mcp-Session-Id` is issued.

This matters on any autoscaled host. With sessions, `initialize` builds
in-memory state on one instance, and the next `tools/call` gets load-balanced to
an instance that has never heard of that session ID — the client sees
`Invalid or missing session ID` and the conversation dies. Stateless has no
affinity requirement, so `min-instances=1` and session affinity stop being
load-bearing.

Nothing is given up here: this server sends no server-initiated messages. The
tool list is fixed at build time from the OpenAPI spec, and there are no
resources or prompts to subscribe to, so the standalone `GET /mcp` SSE stream
that sessions exist to support has nothing to carry. In stateless mode it
answers `405` rather than opening a stream that can never produce anything.

Set `MCP_STATELESS=false` on a single-instance deployment to restore sessions.

### Tasks

Off by default. A task-augmented `tools/call` returns a handle immediately and
the client collects the result later via `tasks/result`, decoupling the tool's
runtime from the HTTP request's lifetime.

Enabling it on Cloud Run needs two things that are not the default:

- **`--no-cpu-throttling`**, or the container is frozen once the response is
  sent and the detached work never finishes.
- **`MCP_PERSISTENCE=firestore`**, or the poll lands on an instance that has
  never heard of the task. With Firestore the store is shared and any instance
  can answer. Without it you get an in-memory store and a startup warning.

```bash
export MCP_TASKS=true
export MCP_PERSISTENCE=firestore     # required for more than one instance
```

Task documents live in `mcp_tasks` (override with `MCP_TASKS_COLLECTION`) and
carry an `expiresAt` field — set a Firestore TTL policy on it to have Firestore
reclaim them. Client-requested TTLs are clamped to 24 hours.

## 🧰 Tools

55 tools generated from `spec/starlink-enterprise-v2.json`, grouped by tag:

| Group | Examples |
|---|---|
| **Account** | `get_account`, `get_products`, `post_data_usage_query` |
| **Service Lines** | `get_service_lines`, `post_service_lines`, `put_service_line_nickname`, `post_service_line_data_top_up`, `patch_service_line_consume_from_pool` |
| **User Terminals** | `get_user_terminals`, `post_user_terminals`, `post_user_terminal_reboot`, `put_user_terminal_l2vpn` |
| **Routers** | `get_router`, `get_routers_configs`, `post_routers_configs`, `post_router_reboot`, `*_routers_configs_tls` |
| **Addresses** | `get_addresses`, `post_addresses`, `get_address`, `put_address` |
| **Contacts** | `get_contacts`, `post_contacts`, `put_contact`, `delete_contact` |
| **Data Pools** | `get_data_pools`, `get_data_pools_usage`, `post_data_pools_by_data_pool_id_set_automatic_top_up` |
| **Flights** | `post_flights_status` (aviation accounts) |
| **Managed** | `post_managed_customers` (provider accounts) |

Each tool carries a human-readable `title`, an `inputSchema`, an `outputSchema`,
and the full annotation set: `readOnlyHint`, `destructiveHint`, `idempotentHint`
(GET/PUT/DELETE), and `openWorldHint`. Reboots and deletes are flagged
destructive — hide them all with `MCP_DISABLE_DESTRUCTIVE=true`, or selectively
with e.g. `MCP_DISABLED_TOOLS=delete_*,*reboot*`.

Tool names map 1:1 to operations (`{method}_{path}`, with the `/public/v2`
prefix stripped). Two deep service-line paths are abbreviated to fit the MCP
64-character name limit.

### Result shape

Results carry `structuredContent` matching the tool's `outputSchema`, shaped
like the Starlink response envelope — payload under `content`, plus `isValid`:

```jsonc
{
  "content": [{ "type": "text", "text": "{ \"content\": { \"accountNumber\": \"ACC-…\" } }" }],
  "structuredContent": { "content": { "accountNumber": "ACC-…", "regionCode": "US" }, "isValid": true }
}
```

The schemas are deliberately permissive: no `required`, no
`additionalProperties: false`, and `nullable` fields widened to a type union. A
Starlink response that has drifted from the published spec still validates
rather than being rejected by a strict client. If a client is still unhappy,
`MCP_STRUCTURED_OUTPUT=false` drops both the schemas and the structured results
in one move.

**Errors come back in the result, not as protocol errors.** A permission
failure, a bad argument, or an operator-disabled tool returns
`isError: true` with an explanatory message, so the model can read what went
wrong and retry. Only an unknown tool name is a JSON-RPC error. Arguments are
validated against the input schema before any call is made, and obvious type
mismatches (`"50"` for a number) are coerced rather than rejected.

## 🔄 Regenerating tools

The spec lives at `spec/starlink-enterprise-v2.json` (sourced from
`https://web-api.starlink.com/enterprise/swagger/v2/swagger.json`). That host
now serves Starlink's consumer web app and no longer carries this path, and
the new spec location is not known. Do not guess a replacement URL. To refresh
once a real source turns up:

```bash
# drop a new spec into spec/starlink-enterprise-v2.json, then:
npm run generate      # rewrites src/generated/
npm run build
npm test
```

`npm run build` runs `generate` automatically via the `prebuild` hook.

## 🧪 Tests

```bash
npm test
```

The Firestore-backed tests are emulator-gated and skip cleanly without one.

## 📋 What this server is

- **Two MCP transports.** `stdio` for local CLI integrations and `http` (Streamable HTTP, stateless by default) for hosted deployments. Production uses `http`.
- **MCP 2025-11-25**, negotiating down to older revisions on request.
- **Auto-generated tools** from the Starlink Enterprise v2 OpenAPI spec, regenerated on every build, with typed `structuredContent` results.
- **Hosted OAuth login** where the login page collects Starlink Service Account credentials (Client ID + Secret), not a username/password. MFA does not apply to service accounts.
- **Transparent token re-minting** via `client_credentials` (no refresh token).
- **Firestore persistence** for tokens and DCR clients when `MCP_PERSISTENCE=firestore`.

## License

MIT
