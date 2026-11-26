import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  argsForEndpoint,
  argsForOutputDir,
  INPUT_TIMEOUT_MS,
  isPlaywrightMcp,
  LiveBrowser,
  LiveBrowsers,
  liveBrowserEnabled,
  takesExternalBrowser,
  TLiveBrowserListener,
} from './LiveBrowser.Adapter'

describe('LiveBrowser — o navegador da conversa que a tela vê', () => {
  it('reconhece o Playwright MCP, com ou sem versão', () => {
    assert.equal(isPlaywrightMcp('@playwright/mcp'), true)
    assert.equal(isPlaywrightMcp('@playwright/mcp@latest'), true)
    assert.equal(isPlaywrightMcp('@playwright/mcp@0.0.85'), true)
    assert.equal(isPlaywrightMcp('@playwright/mcp-extra'), false)
    assert.equal(isPlaywrightMcp('n8n-mcp'), false)
    assert.equal(isPlaywrightMcp(undefined), false)
  })

  it('aponta o MCP para o CDP do gateway e tira as opções de abrir navegador', () => {
    assert.deepEqual(argsForEndpoint(['--headless', '--isolated', '--no-sandbox', '--caps', 'vision', '--browser', 'chrome', '--user-data-dir=/x'], 'http://127.0.0.1:9'), [
      '--caps',
      'vision',
      '--cdp-endpoint',
      'http://127.0.0.1:9',
    ])
  })

  it('deixa como está quem já aponta para outro navegador', () => {
    assert.equal(takesExternalBrowser(['--cdp-endpoint', 'http://x']), true)
    assert.equal(takesExternalBrowser(['--cdp-endpoint=http://x']), true)
    assert.equal(takesExternalBrowser(['--extension']), true)
    assert.equal(takesExternalBrowser(['--headless']), false)
  })

  it('desliga com GATEWAY_LIVE_BROWSER=0', () => {
    assert.equal(liveBrowserEnabled({}), true)
    assert.equal(liveBrowserEnabled({ GATEWAY_LIVE_BROWSER: '0' }), false)
  })

  it('quem assiste antes de o navegador abrir ouve que ele está fechado, e para de ouvir ao sair', () => {
    const browsers = new LiveBrowsers()
    const heard: unknown[] = []
    const listener: TLiveBrowserListener = (event) => heard.push(event)
    const stop = browsers.watch('s1', listener)
    assert.deepEqual(heard, [{ type: 'state', live: false }])
    assert.equal(browsers.has('s1'), false)
    assert.equal(browsers.get('s1'), undefined)
    stop()
  })
})

describe('argsForOutputDir — capturas na pasta de rascunho do projeto', () => {
  it('acrescenta --output-dir; quem já definiu fica como está', () => {
    assert.deepEqual(argsForOutputDir(['--caps', 'vision'], '/p/.tmp'), ['--caps', 'vision', '--output-dir', '/p/.tmp'])
    assert.deepEqual(argsForOutputDir(['--output-dir=/x'], '/p/.tmp'), ['--output-dir=/x'])
    assert.deepEqual(argsForOutputDir(['--output-dir', '/x'], '/p/.tmp'), ['--output-dir', '/x'])
  })
})

describe('LiveBrowser.input — nenhum evento trava a entrada da tela', () => {
  /** Um navegador ligado a um CDP falso que anota os comandos e só responde a quem `answer` deixar. */
  function fakeBrowser(answer: (method: string, params: Record<string, unknown>) => boolean) {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    const browser = new (LiveBrowser as unknown as new (child: unknown, endpoint: string) => LiveBrowser)({ exitCode: 0 }, 'http://127.0.0.1:0')
    const inner = browser as unknown as { ws: unknown; attached: unknown; calls: Map<number, unknown>; onMessage(raw: string): void }
    inner.ws = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
        sent.push(message)
        if (answer(message.method, message.params)) queueMicrotask(() => inner.onMessage(JSON.stringify({ id: message.id, result: {} })))
      },
    }
    inner.attached = { targetId: 't1', sessionId: 's1' }
    return { browser, sent, calls: inner.calls }
  }

  it('a rolagem responde na hora, mesmo que a aba nunca confirme', async () => {
    const { browser, sent } = fakeBrowser((_method, params) => params.type !== 'mouseWheel')
    const started = Date.now()
    await browser.input({ type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 300 })
    assert.ok(Date.now() - started < 100)
    assert.deepStrictEqual(
      sent.map((one) => one.params.type),
      ['mouseWheel'],
    )
    // A entrada seguinte não espera a rolagem.
    await browser.input({ type: 'move', x: 1, y: 2 })
    assert.deepStrictEqual(
      sent.map((one) => one.params.type),
      ['mouseWheel', 'mouseMoved'],
    )
  })

  it('comando de entrada sem resposta rejeita no tempo limite e libera o id', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { browser, calls } = fakeBrowser(() => false)
    const pending = browser.input({ type: 'text', text: 'oi' })
    const outcome = pending.then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    assert.strictEqual(calls.size, 1)
    context.mock.timers.tick(INPUT_TIMEOUT_MS)
    assert.match(await outcome, /Input.insertText did not answer/)
    assert.strictEqual(calls.size, 0)
  })

  it('a rolagem sem resposta também não deixa promessa pendente', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { browser, calls } = fakeBrowser(() => false)
    await browser.input({ type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 100 })
    assert.strictEqual(calls.size, 1)
    context.mock.timers.tick(INPUT_TIMEOUT_MS)
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(calls.size, 0)
  })
})
