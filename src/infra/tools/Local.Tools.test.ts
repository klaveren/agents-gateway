import assert from 'node:assert'
import { describe, it } from 'node:test'
import { makeLocalTools, type IExecOptions, type TExec } from './Local.Tools'
import { ILocalTool } from './Tool.Types'

describe('LocalTools', () => {
  const policy = { timeoutMs: 1234, maxOutputChars: 50, cwd: '/tmp/sandbox' }

  const noopExec: TExec = async () => ({ stdout: 'ok', stderr: '' })

  const toolsWith = (exec?: TExec, fetchHtml?: (query: string) => Promise<string>) => makeLocalTools({ exec: exec ?? noopExec, fetchHtml: fetchHtml ?? (async () => ''), policy })
  const find = (tools: ILocalTool[], name: string): ILocalTool => {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `${name} missing`)
    return tool
  }

  it('exposes exactly the two built-in tools', () => {
    assert.deepStrictEqual(
      toolsWith().map((tool) => tool.name),
      ['search_web', 'run_bash'],
    )
  })

  it('runs a command inside the configured policy', async () => {
    let seen: IExecOptions | undefined
    const tools = toolsWith(async (_command: string, options: IExecOptions) => {
      seen = options
      return { stdout: 'a.txt\n', stderr: '' }
    })

    const outcome = await find(tools, 'run_bash').execute({ command: 'ls' })

    assert.strictEqual(outcome.status, 'success')
    assert.strictEqual(outcome.result, 'a.txt\n')
    assert.strictEqual(seen?.timeout, 1234)
    assert.strictEqual(seen?.cwd, '/tmp/sandbox')
  })

  it('refuses a destructive command without ever reaching the shell', async () => {
    let called = false
    const tools = toolsWith(async () => {
      called = true
      return { stdout: '', stderr: '' }
    })

    const outcome = await find(tools, 'run_bash').execute({ command: 'rm -rf /' })

    assert.strictEqual(called, false)
    assert.strictEqual(outcome.status, 'error')
    assert.match(outcome.result, /Refused by the gateway tool policy: recursive force delete/)
  })

  it('truncates long output at the policy limit', async () => {
    const tools = toolsWith(async () => ({ stdout: 'A'.repeat(500), stderr: '' }))
    const outcome = await find(tools, 'run_bash').execute({ command: 'cat big.txt' })

    assert.ok(outcome.result.includes('truncated at 50 characters'))
  })

  it('reports a failed command as an error result rather than throwing', async () => {
    const tools = toolsWith(async () => {
      throw new Error('Command failed: nope')
    })

    const outcome = await find(tools, 'run_bash').execute({ command: 'nope' })

    assert.strictEqual(outcome.status, 'error')
    assert.match(outcome.result, /Execution failed: Command failed: nope/)
  })

  it('parses search results out of the html', async () => {
    const html = `
      <div class="result__body">
        <a class="result__a" href="#">First <b>hit</b></a>
        <a class="result__snippet">Something &amp; useful</a>
      </div>
      <div class="result__body">
        <a class="result__a" href="#">Second hit</a>
        <a class="result__snippet">More detail</a>
      </div>`

    const tools = toolsWith(undefined, async () => html)
    const outcome = await find(tools, 'search_web').execute({ query: 'anything' })

    assert.strictEqual(outcome.status, 'success')
    assert.match(outcome.result, /Title: First hit/)
    assert.match(outcome.result, /Snippet: Something & useful/)
    assert.match(outcome.result, /Title: Second hit/)
  })

  it('says so when the search finds nothing', async () => {
    const tools = toolsWith(undefined, async () => '<html></html>')
    const outcome = await find(tools, 'search_web').execute({ query: 'anything' })

    assert.strictEqual(outcome.result, 'No results found.')
  })

  it('rejects an empty query and reports a failing fetch', async () => {
    const tools = toolsWith(undefined, async () => {
      throw new Error('offline')
    })

    assert.strictEqual((await find(tools, 'search_web').execute({ query: '  ' })).status, 'error')
    assert.match((await find(tools, 'search_web').execute({ query: 'x' })).result, /Search failed: offline/)
  })
})
