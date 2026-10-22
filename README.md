# agents-gateway

> **⚠️ Alpha Version**: This project is currently in early alpha. Features and APIs may change.

### The same agent, the same question, three ways — and you can see which one guesses.

> A gateway that puts **Google, Anthropic and OpenAI** behind one API and runs each of them
> as a plain chat, as a chat with a **hand-rolled** tool loop, or on the provider's own
> **Agents SDK** — so the cost of each is something you measure instead of argue about.
> **Multimodal. Real cancellation. MCP. Containerised. Pure TypeScript.**

You have API keys for Gemini, Claude and GPT, and probably an MCP server exposing your
shell. This gateway bridges them — and, more to the point, it lets you watch the same agent
answer the same question three ways and see, on screen, where the answer stops being a
guess.

---

## The thesis

**"Chatting with a model" and "running an agent" are not the same activity, and the
difference is not the model — it is who runs the loop.**

Every provider now ships two SDKs: a plain one that returns a completion, and an agentic one
that runs the tool loop for you. It is tempting to treat the second as a wrapper you could
have written in an afternoon. This project exists to check that, by running the same agent,
on the same prompt, against the same tool, three ways:

| | `chat` | `chat` + `tools` | `agent` |
| --- | --- | --- | --- |
| SDK | plain | plain | Agents SDK |
| Who runs the tool loop | nobody | **you do, by hand** | the SDK |
| Tool-loop code you maintain | none | 109 shared + 89–137 per provider | **none** |

To be fair about that last row: the agent adapters in this repo are ~280 lines each, and the
chat ones are not much smaller. Both lanes need translation code — mapping a provider's
stream onto one event shape, carrying history, wiring MCP. What the last column is missing
is the *loop and its bookkeeping*, and that is the part that is easy to get subtly wrong.

The plain SDKs are `@anthropic-ai/sdk`, `openai` and `@google/generative-ai`; the agentic
ones are `@anthropic-ai/claude-agent-sdk`, `@openai/agents` and `@google/adk`.

### What it looks like when you run it

Same agent, same question — *run `whoami; pwd` and answer with the output* — inside the
container, where the true answer is `gateway` and `/workspace`:

| Lane | Tools called | Answer |
| --- | --- | --- |
| `chat` | none | **`root` / `/home/user`** — invented |
| `chat` + `tools` | `run_bash` | `gateway` / `/workspace` |
| `agent` | `mcp__gateway__run_bash` | `gateway` / `/workspace` |

The first row is the part worth sitting with. Asked a question about the world with no way
to look, the model did not say "I can't check that" — it produced a confident, plausible,
wrong answer. Tools are not a feature you bolt on for convenience; they are the difference
between an answer and a guess.

The second and third rows are identical in output and opposite in cost. That is the trade
this repository is about.

### What the Agents SDK actually does for you

Not "the `while` loop". The loop is the easy part. Turning `tools` on in the chat lane meant
writing, and keeping correct, all of this:

- Declaring each tool in that provider's dialect — `input_schema`, `function.parameters`
  and `functionDeclarations` are three different shapes of the same idea.
- Finding the call inside the stream. Arguments arrive as **JSON fragments** that you
  reassemble by content-block index; miss a fragment and you get a parse error instead of a
  tool call.
- Writing the call and its result back into that SDK's history format — Anthropic puts tool
  results in a `user` message, OpenAI in its own `tool` message keyed by `tool_call_id`,
  Gemini in `functionResponse` parts.
- Keeping the transcript valid when a turn dies halfway. An unanswered `tool_use` block
  poisons **every subsequent turn** of that conversation, so a failed turn has to roll the
  history back rather than leave it half-written.
- A turn cap, so a model that keeps asking for tools stops instead of billing you forever.
- Feeding tool *failures* back to the model, so it can correct course instead of stalling.

Every one of those is a place to be subtly wrong, and being subtly wrong shows up as "the
model got weird on turn three", not as a stack trace.

### What it does not do for you

Worth being straight about, because the honest version of the thesis is not "use the Agents
SDK and stop thinking":

- **Safety is still yours.** The deny-list, the timeout, the working directory and the
  container in this repo are ours, not the SDK's. `canUseTool` and `needsApproval` are hooks
  where you put your policy — they are not a policy.
