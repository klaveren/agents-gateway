# agents-gateway

> **⚠️ Alpha Version**: This project is currently in early alpha. Features and APIs may change.

### Run the same agent two ways — plain SDK, or the official Agents SDK. Side by side, from a single glass UI.

> A lightweight gateway that puts **Google, Anthropic and OpenAI** behind one API, and runs
> each of them in **two lanes**: a `chat` lane on the provider's plain SDK, and an `agent`
> lane on the provider's own Agents SDK.
> **Full multimodal support. Real cancellation. MCP. Pure TypeScript.**

You have API keys for Gemini, Claude and GPT. You probably also have an MCP server exposing
your filesystem or shell. This gateway bridges them — and, more to the point, it lets you
watch the same agent solve the same task twice: once as a conversation you drive, once as a
loop the vendor's own framework drives.

---

## The point of the experiment

There are two very different things people call "using an LLM":

| | `chat` lane | `agent` lane |
| --- | --- | --- |
| SDK | `@anthropic-ai/sdk`, `openai`, `@google/generative-ai` | `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@google/adk` |
| Who runs the tool loop | nobody — there are no tools | the SDK |
| What it is good at | conversation, attachments, reasoning control | multi-step work, tools, MCP |
| Lines of orchestration we wrote | 0 | 0 |

That last row is the whole thesis. An earlier version of this project built a hand-rolled
agentic state machine on top of the *plain* SDKs — a `while (shouldContinue)` loop that
accumulated the stream, executed a tool, and fed the result back, written three times, once
per provider, and already drifting apart. Every provider ships an official agentic SDK that
does this better. So the loop is gone, and the two lanes exist to make the difference
visible instead of arguing about it.

A chat is not a tool run. This gateway lets you feel that.

---

## Is this your problem?

- You want to compare how Gemini, Claude and GPT behave with local tools, without writing a
  harness per SDK.
- You want to know what an **Agents SDK** actually buys you over calling the plain API in a
  loop — measured, not asserted.
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

### Gotchas worth knowing before you run it

These are not opinions — each one costs an afternoon if you meet it the hard way.

- **`@google/adk` does not read `GOOGLE_API_KEY`.** It wants `GOOGLE_GENAI_API_KEY` or
  `GEMINI_API_KEY`. The gateway bridges the value at boot and tells you it did, but set the
  real variable if you can.
- **`@openai/agents` enables tracing the moment you import it**, and ships prompts, tool
  inputs and tool outputs to `api.openai.com/v1/traces/ingest` using your `OPENAI_API_KEY`.
  `src/main.ts` calls `setTracingDisabled(true)` before anything else. Keep it there.
- **`@anthropic-ai/claude-agent-sdk` runs a bundled `claude` binary (~310 MB)**, delivered as
  a per-platform optionalDependency. It needs only `ANTHROPIC_API_KEY` — no separate Claude
  Code install — but `npm install --omit=optional` breaks it, and it is a real cold start on
  the first turn of a session.
- **Node ≥ 22.12.** All three Agents SDKs load under `require()` only thanks to Node's
  `require(ESM)` support.

### Perimeter

The gateway executes `run_bash`, so it is closed by default: it binds to `127.0.0.1` and
rejects every cross-origin request. The bundled UI is same-origin and unaffected.

| Env | Default | What it does |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Change it only if you know who else is on the network. |
| `CORS_ORIGINS` | *(none)* | Comma-separated allowlist. Needed if you serve a frontend from another port. |
| `GATEWAY_TOKEN` | *(none)* | When set, `/v1/*` requires `Authorization: Bearer`. The UI reads it from `localStorage.gatewayToken`. |
| `JSON_LIMIT` | `25mb` | Request body cap. Base64 attachments inflate ~33%. |

### Tool safety

`run_bash` runs with a timeout, an output cap, a configurable `cwd`, and a deny-list for the
catastrophic ones (`rm -rf`, `mkfs`, `dd` onto a device, fork bombs, `curl | sh`, `sudo`,
`shutdown`). On top of that sits each SDK's own gate — `canUseTool` on Claude, `needsApproval`
on OpenAI.

This is **not a sandbox** and does not pretend to be. It is a guard against the catastrophic
command typed by mistake or hallucinated by a model. Real containment means isolating the
process: a container, an unprivileged user.

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

Versioned under `/v1`. The full contract is served at `/v1/openapi.json`, and a test fails
the build if it drifts from the routes the server actually registers.

| Route | What it does |
| --- | --- |
| `GET /v1/health` | Liveness, MCP status, live session count. |
| `GET /v1/agents` | The registry, including which lanes each agent supports. |
| `GET /v1/agents/:agentId/tools` | Tool catalog filtered by what that agent declares. |
| `GET /v1/tools` | Full catalog: built-in tools merged with whatever MCP exposes. |
| `POST /v1/sessions` | `{ agentId, mode, model, reasoning, language }` → a session. |
| `GET /v1/sessions` | Live sessions, most recently active first. |
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
`mode_not_supported`, `unauthorized`, `internal_error` — so a client can branch without
parsing prose.

---

## Credits

Written by **Henrique Van Klaveren**.

## License

MIT — see `LICENSE`. Use it however you like.
