# agents-gateway

> **⚠️ Alpha Version**: This project is currently in early alpha. Features and APIs may change.

### Run multiple AI providers against your local machine. From a single glass UI.

> A lightweight proxy that connects the latest models from **Google, Anthropic, and OpenAI** directly
> to your local Model Context Protocol (MCP) server.
> **Full multimodal support. Dynamic reasoning injection. Pure TypeScript.**

You probably have an MCP server exposing your local filesystem or bash shell. You probably also have API keys for Gemini, Claude, and GPT. This gateway bridges them. It serves a sleek, glassmorphism web UI where you can switch between agents on the fly, upload files, dial up their reasoning effort, and watch them execute local tools in real-time.

---

## Is this your problem?

You are in the right place if any of this sounds familiar:

- You want to test how different LLMs (Gemini 3.7, Claude 5, GPT-5.6) perform with local tools, but writing a new test harness for each SDK is exhausting.
- You need a simple UI to chat with your local agents instead of staring at terminal logs.
- You want to **upload an image or a PDF** and have a local agent run a script based on what it sees.
- You are tired of manually handling the nuanced differences between Anthropic's `output_config.effort`, OpenAI's `reasoning_effort`, and Gemini's dynamic thinking.

> **The short version:** Agent Gateway abstracts away the SDK quirks. It presents a unified `/sessions` API and a beautiful frontend to interact with pre-configured agents (Researcher, SysOps, Data Analyst), translating your intent into the exact parameters and tool calls each provider demands.

---

## TL;DR

Agent Gateway is an Express server + Vanilla JS frontend that manages AI sessions, normalizes multimodal attachments, maps MCP tools to native function declarations, and streams Server-Sent Events (SSE) back to the browser.

```
YOU (Browser)                   GATEWAY                        MCP SERVER
[Attach image]  ------->  POST /messages (Base64)
[Set Reasoning] ------->  Injects `reasoning_effort`
                          Translates to Gemini/Claude/GPT ---> Executes local tool
                          <----------------------------------- Returns tool result
[See UI Badge]  <-------  SSE: tool.started / tool.result
```

---

## The Problem

Every AI provider implements tool calling and reasoning differently.
- OpenAI requires `reasoning_effort: 'low'` and strict function schemas.
- Anthropic uses `output_config: { effort: 'high' }` and distinguishes between `image` and `document` blocks.
- Google Gemini relies on `inlineData` for files and uses a completely different function declaration signature.

Building a multi-agent system means you end up maintaining three different state machines, three different message history parsers, and three different streaming implementations.

## The Solution

A modular adapter pattern. The Gateway core (`AgentController` and `SendMessageUseCase`) only speaks one language: the `IMessageInput` domain model. 

When you send a message with an attached PDF and ask the SysOps agent to "summarize this and save it to my desktop", the gateway:
1. Converts the file to Base64 in the browser.
2. Routes the request to `ClaudeAdapter.ts`.
3. Maps the MCP tools to Anthropic's `tools` array.
4. Appends the PDF as a `document` source block.
5. Streams the thought process and intercepts the `tool_use` to execute the bash command locally via the `McpServerClient`.

### Features at a glance:
- **Multimodal File Uploads:** Drag, drop, and send images and PDFs directly to the models.
- **Reasoning Controls:** UI dropdowns to adjust the compute budget (`none`, `low`, `medium`, `high`, `xhigh`) mapped correctly to each API.
- **Language Localization:** Switch between English and Portuguese. The UI dynamically swaps Quick Prompts, and the Gateway strictly instructs the agent to reply in your chosen language.
- **Glassmorphism UI:** Built with Tailwind v4, featuring a responsive, animated, and modern aesthetic.

---

## Configuration

The gateway relies on standard environment variables. You only need the keys for the agents you intend to use.

```bash
# .env
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIzaSy...
```

Run the development server:

```bash
pnpm dev
```

The gateway listens on `http://localhost:3000`. It expects an MCP server to be running on `http://localhost:8000/mcp`.

---

## Architecture

| Layer | Responsibility |
| --- | --- |
| **Domain** | `AgentRegistry` definitions, standard `IMessageInput` and `IAgentEvent` models. |
| **Application** | `SendMessage.Usecase` coordinating the flow between Adapters and the MCP client. |
| **Infra (Adapters)** | `ClaudeAdapter`, `GoogleAdapter`, `OpenAIAdapter`. Where the SDK-specific magic happens. |
| **Infra (HTTP)** | Express server, SSE streaming, and the static Vanilla JS frontend. |

---

## Credits

Written by **Henrique Van Klaveren**.

## License

MIT — see `LICENSE`. Use it however you like.