- **Observability is still yours.** Normalising three event streams into one shape so you
  can compare them is this gateway's job.
- **Each SDK has real surface area.** It is not free; it is *different* work.

### What the comparison surfaced

Things that are invisible until you wire all three side by side, and that cost an afternoon
each if you meet them alone:

- **`@openai/agents` turns on tracing the moment you import it**, and ships prompts, tool
  inputs and tool outputs to `api.openai.com` using your `OPENAI_API_KEY`. One line in
  `main.ts` turns it off. Nothing warns you.
- **`@google/adk` does not read `GOOGLE_API_KEY`** — only `GOOGLE_GENAI_API_KEY` or
  `GEMINI_API_KEY`. The variable everyone already has set is the wrong one.
- **`@anthropic-ai/claude-agent-sdk` runs a bundled ~310 MB `claude` binary** as a
  subprocess, delivered as a per-platform optional dependency. `npm install --omit=optional`
  breaks it in a way that only appears on the first turn.
- **Its `resume` wants a session id the CLI itself minted**, not one you invented. Hand it
  your own and the subprocess exits with *"No conversation found"*.
- **The ADK streams partial text and then repeats the whole thing** in a final aggregate
  event. Forward both and every answer is duplicated on screen.

None of these are in the paragraph that says "just use the SDK". They are the reason the
comparison was worth building rather than reasoning about.

### How far this evidence goes

One prompt, one tool, one run per lane. It demonstrates the shape of the difference; it is
not a benchmark, and it says nothing about which provider is better. The value here is that
the three states are *reproducible on your machine, with your keys* — flip the lane in the
UI and watch it happen, rather than taking anyone's word for it.

---

## Is this your problem?

- You want to compare how Gemini, Claude and GPT behave with local tools, without writing a
  harness per SDK.
- You want to know what an **Agents SDK** actually buys you over calling the plain API in a
  loop — measured, not asserted.
- You want to show someone, rather than tell them, why a model without tools answers
  confidently and wrongly.
- You need a UI to drive local agents instead of reading terminal logs.
- You want to **upload an image or a PDF** and have an agent act on it.
- You are tired of the nuances between Anthropic's `output_config.effort`, OpenAI's
  `reasoning_effort` and Gemini's thinking config.

---

## TL;DR

```
YOU (Browser)                    GATEWAY                          PROVIDER
[pick lane: chat] ------>  POST /v1/sessions {mode:'chat'}
                           ClaudeChat.Adapter  -------------->  messages.create(stream)
[see tokens]      <------  SSE: text.delta / usage

[pick lane: agent] ----->  POST /v1/sessions {mode:'agent'}
                           ClaudeAgent.Adapter -------------->  claude-agent-sdk query()
                                                                  └─ runs the tool loop
                           local tools + MCP  <---------------─┘
[see tool badges] <------  SSE: tool.started / tool.result
```

One shared session store knows which agent and which lane every session belongs to, so
`/v1/sessions/:id/messages` needs nothing but the id. The id keeps a readable prefix —
`claude-agent-<uuid>` — purely for human comfort in logs.

---

## Configuration

```bash
# .env
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIzaSy...        # lane chat (@google/generative-ai)
GOOGLE_GENAI_API_KEY=AIzaSy...  # lane agent (@google/adk) — see below
```

```bash
pnpm dev
```

The gateway listens on `http://127.0.0.1:3000/v1` and works **with no MCP server running** —
the built-in `search_web` and `run_bash` keep it useful on their own. Point it at one with
`MCP_SERVER_URL` (default `http://localhost:8000/mcp`) and those tools join the catalog.
`GET /v1/tools` shows the merged view and whether MCP is connected.

The connection heals itself. A server that comes up *after* the gateway is picked up on the
next tool listing or health check; one that dies mid-run drops the gateway back to local
tools and is retried with exponential backoff (1s up to 60s). No restart either way.

### Before you run it

