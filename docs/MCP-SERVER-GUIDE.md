# Writing an MCP server to put behind this gateway

The gateway calls your tools on behalf of a person, through a model. That changes what a good
tool looks like: the model reads every byte you return, pays for it on every turn, and will happily
retry a call that looked like it failed. These rules came from running that setup in production.
Each one is a rule, the reason, and a tiny example. None of them depends on a particular backend.

## 1. Lock every update with the version you read

**Rule.** Every update tool takes the version it was based on (`modified`, an etag, a revision) as a
**required** argument, and refuses if the stored version differs. Nothing is written on refusal.
After writing, **re-read** the version for the ACK.

**Why.** The model reads, thinks, asks the human, and writes minutes later. Without a lock it
overwrites whatever a person changed in between. Re-read after the write because some backends write
twice (a hook touches the record), so the version you computed before is already stale.

```ts
async function updateItem({ id, modified, changes }) {
  const current = await backend.get(id)
  if (current.modified !== modified) return { ok: false, error: 'changed', current: current.modified }
  await backend.put(id, merge(current, changes))
  return { ok: true, id, modified: (await backend.get(id)).modified } // read AFTER the write
}
```

## 2. Updates return an ACK, not the entity

**Rule.** Return `{ ok, id, modified }` and maybe the fields that changed. Not the whole record.

**Why.** The entity can be large and the model will re-read it anyway if it needs it. It is output
tokens spent on every write, and a stale copy of the record sitting in the conversation invites the
model to reason from it later.

```json
{ "ok": true, "id": "p-42", "modified": "2026-03-02T10:15:00" }
```

## 3. Make partial updates really partial

**Rule.** (a) Fields the backend demands on **every** update are filled by the server from the same
version read (`keep`), not by the model. (b) For sub-objects the backend replaces wholesale, merge:
an omitted part keeps its stored value, and `null` explicitly removes it.

**Why.** A model sends what it wants to change. A backend that replaces the whole sub-object turns
"change the price" into "delete the stock". Distinguishing absent from `null` is the only way to
say "leave it" and "remove it" in the same schema.

```ts
// stored: { price: 10, stock: 5 }        call: { price: 12 }            -> { price: 12, stock: 5 }
// stored: { price: 10, stock: 5 }        call: { stock: null }          -> { price: 10 }
const next = { ...current.sub }
for (const [key, value] of Object.entries(patch)) value === null ? delete next[key] : (next[key] = value)
```

## 4. Confirm before writing, in the persona

**Rule.** The agent's system prompt says: before any write, show **before and after** in plain words
and wait for a yes. Reads never ask.

**Why.** A tool-level lock stops collisions, not mistakes. Showing the diff is what lets the person
catch "wrong product" or "wrong month" while it is still free to fix.

```text
Before any change: list what will change as "field: old -> new", ask "Apply?", and call the
update tool only after an explicit yes.
```

## 5. No delete tools, by design

**Rule.** Do not expose delete. Offer deactivate/archive if the business needs it, and keep real
removal out of band.

**Why.** A model can be talked into things, and a deleted record has no undo. The cost of the missing
tool is one sentence ("I can't delete, I can deactivate it"); the cost of the present one is data.

```ts
tools: [searchItems, getItem, updateItem, deactivateItem] // no deleteItem
```

## 6. Treat the budget as a test

**Rule.** Put two numbers under test and fail the build when they grow: the **bytes of the tool
catalog** (names, descriptions, schemas) and the **bytes of one page** of each list tool. Derive the
page size from the payload budget, not the other way round.

**Why.** The catalog is paid on every turn of every conversation, and it grows one innocent
sentence at a time. A page that is "50 rows" can be 4 KB or 400 KB depending on the row.

```ts
test('catalog stays under 12 KB', () => expect(bytes(listTools())).toBeLessThan(12_000))
test('a page of items stays under 20 KB', () => expect(bytes(search({ limit: pageSize() }))).toBeLessThan(20_000))
const pageSize = () => Math.floor(PAGE_BUDGET_BYTES / worstCaseRowBytes)
```

## 7. Project for the reader: labels, not raw numbers

**Rule.** Return ready-made labels with units and currency (`"R$ 12,50"`, `"3 units"`,
`"10% off"`), never ambiguous raw numbers. Return dates in the **business's local time without an
offset**, and interpret dates the person writes in that same clock.

**Why.** A discount range was read as a count of items instead of money, because `{ "min": 5,
"max": 10 }` says nothing about what it measures. And a UTC round-trip shifted a promotion by 3
hours: written as local, stored as UTC, shown as local again.

```json
{ "discount": "5% to 10% off", "price": "R$ 12,50", "starts": "2026-03-02T00:00:00" }
```

## 8. Cut calls per question

**Rule.** Make the common question answerable in one or two calls:
- return ids **with** ranked rows, so the follow-up needs no lookup;
- offer exclusion filters (`not_in`), so "other than these" is one call;
- aggregate counts on the server instead of paging to count;
- inject session context (who, which account, today's date) in the first message
  (`SESSION_CONTEXT_TEMPLATE`) instead of a `get_context` tool call.

**Why.** Every call is a round-trip of latency and a re-read of the whole conversation. Cutting calls
beat caching in practice: the five costliest questions went from 6-33 tool calls to 2, with no
change to the model or the prompt.

```text
search_items({ q: "...", exclude_ids: [..], with_counts: true }) -> { rows: [{ id, label, ... }], total: 132 }
```

## 9. The caller's credential, per request

**Rule.** Authorize each call with the credential the gateway forwards (`Authorization: Bearer`
carrying the caller's token). Never fall back silently to a server-side token where the request is
supposed to be the caller's own. If there is no credential, fail; if a server token is legitimate
(a health check, local stdio), make that an explicit, named path.

**Why.** A silent fallback turns "unauthenticated" into "authenticated as the server", and the model
will then show one person data they could not see themselves. It is also the failure that looks like
success: the call works.

```ts
const token = bearerOf(request)
if (!token) throw new Error('unauthorized') // not: token ?? process.env.SERVER_TOKEN
```

If you want the gateway to prove who is calling, expose a cheap tool that returns
`{ "authenticated": true }` for a valid token and point `CALLER_PROOF_TOOL` at it.
