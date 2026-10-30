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

|                             | `chat` | `chat` + `tools`                 | `agent`    |
| --------------------------- | ------ | -------------------------------- | ---------- |
| SDK                         | plain  | plain                            | Agents SDK |
| Who runs the tool loop      | nobody | **you do, by hand**              | the SDK    |
| Tool-loop code you maintain | none   | 109 shared + 89–137 per provider | **none**   |

To be fair about that last row: the agent adapters in this repo are ~280 lines each, and the
chat ones are not much smaller. Both lanes need translation code — mapping a provider's
stream onto one event shape, carrying history, wiring MCP. What the last column is missing
is the _loop and its bookkeeping_, and that is the part that is easy to get subtly wrong.

The plain SDKs are `@anthropic-ai/sdk`, `openai` and `@google/generative-ai`; the agentic
ones are `@anthropic-ai/claude-agent-sdk`, `@openai/agents` and `@google/adk`.

### What it looks like when you run it

Same agent, same question — _run `whoami; pwd` and answer with the output_ — inside the
container, where the true answer is `gateway` and `/workspace`:

| Lane             | Tools called             | Answer                               |
| ---------------- | ------------------------ | ------------------------------------ |
| `chat`           | none                     | **`root` / `/home/user`** — invented |
| `chat` + `tools` | `run_bash`               | `gateway` / `/workspace`             |
| `agent`          | `mcp__gateway__run_bash` | `gateway` / `/workspace`             |

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
- Feeding tool _failures_ back to the model, so it can correct course instead of stalling.

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
- **Each SDK has real surface area.** It is not free; it is _different_ work.

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
  your own and the subprocess exits with _"No conversation found"_.
- **The ADK streams partial text and then repeats the whole thing** in a final aggregate
  event. Forward both and every answer is duplicated on screen.

None of these are in the paragraph that says "just use the SDK". They are the reason the
comparison was worth building rather than reasoning about.

### How far this evidence goes

One prompt, one tool, one run per lane. It demonstrates the shape of the difference; it is
not a benchmark, and it says nothing about which provider is better. The value here is that
the three states are _reproducible on your machine, with your keys_ — flip the lane in the
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
`/v1/sessions/:id/messages` needs nothing but the id. The id is `gw_` plus 26 characters (a ULID:
sortable by creation time). It does not name the provider or the lane: a conversation can switch
provider mid-way, so such a prefix would lie. Older ids (`claude-agent-<uuid>`) keep working.

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
`GET /v1/tools` shows the merged view and whether MCP is connected. Writing your own server?
See the [MCP server guide](docs/MCP-SERVER-GUIDE.md).

The connection heals itself. A server that comes up _after_ the gateway is picked up on the
next tool listing or health check; one that dies mid-run drops the gateway back to local
tools and is retried with exponential backoff (1s up to 60s). No restart either way.

### Other environment variables

| Env                     | Default                     | What it does                                                                                           |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PORT`                  | `3000`                      | Port to listen on.                                                                                     |
| `MCP_SERVER_URL`        | `http://localhost:8000/mcp` | MCP server whose tools join the catalog.                                                               |
| `MAX_OUTPUT_TOKENS`     | `4096`                      | Output cap per model call in the chat lane.                                                            |
| `MAX_TOOL_TURNS`        | `12`                        | Tool round-trips allowed in one turn.                                                                  |
| `COMPACT_AT_PERCENT`    | `80`                        | Context use (% of the model window) that compacts the conversation at the start of the next turn.      |
| `LOOP_REFUSE_AT`        | `4`                         | The identical tool call (same tool and arguments) refused from this time on, within a turn.            |
| `LOOP_STOP_AT`          | `6`                         | The identical tool call that stops the turn.                                                           |
| `LOOP_MAX_ERRORS`       | `8`                         | Tool errors in a row that stop the turn.                                                               |
| `BASH_CWD`              | _(process cwd)_             | Working directory of `run_bash`.                                                                       |
| `BASH_TIMEOUT_MS`       | `20000`                     | `run_bash` timeout.                                                                                    |
| `BASH_MAX_OUTPUT_CHARS` | `4000`                      | `run_bash` output cap.                                                                                 |
| `CONVERSATIONS_DB`      | `data/gateway.db`           | SQLite file for conversations **and** settings. `off` disables recording and keeps settings in memory. |
| `GEMINI_API_KEY`        | _(none)_                    | Alternative to `GOOGLE_GENAI_API_KEY` for the agent lane (`@google/adk`).                              |
| `TURN_CALLBACK_HOSTS`   | _(none)_                    | Hosts (`host` or `host:port`, comma-separated) a conversation's `callbackUrl` may point to.            |
| `TURN_CALLBACK_SECRET`  | _(none)_                    | HMAC key for `X-Gateway-Signature` on turn callbacks. Without it, no callback is accepted or sent.     |

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

