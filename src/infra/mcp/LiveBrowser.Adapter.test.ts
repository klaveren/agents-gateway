import assert from 'node:assert'
import { describe, it } from 'node:test'
import { argsForEndpoint, isPlaywrightMcp, LiveBrowsers, liveBrowserEnabled, takesExternalBrowser, TLiveBrowserListener } from './LiveBrowser.Adapter'

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