The findings in [What the comparison surfaced](#what-the-comparison-surfaced) are already
handled in code — the tracing exporter is disabled in `src/main.ts`, and the boot bridges
`GOOGLE_API_KEY` into `GOOGLE_GENAI_API_KEY` and says so in the log. What you still have to
get right yourself:

- **Set `GOOGLE_GENAI_API_KEY`** if you can, rather than leaning on the bridge.
- **Never install with `--omit=optional`.** That flag drops the bundled `claude` binary and
  the Claude agent lane dies on its first turn. The `Dockerfile` is careful about this.
- **Node ≥ 22.12.** All three Agents SDKs load under `require()` only thanks to Node's
  `require(ESM)` support.
- **The first turn of a Claude agent session is slow** — it spawns the bundled binary.

### Perimeter

The gateway executes `run_bash`, so it is closed by default: it binds to `127.0.0.1` and
rejects every cross-origin request. The bundled UI is same-origin and unaffected.

| Env | Default | What it does |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Change it only if you know who else is on the network. |
| `CORS_ORIGINS` | *(none)* | Comma-separated allowlist. Needed if you serve a frontend from another port. |
| `GATEWAY_TOKEN` | *(none)* | When set, `/v1/*` requires `Authorization: Bearer`. The UI reads it from `localStorage.gatewayToken`. |
| `ALLOW_ANONYMOUS` | *(off)* | Needed to use the bundled UI and plain `curl`, which send no caller credential. See [Caller identity](#caller-identity). |
| `JSON_LIMIT` | `25mb` | Request body cap. Base64 attachments inflate ~33%. |

### Caller identity

The perimeter above is the *service's* gate. This section is about *who is calling*: the
gateway forwards the caller's own credential to the MCP tools (header `X-Tool-Authorization`,
kept apart from `Authorization` on purpose) and uses it to keep one caller's sessions away from
another's.

**Closed by default.** Every route except `/health` answers `401` when `X-Tool-Authorization` is
missing. This matters when something in front of the gateway injects `GATEWAY_TOKEN` for
everyone (a same-origin proxy, say): the bearer gate then proves nothing about the caller, and
every anonymous request would otherwise get an authenticated pipe. For local `curl` and the
bundled demo UI, open it explicitly with `ALLOW_ANONYMOUS=1` (anonymous callers share one
"no owner" scope and cannot see sessions that have an owner).

The token payload is read **without verifying the signature**, only to *label* who is calling.
A forged token claims anything, so identity that decides access has to be **proven**: the
gateway spends the token on a probe MCP tool and believes the payload only if the tool confirms
it. Proofs (and denials) are cached for 60 s by `sha256(token)`, up to 500 entries. The
strategy sits behind a small port (`ICallerProof` in `src/infra/http/Caller.Proof.ts`), so
another one — verifying against a JWKS, for example — can be plugged in without touching a
route.

| Env | Default | What it does |
| --- | --- | --- |
| `ALLOW_ANONYMOUS` | *(off)* | `1` lets requests without `X-Tool-Authorization` through. |
| `CALLER_ID_CLAIM` | `sub` | Where the caller's id lives in the token payload. Dot paths work (`user.id`). |
| `CALLER_EMAIL_CLAIM` | `email` | Same, for the e-mail label. |
| `CALLER_ROLE_CLAIM` | `role` | Same, for the role label. |
| `CALLER_ACCOUNT_CLAIM` | *(none)* | Same, for an account/tenant (`account.alias`). Optional; when set, a session is also bound to the account. |
| `CALLER_PROOF_TOOL` | *(none)* | MCP tool the token is spent on. **Unset disables proof.** |
| `CALLER_PROOF_FIELD` | `authenticated` | Field of the tool's JSON result that must be exactly `true`. Dot paths work. |
| `REQUIRE_PROVEN_OWNER` | **on** | Only a proven identity counts as owner. `0`/`false`/`off`/`no` accepts the *claimed* identity when proof is disabled. |

Sessions are stamped with `metadata.owner` (`id`, `email`, `account`) from the proven caller;
an `owner` sent in the request body is discarded. `GET /sessions` lists only your own, and
`GET`, `DELETE`, `cancel` and `messages` on `/sessions/:id` answer `404` unless you own it,
exactly like a session that does not exist. `GET /agents`, `/agents/:id/tools`, `/tools` and
`/openapi.json` also need a proven caller, and `/agents` never includes the system prompt.

**Why `REQUIRE_PROVEN_OWNER` is on by default.** With no `CALLER_PROOF_TOOL`, the identity is
only what the token *says*, and anyone who knows another user's id can forge a token with it and
list, read and drive that user's sessions — spending model budget on their behalf. So by default
a credential that cannot be proven is **refused** (`401`) on the identity routes, and the boot
log warns once. The cost is that a fresh install with real tokens needs either
`CALLER_PROOF_TOOL` or an explicit `REQUIRE_PROVEN_OWNER=0`. Choose the latter only when every
caller is already trusted (a private network, or your own proxy verifies the token first) and
the owner merely separates conversations instead of protecting them from each other.

A token that carries no readable id is never treated as anonymous.

### Operating the gateway without a deploy

Who the agent serves, which agent answers and with which model are *operating* decisions, so
they live in settings you change at runtime (`GET`/`PUT /v1/settings`) instead of in `.env`. They
are stored in the same SQLite file as the conversations (`CONVERSATIONS_DB`; `off` keeps them in
memory, lost on restart) and apply on the next session, in the same instant they are saved.

| Setting | Meaning |
| --- | --- |
| `audience` | `off`: nobody opens a new session. `restricted`: only callers whose **proven** role is in `AUDIENCE_ROLES`. `all` (default): every caller the gateway already lets through. |
| `agentId` | Agent that answers when the caller sends none. Empty = first in the registry. |
| `model` | Model used when the caller sends none. A model the chosen agent does not declare falls back to that agent's first, so switching agent never ships a stale model id to the wrong provider. |
| `classifierModel`, `classifyTurns` | Stored only; the turn classifier comes in a later phase. |

`PUT /settings` takes a partial body: an absent field is untouched, and `null` (or `""`) on an
optional field deletes it and reverts to the default. `audience` cannot be cleared. `GET`
returns what is stored plus `defaults`, the values that apply to empty fields. Both routes answer
`404` (not `403`) to anyone who is not an administrator, so the route's existence is not
revealed. Closing the audience only blocks *new* sessions; a turn already running finishes. A
refusal is `403` with code `agent_unavailable`.

Access rules, in order: a role in `DENIED_ROLES` is refused under **any** audience, `all`
included; `off` refuses everyone; `restricted` needs a *proven* identity whose role is in
`AUDIENCE_ROLES`; `all` admits anyone with a proven identity, and one that is only *claimed* is
admitted solely when `REQUIRE_PROVEN_OWNER` is off (an anonymous call, which exists only with
`ALLOW_ANONYMOUS=1`, is admitted under `all`: there is no identity to forge). The role comes from
`CALLER_ROLE_CLAIM`. For a caller that is not proven, `DENIED_ROLES` only sees what the token
*says*: refusing on a claim is the safe direction, but configure proof if you need it airtight.
`GET /v1/availability` answers `{ "available": true|false }` for the current caller; the bundled
UI can use it to decide whether to show the assistant.

Settings administrators are callers with a **proven** identity whose role is in `ADMIN_ROLES` or
whose id/e-mail is in `ADMIN_USERS`. Without `CALLER_PROOF_TOOL` nobody is an administrator.

| Env | Default | What it does |
| --- | --- | --- |
| `AUDIENCE_ROLES` | `admin` | Comma list of roles admitted under `audience: restricted`. |
| `DENIED_ROLES` | *(empty)* | Comma list of roles refused under every audience. |
| `ADMIN_ROLES` | `admin` | Comma list of roles that may read and write settings. |
| `ADMIN_USERS` | *(empty)* | Comma list of ids or e-mails that may read and write settings. |
| `AGENTS_ENABLED` | *(all)* | Comma list of agent ids that **exist** in this process. An agent that is not listed is not refused, it is gone: no `/agents`, no session by any route. Use it so an agent carrying a shell tool (`run_bash`) cannot be reached. The boot fails if nothing matches. |
| `SESSION_CONTEXT_TEMPLATE` | *(none)* | Text sent to the model before the **first** message of a session, never stored in the turn. Placeholders: `{id}` `{email}` `{role}` `{account}` `{date}`. If it cites an identity field the token lacks, no context is sent. Unset = none. |
| `SESSION_TIMEZONE` | `UTC` | Time zone of `{date}` (IANA name; an invalid one falls back to UTC). |

Sessions expire after **8 hours** without activity.

### Tool safety, and actual containment

`run_bash` runs with a timeout, an output cap, a configurable `cwd`, and a deny-list for the
catastrophic ones (`rm -rf`, `mkfs`, `dd` onto a device, fork bombs, `curl | sh`, `sudo`,
`shutdown`). On top of that sits each SDK's own gate — `canUseTool` on Claude,
`needsApproval` on OpenAI.

**That deny-list is not containment.** It catches the catastrophic command typed by mistake
or hallucinated by a model. It does nothing about a model that simply reads
`~/.ssh/id_rsa`. Containment is the container:

```bash
cp .env.example .env   # preencha as chaves
docker compose up -d   # http://127.0.0.1:3000/v1
```

| What the container buys you | What it does **not** |
| --- | --- |
| `run_bash` runs as an unprivileged user (uid 10001), never as you | the model still has a shell |
| your `$HOME`, your keys and your files are not there at all | it still reads the container's own filesystem |
| writes land in `/workspace`; the rest of the rootfs is read-only | `/workspace` is genuinely writable |
| `cap_drop: ALL` + `no-new-privileges` — no route to root | — |
| `pids_limit` and `mem_limit` cap a fork bomb at the container | — |
| the port is published on `127.0.0.1` only | it still reaches the network |

Verified by asking the agent lane to run `whoami` inside it: `gateway`, in `/workspace`,
with no `/Users` in sight.

---

## Architecture

| Layer | Responsibility |
| --- | --- |
| **Domain** | `Agent.Registry`, `EMode`, and the `IAgentEvent` union every lane speaks. |
| **Application** | Three thin use cases and the controller that turns events into SSE. |
| **Infra (adapters)** | `*Chat.Adapter` on the plain SDKs, `*Agent.Adapter` on the Agents SDKs. |
| **Infra (tools)** | `ToolCatalog` merging MCP discovery with the built-in toolset, plus one bridge per SDK. |
| **Infra (session)** | `SessionStore` with TTL, and the session id that carries the route. |
| **Composition** | Factories wiring six adapters — three providers × two lanes. |

Files are named `<What>.<Kind>.ts` — `ClaudeChat.Adapter.ts`, `Agent.Provider.ts`,
`AgentEvent.Model.ts`, `EMode.Enum.ts`.

### API

Versioned under `/v1`. Everything but `/health` needs the caller's credential — see [Caller identity](#caller-identity). The full contract is served at `/v1/openapi.json`, and a test fails
the build if it drifts from the routes the server actually registers.

| Route | What it does |
| --- | --- |
| `GET /v1/health` | Liveness, MCP status, live session count. Public. |
| `GET /v1/agents` | The registry (never the system prompt), including which lanes each agent supports. |
| `GET /v1/agents/:agentId/tools` | Tool catalog filtered by what that agent declares. |
| `GET /v1/tools` | Full catalog: built-in tools merged with whatever MCP exposes. |
| `GET /v1/availability` | `{ available }`: does the agent serve you right now? |
| `GET /v1/settings` | Operating settings plus `defaults`. Administrators only (404 otherwise). |
| `PUT /v1/settings` | Partial update; `null` reverts an optional field. Administrators only. |
| `POST /v1/sessions` | `{ agentId?, mode, model, reasoning, language }` → a session. `403 agent_unavailable` when the audience refuses you. |
| `GET /v1/sessions` | Your live sessions, most recently active first. |
| `GET /v1/sessions/:id` | Lane, model, turns and accumulated usage. |
| `DELETE /v1/sessions/:id` | Ends the session, aborting anything in flight. |
| `POST /v1/sessions/:id/messages` | The turn. |
| `POST /v1/sessions/:id/cancel` | Aborts the generation, keeping the session. |

`Accept` decides the shape of a turn: `text/event-stream` (the default) streams events;
`application/json` returns the whole turn at once — final text, every tool call with its
result, usage, warnings. That second form is what makes it practical to run both lanes over
the same prompts and compare by number instead of by impression.

SSE events: `message.started`, `text.delta`, `reasoning.delta`, `tool.started`,
`tool.result`, `tool.error`, `usage`, `warning`, `message.aborted`, `message.completed`,
`error`. Closing the tab cancels the turn at the provider.

Failures carry a stable `code` — `validation_error`, `agent_not_found`, `session_not_found`,
`mode_not_supported`, `unauthorized` (401, also for a missing or unproven caller credential), `internal_error` — so a client can branch without
parsing prose.

---

## Credits

Written by **Henrique Van Klaveren**.

## License

MIT — see `LICENSE`. Use it however you like.