| Env                  | Default     | What it does                                                                                                                                                                                                                                             |
| -------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1` | Interface to bind. Change it only if you know who else is on the network.                                                                                                                                                                                |
| `CORS_ORIGINS`       | _(none)_    | Comma-separated allowlist. Needed if you serve a frontend from another port.                                                                                                                                                                             |
| `ALLOW_ANONYMOUS`    | _(off)_     | Needed to use the bundled UI and plain `curl`, which send no caller credential. See [Caller identity](#caller-identity).                                                                                                                                 |
| `JSON_LIMIT`         | `256kb`     | Request body cap for every route except the ones below (the body is read before authentication).                                                                                                                                                         |
| `MESSAGE_JSON_LIMIT` | `25mb`      | Body cap for conversation messages (base64 attachments inflate ~33%) and for the routes that save content: agents, hooks, schedules, rules, docs, skills/commands, protocol addenda, `/v1/mcp` and `/v1/turn-tools`. Content has no size cap of its own. |

### Caller identity

The perimeter above is the _service's_ gate. This section is about _who is calling_: the
gateway forwards the caller's own credential to the MCP tools (header `X-Tool-Authorization`,
kept apart from `Authorization` on purpose) and uses it to keep one caller's sessions away from
another's.

**Closed by default.** Every route except `/health` and the entry points (`/auth/status`, `/auth/setup`,
`/auth/login`, `/shared/:id`) answers `401` without the caller's credential: the UI's HttpOnly session
cookie, or `X-Tool-Authorization: Bearer <access token>` for scripts and MCP clients. The plain
`Authorization` header is not a credential here, so a proxy in front that sets it opens nothing. For
local `curl` without an account, open it explicitly with `ALLOW_ANONYMOUS=1` (anonymous callers share
one "no owner" scope and cannot see sessions that have an owner). There is no service-wide shared
secret: a leftover `GATEWAY_TOKEN` only logs a warning at boot.

The token payload is read **without verifying the signature**, only to _label_ who is calling.
A forged token claims anything, so identity that decides access has to be **proven**: the
gateway spends the token on a probe MCP tool and believes the payload only if the tool confirms
it. Proofs (and denials) are cached for 60 s by `sha256(token)`, up to 500 entries. The
strategy sits behind a small port (`ICallerProof` in `src/infra/http/Caller.Proof.ts`), so
another one — verifying against a JWKS, for example — can be plugged in without touching a
route.

| Env                    | Default         | What it does                                                                                                          |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ALLOW_ANONYMOUS`      | _(off)_         | `1` lets requests without `X-Tool-Authorization` through.                                                             |
| `CALLER_ID_CLAIM`      | `sub`           | Where the caller's id lives in the token payload. Dot paths work (`user.id`).                                         |
| `CALLER_EMAIL_CLAIM`   | `email`         | Same, for the e-mail label.                                                                                           |
| `CALLER_ROLE_CLAIM`    | `role`          | Same, for the role label.                                                                                             |
| `CALLER_ACCOUNT_CLAIM` | _(none)_        | Same, for an account/tenant (`account.alias`). Optional; when set, a session is also bound to the account.            |
| `CALLER_PROOF_TOOL`    | _(none)_        | MCP tool the token is spent on. **Unset disables proof.**                                                             |
| `CALLER_PROOF_FIELD`   | `authenticated` | Field of the tool's JSON result that must be exactly `true`. Dot paths work.                                          |
| `REQUIRE_PROVEN_OWNER` | **on**          | Only a proven identity counts as owner. `0`/`false`/`off`/`no` accepts the _claimed_ identity when proof is disabled. |

Sessions are stamped with `metadata.owner` (`id`, `email`, `account`) from the proven caller;
an `owner` sent in the request body is discarded. `GET /sessions` lists only your own, and
`GET`, `DELETE`, `cancel` and `messages` on `/sessions/:id` answer `404` unless you own it,
exactly like a session that does not exist. `GET /agents`, `/agents/:id/tools`, `/tools` and
`/openapi.json` also need a proven caller, and `/agents` never includes the system prompt.

**Why `REQUIRE_PROVEN_OWNER` is on by default.** With no `CALLER_PROOF_TOOL`, the identity is
only what the token _says_, and anyone who knows another user's id can forge a token with it and
list, read and drive that user's sessions — spending model budget on their behalf. So by default
a credential that cannot be proven is **refused** (`401`) on the identity routes, and the boot
log warns once. The cost is that a fresh install with real tokens needs either
`CALLER_PROOF_TOOL` or an explicit `REQUIRE_PROVEN_OWNER=0`. Choose the latter only when every
caller is already trusted (a private network, or your own proxy verifies the token first) and
the owner merely separates conversations instead of protecting them from each other.

A token that carries no readable id is never treated as anonymous.

### Operating the gateway without a deploy

Agents, providers, models and keys live in the database, and only what is active shows up. A fresh
database starts with a single agent, **Atlas**, which creates and adjusts the others through the
gateway's own tools (`save_agent`, `list_models`, …). No model is enabled at boot: an agent becomes
active once its provider is on, one of its models is enabled in Providers → Models and there is a
key (or a subscription login).

An agent can run on **several providers**, each with its own models (`providers: [{ provider, models }]`;
the first is the default). A live conversation switches between them like it switches models
(`PATCH /v1/sessions/:id { provider, model }`): each provider keeps its history inside its own SDK, so
the new one receives a **transcript** of the previous turns — requests, answers and the tools that ran —
and its internal state (tool ids, encrypted reasoning, cache) stays behind. Usage and cost are kept per
provider and model.

Who the agent serves, which agent answers and with which model are _operating_ decisions, so
they live in settings you change at runtime (`GET`/`PUT /v1/settings`) instead of in `.env`. They
are stored in the same SQLite file as the conversations (`CONVERSATIONS_DB`; `off` keeps them in
memory, lost on restart) and apply on the next session, in the same instant they are saved.

| Setting              | Meaning                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audience`           | `off`: nobody opens a new session. `restricted`: only callers whose **proven** role is in `AUDIENCE_ROLES`. `all` (default): every caller the gateway already lets through.                                                                                                                                         |
| `agentId`            | Agent that answers when the caller sends none. Empty = the first active agent that is not a subagent. Must be active to be saved.                                                                                                                                                                                   |
| `provider`           | Provider used when the caller sends none: one of the chosen agent's providers. Empty = the first that offers `model`, else the agent's default.                                                                                                                                                                     |
| `model`              | Model used when the caller sends none. Must be one of the chosen agent's enabled models (`422` otherwise); a model asked for explicitly that the agent does not offer is `409 model_disabled`, never silently swapped.                                                                                              |
| `classifyTurns`      | Turn on the [turn classifier](#turn-classification). Absent = off.                                                                                                                                                                                                                                                  |
| `classifierProvider` | Provider that classifies: enabled, with an API key (subscriptions do not classify).                                                                                                                                                                                                                                 |
| `classifierModel`    | Model that classifies, enabled in that provider's catalog. Without both, no classification.                                                                                                                                                                                                                         |
| `limits`             | Live caps: `maxToolTurns`, `maxOutputTokens`, `delegationMaxDepth`, `bashTimeoutMs`, `bashMaxOutputChars`, `sessionsPerOwner`, `streamsPerOwner`. Each has a range (`GET /settings` returns `limitBounds` and `limitsInEffect`); `null` on one falls back to its env variable, which is now only the initial value. |

`PUT /settings` takes a partial body: an absent field is untouched, and `null` (or `""`) on an
optional field deletes it and reverts to the default. `audience` cannot be cleared. `GET`
returns what is stored plus `defaults`, the values that apply to empty fields. Both routes answer
`404` (not `403`) to anyone who is not an administrator, so the route's existence is not
revealed. Closing the audience only blocks _new_ sessions; a turn already running finishes. A
refusal is `403` with code `agent_unavailable`.

Access rules, in order: a role in `DENIED_ROLES` is refused under **any** audience, `all`
included; `off` refuses everyone; `restricted` needs a _proven_ identity whose role is in
`AUDIENCE_ROLES`; `all` admits anyone with a proven identity, and one that is only _claimed_ is
admitted solely when `REQUIRE_PROVEN_OWNER` is off (an anonymous call, which exists only with
`ALLOW_ANONYMOUS=1`, is admitted under `all`: there is no identity to forge). The role comes from
`CALLER_ROLE_CLAIM`. For a caller that is not proven, `DENIED_ROLES` only sees what the token
_says_: refusing on a claim is the safe direction, but configure proof if you need it airtight.
`GET /v1/availability` answers `{ "available": true|false }` for the current caller; the bundled
UI can use it to decide whether to show the assistant.

Settings administrators are callers with a **proven** identity whose role is in `ADMIN_ROLES` or
whose id/e-mail is in `ADMIN_USERS`. Without `CALLER_PROOF_TOOL` nobody is an administrator.

| Env                        | Default   | What it does                                                                                                                                                                                                                               |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUDIENCE_ROLES`           | `admin`   | Comma list of roles admitted under `audience: restricted`.                                                                                                                                                                                 |
| `DENIED_ROLES`             | _(empty)_ | Comma list of roles refused under every audience.                                                                                                                                                                                          |
| `ADMIN_ROLES`              | `admin`   | Comma list of roles that may read and write settings.                                                                                                                                                                                      |
| `ADMIN_USERS`              | _(empty)_ | Comma list of ids or e-mails that may read and write settings.                                                                                                                                                                             |
| `SESSION_CONTEXT_TEMPLATE` | _(none)_  | Text sent to the model before the **first** message of a session, never stored in the turn. Placeholders: `{id}` `{email}` `{role}` `{account}` `{date}`. If it cites an identity field the token lacks, no context is sent. Unset = none. |
| `SESSION_TIMEZONE`         | `UTC`     | Time zone of `{date}` (IANA name; an invalid one falls back to UTC).                                                                                                                                                                       |
| `CLASSIFIER_PROMPT_FILE`   | _(none)_  | Path to a text file that replaces the classifier prompt. A missing, unreadable or empty file is refused with a boot warning.                                                                                                               |
| `MODEL_PRICING_FILE`       | _(none)_  | Path to a JSON file of model prices, merged over the built-in table (see [Monitor, sharing and cost](#monitor-sharing-and-cost)). An invalid file is refused whole, with a boot warning.                                                   |

Sessions expire after **8 hours** without activity.

### Monitor, sharing and cost

Every turn is recorded (SQLite, see `CONVERSATIONS_DB`), and the _persisted_ conversation is a
different thing from the live session behind `/v1/sessions`: it survives restarts, and it is what a
history screen reads.

- **Yours.** `GET /v1/conversations` lists the caller's own conversations; any other query key
  filters on `metadata` (`?app=web`). The owner comes from the proven credential only — keys
  starting with `owner` in the query are dropped, so `?owner=<someone>` reads nothing of theirs.
  `GET /v1/conversations/:id/turns` and `DELETE /v1/conversations/:id` work for the owner **or an
  administrator**; anyone else gets `404`, identical to a conversation that does not exist. Deleting
  removes the record only; a live session keeps running until `DELETE /v1/sessions/:id`.
- **Monitor (administrators only).** `GET /v1/conversations?scope=all` lists everyone's. With
  `page=` the server paginates (`pageSize` 1–50, default 10), searches `q` (≤100 chars: title and
  owner e-mail, id and account) and filters by `classification` and `provider`, returning
  `{ sessions, total, page, pageSize, facets, scope }`. `facets` counts over the _search_, not the
  active tab, so the other tabs keep their numbers. `GET /v1/conversations/stats` returns totals,
  `byModel`, `byClassification` and the estimated cost. Everyone else gets `404`.
- **Classification** (`green`, `blue`, `amber`, `red`) is stored per turn and per conversation, where the
  conversation carries the _worst_ of its turns. See [Turn classification](#turn-classification)
  for what produces it.
- **Sharing.** `PUT /v1/conversations/:id/share { "shared": true }` (owner or administrator) opens a
  read-only link. The `shareId` (12 random bytes, base64url) is created once and reused: closing
  keeps it and only stops it from answering, so reopening returns the same link. `GET /v1/shared/:id`
  is **public** (the only route besides `/health`) and returns just `{ id, title, createdAt, turns:
[{ at, request, text }] }` — no tool calls, reasoning, attachments, classification, usage or
  metadata. A conversation that does not exist and one that is not shared both answer `404`. Anyone
  holding the link can read the text of the answers, so share deliberately.
- **Cost.** `costUsd` is an _estimate_ from a price table ($ per 1M tokens): fresh input
  (`input − cacheRead − cacheWrite`) at the input price, cache reads and writes at theirs, and
  output **plus reasoning** at the output price. A model with no price has no `costUsd` — never
  zero. It appears only in administrator responses (monitor listing, turns read by an
  administrator, stats), never to the plain owner. `GET /v1/agents` carries the per-model `pricing`
  so a selector can show it and sort cheapest first.

Prices live in each provider's model catalog (Providers → Models), and that is what usage and cost read.
The built-in table is only the _suggested_ price for a model when it enters the catalog (sync or
"add by id"). Add or correct suggestions with `MODEL_PRICING_FILE`:

```json
{ "o4-mini": { "input": 1.1, "output": 4.4, "cacheRead": 0.275 } }
```

An entry replaces the built-in suggestion for that model. The file is read once at boot; if any entry is
invalid the whole file is refused and the built-in table stays, with a warning in the log.

### Turn classification

An optional small model labels each turn, so you can find patterns without reading every
conversation:

| Label   | Meaning                                                                                   | Action            |
| ------- | ----------------------------------------------------------------------------------------- | ----------------- |
| `green` | Answered within the agent's capabilities.                                                 | none              |
| `blue`  | The agent failed to deliver, or a capability is missing.                                  | product gap       |
| `amber` | A legitimate request the system does not do, or that is out of scope.                     | product decision  |
| `red`   | Abuse: jailbreak, prompt injection, an attempt to reach another user's or account's data. | investigate today |

Severity is `green` < `blue` < `amber` < `red`; a conversation carries the worst label of its turns.

It is **off by default**, because each classified turn is a paid call that sends the conversation
text to a provider. It runs when `classifyTurns` is on in settings **and** both `classifierProvider`
and `classifierModel` are set. They are read on every turn, so toggling or switching needs no
restart. The call goes through that provider's connection (protocol, base URL and the key saved in
Providers), on the same plain SDK as the chat lane. The provider is never guessed from the model id.
A provider that is off, keyless or a subscription, or a model not enabled in its catalog, keeps it off
and says so once in the log.

Design rules worth knowing:

- **After the turn is saved, never before.** The classifier is awaited by nothing on the reply
  path, and a failure (or a model that answers something else) leaves the turn without a label. It
  never changes the turn.
- **Separate from the agent.** An agent under prompt injection is a poor judge of its own
  conversation. The classifier has no tools: the worst a hostile text can do is a wrong label.
- **The text is data.** Request, answer and tool names are delimited, capped at 2000 characters
  each, and the prompt says so. Only the four exact words are accepted; anything else is no label.
- **Output cap leaves room for reasoning.** The answer is one word, but thinking models spend the
  output budget before writing it; a cap sized for the word alone yielded empty answers and no
  error. The cap is 512 tokens.

`CLASSIFIER_PROMPT_FILE` replaces the default prompt (generic English: the table above) with your
own text, for a domain-specific definition of "out of scope" or "abuse". Keep the instruction that
the quoted text is data.

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

| What the container buys you                                       | What it does **not**                          |
| ----------------------------------------------------------------- | --------------------------------------------- |
| `run_bash` runs as an unprivileged user (uid 10001), never as you | the model still has a shell                   |
| your `$HOME`, your keys and your files are not there at all       | it still reads the container's own filesystem |
| writes land in `/workspace`; the rest of the rootfs is read-only  | `/workspace` is genuinely writable            |
| `cap_drop: ALL` + `no-new-privileges` — no route to root          | —                                             |
| `pids_limit` and `mem_limit` cap a fork bomb at the container     | —                                             |
| the port is published on `127.0.0.1` only                         | it still reaches the network                  |

Verified by asking the agent lane to run `whoami` inside it: `gateway`, in `/workspace`,
with no `/Users` in sight.

### MCP servers: remote, container, or local process

The MCP screen registers three kinds of server, and each agent picks its tools from them:

| Kind        | Runs                                                                  | Isolation                                                             |
| ----------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `remote`    | an MCP already up, over HTTP/SSE                                      | whatever that server has                                              |
| `container` | `docker run` of an image, one per conversation                        | read-only, no capabilities, no volumes, egress only to listed domains |
| `process`   | an npm package (or any command) as a child of the gateway, over stdio | **none** — the gateway's user, disk and network                       |

`process` is the admin's call, the same way picking `sdk:Bash` for an agent is: it is how
you run something like Playwright without Docker. **Install** runs
`npm install --prefix <data>/mcp/<id>` (on the pod, the PVC — it survives restarts; a failed
reinstall keeps the previous one). Each conversation gets its own process and an empty work
folder, unless the server is set to `shared`. The process does **not** inherit the gateway's
environment: only `PATH`, `HOME` and the basics, plus the secret variables declared for it.

The image ships Debian's `chromium` for Playwright: the screen's preset is
`@playwright/mcp@latest --headless --isolated --no-sandbox --executable-path=/usr/bin/chromium`.
Outside Linux, drop `--executable-path` and it uses the installed Chrome.

**Who is calling.** An agent's terminal always gets `GATEWAY_AGENT_ID`, `GATEWAY_CONVERSATION_ID`
and `GATEWAY_PROJECT_ID`: the gateway's `run_bash`, the Claude CLI (its Bash) and the Codex and
Antigravity CLIs. A remote MCP server gets the same in headers (`x-gateway-agent`,
`x-gateway-conversation`, `x-gateway-project`) only when its registration has "Enviar a identidade
do agente" turned on. It is off by default, so a third-party server does not learn conversation ids
unless whoever registered it decided so. It works on every lane: the gateway's own MCP client, the
Claude CLI and the Codex CLI.

### Projects: several isolated workspaces in one gateway

Agents, conversations and hooks belong to a **project**; models, MCP servers and packages are
system-wide. Each project has its own folder, `<data>/projects/<id>/` (on the pod, the PVC),
which is the working directory of its agents in every lane — persistent and shared by the
project's conversations. Admins see every project; everyone else sees the projects they are a
member of, and a project they cannot use answers 404. Agents with no project are **global** (the
Atlas): they show up everywhere, and a conversation with one opened inside a project belongs to
it. The project of a conversation is written by the server (`metadata.project`), never by the
client. On the first boot with projects, the agents that already existed and their conversations
move to the `geral` project, with every current account as a member.

**The terminal is checked twice.** Every agent's `run_bash`, global ones included, goes through
the permission rules (project → Permissions, and each agent's own rules) in two locks:

1. **The analysis.** The line is parsed (tree-sitter-bash), so `git status; rm x` is two commands. Each
   command must match a terminal rule, and each redirect a read or write rule. Anything that cannot
   be analysed (`eval`, a command name from a variable) is refused.
2. **The sandbox built from the same rules.** The command runs inside the OS sandbox
   (`@anthropic-ai/sandbox-runtime`: seatbelt on macOS, bubblewrap on Linux) and reaches only:
   - **Files:** writes only where the write rules allow, and reads in the working folder only what
     the read rules allow. `<data>`, the app folder and the gateway `HOME` stay out, and so does every
     secret: `node -e` reading `.env` fails in the OS.
   - **Network:** only through the gateway's own proxy on 127.0.0.1, with a per-command token. Each
     connection is decided by that agent's network rules, and git over SSH goes through the same
     proxy. Link-local, cloud metadata and the gateway's own ports are always refused. LAN addresses
     and local services need an exact rule: `localhost:27017` opens the host's Mongo, and
     `localhost:*` opens nothing. On Linux each exact `localhost:<port>` rule also gets a `socat`
     forwarder inside the sandbox, through the proxy, so database clients that do not speak HTTP
     proxy connect to `localhost:<port>` as usual. On macOS only proxy-aware clients reach them.
     Direct connections fail.

Every decision is logged (Permissions → Latest decisions). The Claude file tools (Read, Write, Edit)
go through the same rules and a symlink-resolving path filter in a `PreToolUse` hook. WebFetch goes
through the network rule for its host. The native Claude `Bash` and the Codex terminal do not follow
the rules, so they are never enabled.

**A terminal for long work.** `run_bash` runs with `spawn` in its own process group.

- **Timeout:** a timeout stops the whole group, grandchildren included (SIGTERM, then SIGKILL).
- **Long output:** the reply keeps the first 20% and the last 80%, where builds and tests say
  what failed. The full output stays in a log the agent reads with `bash_logs <id>` (`tail`,
  `grep`).
- **Per-agent limits:** each agent may get its own limits (`terminal: { timeoutSeconds, maxOutputChars }`,
  up to 2 h and 200 000 characters). The model can ask for a different `timeoutSeconds` per
  command, up to that limit.
- **Background:** `bash_start`, `bash_logs`, `bash_stop` and `bash_list` keep a command running
  in the background (a watcher, a long test run), with the same rules and sandbox. Limits: 5 per
  conversation, 8 hours, and they die with the conversation and with the gateway. On Linux each
  command has its own network, so a server started in the background is not reachable from
  another command: run the server and its tests in one command.

**Secrets are masked on the way out.** Whatever a tool returns goes to the model provider, to the
history and to the screen, so it passes through a mask first (Sistema → Segredos, admin only):

1. **Known value:** the values a project account handed to the command, the provider keys and the
   ones registered on that screen, also in base64 and as the password inside a URI. They become
   `[segredo:<label>]`.
2. **Shape:** a field whose name says secret (`…PASSWORD`, `…TOKEN`, `…API_KEY`) with an opaque
   value, in JSON, YAML and `.env`. `HOST`, `PORT`, `URL`, `…_ID` never count. Both name lists can
   be extended on the screen.
3. **Format:** tokens that identify themselves (GitHub, GitLab, `sk-`, AWS, Google, Slack, JWT,
   private key blocks).

It applies to `run_bash` and the background logs (before the output is cut, so a split secret does
not slip through), to the file and MCP tools, to the live turn and to what is recorded. A command
that spells out a known secret still runs, with a warning to use the variable instead.
`kubectl get secret -o json|yaml|jsonpath` is refused. Each hit is listed with its layer, label and
length, never the value. The mask catches the accidental leak, not a model that wants to leak
(encoded another way, reversed, in pieces); against that one, use short-lived account kinds.

**Repositories and worktrees.** A conversation can be opened in a repository of its project
(`<project>/repositories/<name>`) or in one of that repository's git worktrees: `repository` and
`worktree` on `POST /v1/sessions`, or the two lists in New conversation. The gateway finds the
worktree with `git worktree list`, by folder name or branch, so any layout works. It does not
create the worktree: whoever calls prepares it.

- That folder becomes the agent's whole world: the `cwd`, the file tools and the sandbox root.
  Relative rules (`apps/**`) count from it, so they mean the same in the repository and in each
  worktree.
- The worktree's git works (`status`, `commit`, `push`): the repository's common `.git` is opened
  to the sandbox. Its `config`, the worktree `config.worktree` and `hooks/` stay write-denied,
  because they run code in the next `git` outside the sandbox. The main checkout and the other
  worktrees stay out of reach.
- `HOME`, `.tmp`, the caches and the account kits stay in the project folder, never inside the
  worktree.
- Every repository of the project is open to its agents. A `repository <name>` rule set to Deny
  keeps an agent out of it. The first message tells it the repository,
  the worktree, the branch and the folder.

**Changes, like an IDE.** A conversation opened in a repository gets a **Changes** button with
the number of files. It opens a side panel with the changed files (M/A/D/R, `+n −m`), the commits
and each file's diff, side by side or in lines, with syntax highlighting. It has three scopes:

- this conversation (since the commit it started on, committed or not);
- not committed;
- the whole branch (against the merge base with `origin/HEAD`, `main`, `master` or `automation`).

Clicking a commit shows only its diff, and the panel refreshes when a turn ends. Behind it is
`GET /v1/sessions/:id/changes`:

- git runs read-only, with no external diff, textconv, fsmonitor, pager or system config, so
  nothing in the repository config runs a program;
- secrets (`.env`, keys) are listed without content;
- at most 300 files and 200 KB of diff per file.

**Provider fallback when a quota runs out.** When a provider answers with a quota, usage-limit or
rate-limit error mid-turn (HTTP 429, `insufficient_quota`, `RESOURCE_EXHAUSTED`, the Claude
subscription's `rate_limit_event`, Codex's "usage limit"), the turn goes on with the next step of
the chain instead of stopping on the error:

- **The chain:** the global one is set in Configuração → Troca de provedor. Each agent may use it,
  keep its own (`fallback: { mode: 'own', chain }`), or turn it off. A step runs only if the agent
  offers that provider and model, so the global chain never adds a provider to an agent.
- **The switch:** the new provider gets the transcript plus what the turn already did (text and
  tools), so it does not repeat work. The turn shows a warning, and the conversation stays on the
  new provider.
- **The bench:** the provider out of quota stays aside until the error says it resets (or 15
  minutes, configurable). New conversations start on the next one, and a conversation still on it
  switches before its next turn.

**Context compaction.** When the context of the last model call passes `compactAtPercent` of the
model window (80% by default; Configuração → Limites, or `COMPACT_AT_PERCENT`), the next turn
starts with a hidden turn on the same session: the model, which still sees everything (tool
output included), writes a summary. The session then restarts with the summary and the last two
turns in full. The summary is not stored as a turn; its usage counts.

- **By hand:** `POST /v1/sessions/:id/compact`, or the "Compactar" button next to the context
  meter. It runs at the start of the next turn.
- **Lanes:** the chat lanes, OpenAI Agents and Google ADK. The Claude Agent SDK, Codex and
  Antigravity compact their own context; the Claude one now shows a warning with the tokens
  before and after.
- **If the summary fails** (an error, or the model calls a tool), the session restarts with the
  recent transcript instead.

**Loop detector.** A call is identical when it has the same tool and arguments (key order does
not matter), within one turn:

- **The 4th identical call is refused** before it runs: the model gets the reason as the tool
  error and is told to change approach. This covers the gateway tools on every lane (Codex and
  Antigravity included) and the Claude native tools (`PreToolUse`).
- **The 6th identical call, or 8 tool errors in a row, stop the turn.** The turn shows the reason
  and is stored as interrupted. Calls that only show up in the event stream (the Codex natives)
  count for this.
- The three numbers live in Configuração → Limites (`LOOP_REFUSE_AT`, `LOOP_STOP_AT`,
  `LOOP_MAX_ERRORS`).

**Diagnostics after an edit.** Per agent (agent form → "Diagnóstico depois de editar"; off by
default): after a successful `write_file`/`edit_file`, or a Claude native `Write`/`Edit`/`MultiEdit`,
the gateway checks the edited file and adds the result to what the model gets back.

- **What runs:** only what the file's package already has in `node_modules/.bin` (that package, or
  a parent up to the work folder). `tsc --noEmit -p` uses the nearest `tsconfig.json`, then
  `eslint` and `prettier --check` run on the file. Nothing is downloaded (no `npx`). A missing tool
  is reported, not installed.
- **Output:** only the file's own errors are listed. tsc errors in other files are counted, since
  an edit can break whoever imports it.
- **Where it runs:** in the same sandbox as `run_bash`, built from the agent's rules, with no
  network. The command comes from the gateway, so the `terminal` rules (which cover what the model
  asks for) do not apply to it.
- **Timeout:** each tool has a time limit (60 s by default, `timeoutSeconds` up to 600).

**Messages during a turn.** With a turn running, `POST /v1/sessions/:id/messages` (or `/turns`)
with `whileBusy: "queue"` answers 202 `{ queued: true, position }` instead of 409. The message
enters the same turn:

- **Mid-turn**, between a tool and the next model call, where the lane allows it: the chat lanes
  (sent with the tool results) and the Claude Agent SDK (a `PostToolUse` hook, after the next tool).
- **Otherwise**, as one more round when the model finishes: OpenAI Agents, Google ADK, Codex and
  Antigravity, and whatever is still waiting on any lane.
- **Record:** the turn streams a `message.injected` event and stores the message in
  `interjections` (`[{ at, text }]`, where `at` is the position in the answer). A provider switch
  carries it in the transcript.
- **Limits:** text only, no attachments (those still get 409). Up to 10 waiting per conversation
  (409 `queue_full`).
- **A stopped turn** (cancelled, failed, or stopped in a loop) drops what is still waiting, with a
  warning. The screen puts that text back in the message box.
- **On screen:** while a turn runs, Enter sends to the queue and the stop button stays. The message
  shows as "na fila" until it enters, then as a bubble inside the answer.

**Asynchronous turns**, for an orchestrator that drives agents:

- `POST /v1/sessions/:id/turns` answers 202 at once, and the turn runs on the server with no
  client attached.
- `GET /v1/sessions/:id/turns/:turn` says `running` (with the text so far) or `ok`, `error` or
  `aborted`.
- One turn per conversation: a second one while the first runs gets 409 `session_busy`, on this
  route and on `/messages`.
- With `callbackUrl` on the conversation, the end of every turn is POSTed there, signed with
  `X-Gateway-Signature`. Only hosts in `TURN_CALLBACK_HOSTS` are accepted, and it tries 3 times.
- **Live on the screen:** a turn started anywhere (the API, a schedule, a delegation, another
  tab) shows up in the open conversation as it runs, and its stop button works. The list marks
  running conversations with a pulsing dot. The screen follows the turn on the inbox stream it
  already has (`PUT /v1/conversations/events/:streamId/follow`), because the browser opens at
  most six connections per host. An API client can use `GET /v1/sessions/:id/live` (SSE) instead.

**Project accounts (Project → Accounts).** Each project keeps its own credentials, which its
agents' terminal receives: a GitHub App, a GitHub token, a GCP service account, SSH (a
certificate from the gateway's CA or an imported key), or a secret variable. They are stored in
the same vault as the provider keys (AES-256-GCM, with `conta:<project>:<id>` as the AAD), and the
secret goes in and never comes back to the screen.

- A command gets only the accounts the permissions let that agent use (`account <id>`), as process
  environment variables, never on the command line.
- A **GitHub App** goes in as a 1-hour installation token, minted by the gateway and limited to the
  chosen repositories. The App's private key never enters the sandbox.
- A **GitHub token** or a **secret variable** is the secret itself, and the screen says so: what
  the shell uses, the shell can print.
- A **GCP service account** goes in as a 1-hour access token for `gcloud`
  (`CLOUDSDK_AUTH_ACCESS_TOKEN`, plus the default project). The JSON key stays in the gateway, and
  the token exchange always goes to `oauth2.googleapis.com`, whatever `token_uri` the JSON says.
  One GCP account per command. The Google client libraries need the key file, so they are not
  covered.
- **SSH with the gateway's certificate** (recommended for servers): the gateway generates the
  project's CA (ed25519; the private key never leaves the vault). Each command gets a brand-new
  key with a certificate valid for a few minutes, for the chosen remote users. On the server,
  `TrustedUserCAKeys` (or `cert-authority` in `authorized_keys`) trusts the CA.
- **SSH with an imported key**: your key (and its certificate, if any) goes to the command. The
  `ssh_sign` tool signs with it in the `ssh-keygen -Y sign` format without the key entering the
  sandbox, which is how a token is made from an SSH key.
- For SSH, the command gets its own folder (`<project>/.home/.accounts/<run>`, removed when it
  ends) with the key, the certificate, the accepted `known_hosts` and an ssh config. `ssh`, `scp`
  and `sftp` wrappers in front of `PATH` use that config: the connection goes through the gateway
  port, only with those identities, and a server outside `known_hosts` is refused
  (`StrictHostKeyChecking yes`). The file tools never read that folder.
- GitHub accounts get a git credential helper scoped to `https://github.com/<owner>`, so two
  accounts in one project each serve their own repositories. `GH_TOKEN` is set only when there is
  exactly one.
- Accounts open no network: `github.com:443` or `server:22` still needs a network rule. A LAN
  address needs an exact rule (no `*`).

**The subscription CLIs.**

- **Codex** always runs `read-only`, with no network and no shell of its own; its `apply_patch` is
  refused by that sandbox. It gets the gateway's terminal, files and to-do list over MCP
  (`/v1/turn-tools`), through a **turn grant**:
  - a random token, valid only while the turn runs;
  - it carries the exact tools and the context (agent, conversation, project);
  - every call runs in the gateway, with the agent's permissions and sandbox.
- **Gemini (`agy`)** always runs with `--sandbox`. Tested on 1.4.5, it refuses the terminal, writes
  and reads outside its folder, but reads anything inside it, `.env` included. So it always runs in
  the conversation's empty folder. It gets the gateway's terminal, files and to-do list, and the
  agent's MCP tools, through the same turn grant. The MCP tools go through the agent's toolbox, so
  `agy` never sees an MCP server's URL or credential, and each call is checked against the
  permissions again:
  - each turn writes a plugin into that folder (`.agents/plugins/gateway/mcp_config.json`, read by
    `agy` 1.4.9) pointing at `/v1/turn-tools` with the grant token, and removes it when the turn ends;
  - headless `agy` refuses every MCP call without an allow rule in `HOME`, so the gateway adds
    `mcp(gateway_tools/*)` to `<HOME>/.gemini/antigravity-cli/settings.json`, and only to its own
    `HOME` (`<data>/antigravity-home`). On macOS `HOME` is the user's own (the Keychain), so there
    the gateway writes nothing and Gemini runs without these tools.

**On Linux in a container, bubblewrap needs user namespaces**: Docker's default seccomp profile
blocks them, so the pod needs `securityContext.seccompProfile.type: Unconfined` (or a profile that
allows `unshare`/`clone` with `CLONE_NEWUSER`). The image ships `bubblewrap socat ripgrep` and
sets `SANDBOX_NESTED=1` (no fresh `/proc` mount, which containers refuse). Without the sandbox, the
status says why (Settings → Deployment, and the Projects page) and **a project agent's shell is
refused** — it never runs unconfined.

### Agent triggers: actions on demand

Each agent has a **Triggers** tab: its own procedures, run on demand. A trigger has a name, a
one-line "when to use it" and the procedure itself.

- The agent's prompt lists only the name and "when" of each trigger (a `## Triggers` index, next to
  the skills one). The procedure enters when the request fits: the agent loads it with
  `use_resource`.
- `use_resource(kind, id)` loads a skill, a command or one of the agent's triggers;
  `search_resources(query, kind?)` finds them by words in the id and description. Both turn on by
  themselves when the agent has something to load. They replace `use_skill`.
- A trigger belongs to its agent: no other agent sees or loads it. It is saved with the agent.
- **Editing triggers from a conversation:** the "Editar triggers" capability gives an agent the
  `agent_trigger` tool (list, get, create, update, delete). Each call needs a `trigger <agent id>`
  rule. With no rule, nothing is allowed, not even on its own triggers, because an agent that
  rewrites its triggers changes its own behavior. A governance agent gets `trigger *`.
- A skill is a shared way of doing something, from the catalog; a trigger is the agent's own
  subcommand. They load the same way, but stay apart in data, screen and permissions.

### Agent hooks: an event becomes a conversation

Each agent has a **Hooks** tab. A hook is `POST /v1/hook/<agent>/<hook>` with its own key and a
prompt: when a service (GitHub, a CRM, a cron) calls it, the agent runs that prompt with the event
appended — content type, the useful `x-*` headers, the query and the body (never the key or the
signature). The gateway answers **202** at once with the conversation id and the turn runs in the
background, as the account that created the hook (its permissions, its inbox; disable the account
and the hook stops). Verification is per hook: the key in `Authorization: Bearer` / `X-Hook-Key`,
or an HMAC-SHA256 signature of the raw body (GitHub's `X-Hub-Signature-256` by default). A hook
opens a new conversation per call, or keeps one continuous conversation where calls queue up.
`HOOK_RATE_LIMIT` (default 60) caps calls per minute per hook.

### Server tools that survive a reboot: the Packages tab

On the pod there is no root and the rootfs is read-only, so `apt install` is not an option and
anything installed by hand is gone on the next restart. The **Packages** tab (admins only)
searches conda-forge and installs with `micromamba` — a static binary shipped in the image —
into `<data>/tools` (on the pod, the PVC). The gateway puts `<data>/tools/bin` first on its own
`PATH` at boot, so the agents' Bash, `run_bash` and local MCP processes all see git, curl, jq,
ffmpeg or whatever was installed. Outside the image, point `MICROMAMBA_BIN` at a micromamba
(`brew install micromamba` on a Mac).

Language package managers persist too: at boot the gateway points each one's global install
location at `<data>/tools/<manager>` and puts its `bin` on the `PATH` — `NPM_CONFIG_PREFIX`,
`PYTHONUSERBASE`, `UV_TOOL_DIR`, `PIPX_HOME`, `CARGO_HOME`, `GOPATH`, `GEM_HOME` (caches in
`<data>/cache`). So `npm i -g`, `pip install --user`, `uv tool install`, `cargo install`,
`go install` and `gem install` survive a restart with no extra step; a variable already set by the
operator wins. Not the whole `HOME` on purpose: a shared `HOME` would leak one conversation's
history and credentials into the next. A project-local `npm install` in a conversation's folder
stays temporary, as that folder is.

---

## Architecture

| Layer                | Responsibility                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **Domain**           | `Agent.Seed` (Atlas), `Agent.Policy`, `EMode`, and the `IAgentEvent` union every lane speaks. |
| **Application**      | Three thin use cases and the controller that turns events into SSE.                           |
| **Infra (adapters)** | `*Chat.Adapter` on the plain SDKs, `*Agent.Adapter` on the Agents SDKs.                       |
| **Infra (tools)**    | `ToolCatalog` merging MCP discovery with the built-in toolset, plus one bridge per SDK.       |
| **Infra (session)**  | `SessionStore` with TTL, and the session id that carries the route.                           |
| **Composition**      | Factories wiring six adapters — three providers × two lanes.                                  |

Files are named `<What>.<Kind>.ts` — `ClaudeChat.Adapter.ts`, `Agent.Provider.ts`,
`AgentEvent.Model.ts`, `EMode.Enum.ts`.

### API

Versioned under `/v1`. Everything but `/health` and `/shared/:id` needs the caller's credential — see [Caller identity](#caller-identity). The full contract is served at `/v1/openapi.json`, and a test fails
the build if it drifts from the routes the server actually registers.

| Route                             | What it does                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                  | Liveness, MCP status, live session count. Public.                                                                                                                                            |
| `GET /v1/agents`                  | The agents in the database (never the system prompt): lanes, enabled models and per-model `pricing`. Members see only the active ones; admins see all, each inactive one with `unavailable`. |
| `GET /v1/agents/:agentId/tools`   | Tool catalog filtered by what that agent declares.                                                                                                                                           |
| `GET /v1/tools`                   | Full catalog: built-in tools merged with whatever MCP exposes.                                                                                                                               |
| `GET /v1/availability`            | `{ available }`: does the agent serve you right now?                                                                                                                                         |
| `GET /v1/settings`                | Operating settings plus `defaults`. Administrators only (404 otherwise).                                                                                                                     |
| `PUT /v1/settings`                | Partial update; `null` reverts an optional field. Administrators only.                                                                                                                       |
| `GET /v1/conversations`           | Your persisted conversations; `?scope=all` (+ `page`, `pageSize`, `q`, `classification`, `provider`) lists everyone's, administrators only.                                                  |
| `GET /v1/conversations/stats`     | Totals, by model, by classification, estimated cost. Administrators only (404 otherwise).                                                                                                    |
| `GET /v1/conversations/:id/turns` | The turns. Owner or administrator (404 otherwise); `costUsd` for administrators only.                                                                                                        |
| `PUT /v1/conversations/:id/share` | `{ shared }`: open or close the read-only link. Owner or administrator.                                                                                                                      |
| `DELETE /v1/conversations/:id`    | Deletes the persisted record. Owner or administrator.                                                                                                                                        |
| `GET /v1/shared/:id`              | A shared conversation, read-only and stripped to question and answer. **Public.**                                                                                                            |
| `POST /v1/sessions`               | `{ agentId?, mode, provider?, model, reasoning, language }` → a session. `403 agent_unavailable` when the audience refuses you.                                                              |
| `GET /v1/sessions`                | Your live sessions, most recently active first.                                                                                                                                              |
| `GET /v1/sessions/:id`            | Lane, provider, model, turns and accumulated usage.                                                                                                                                          |
| `PATCH /v1/sessions/:id`          | `{ provider?, model?, reasoning? }`: switch from the next turn on. Another provider of the agent receives the transcript.                                                                    |
| `DELETE /v1/sessions/:id`         | Ends the session, aborting anything in flight.                                                                                                                                               |
| `POST /v1/sessions/:id/messages`  | The turn.                                                                                                                                                                                    |
| `POST /v1/sessions/:id/cancel`    | Aborts the generation, keeping the session.                                                                                                                                                  |

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

## What we learned running it in production

Notes from a production deployment of this gateway. Facts, not recommendations for every setup.

- **Implicit prompt cache on Gemini worked; explicit cache was not worth it.** Once measured
  correctly (per call, from the provider's usage metadata), the implicit cache hit on about 9 of
  10 calls. Paying for an explicit cache to improve on that was not justified.
- **Count usage per call, not per event.** When the model asked for two or more tools in one
  response, the ADK emitted one event per call, each carrying the same `promptTokenCount` — summing
  events counted the input two or three times. And a call that ends in a tool request lost its
  cache count, because its last chunk never becomes an event. Usage now comes from the model
  callback, once per call, with cache and reasoning kept apart; the turn is their sum.
- **Fewer tool calls beat caching.** The five costliest questions went from 6-33 tool calls each to
  2, purely through changes on the MCP side (ranked rows that carry ids, exclusion filters,
  server-side counts). See [docs/MCP-SERVER-GUIDE.md](docs/MCP-SERVER-GUIDE.md).
- **Closed by default, with proven identity.** Two real findings: a proxy that injected the gateway
  token for everyone turned "authenticated" into "anyone", and a hand-forged unsigned JWT claimed
  another user's id. Hence `X-Tool-Authorization` on every route, and identity that decides access
  must be proven (`CALLER_PROOF_TOOL`), not read from the token.
- **The credential is per call.** The caller's token sat in one field of the MCP client, written at
  the start of each call and cleared at the end. With two people at once, A's request went out with
  B's token, and one call's cleanup blanked the other's. It now travels in an async-local scope, one
  per call, with nothing to clear.

## Credits

Written by **Henrique Van Klaveren**.

## License

MIT — see `LICENSE`. Use it however you like.
