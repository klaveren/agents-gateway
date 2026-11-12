import assert from 'node:assert'
import { describe, it } from 'node:test'
import { isCloudMetadataHost } from '@domain/Url.Policy'
import { mcpUrlIssue } from '@domain/models/McpServer.Model'
import { McpServerClient, withoutRemoteBody } from './McpServer.Client'

describe('SSRF por URL de MCP', () => {
  it('⛔ o erro não ecoa o corpo da resposta remota', () => {
    assert.strictEqual(
      withoutRemoteBody('Streamable HTTP error: Error POSTing to endpoint: {"AccessKeyId":"AKIA"}'),
      'Streamable HTTP error: Error POSTing to endpoint (remote body omitted)',
    )
    assert.strictEqual(withoutRemoteBody('fetch failed'), 'fetch failed')
  })

  it('⛔ metadata de nuvem e link-local recusados', () => {
    for (const host of ['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]', '[::ffff:169.254.169.254]']) assert.ok(isCloudMetadataHost(host), host)
    assert.ok(!isCloudMetadataHost('api.example.com'))
    assert.match(mcpUrlIssue('http://169.254.169.254/latest/meta-data') ?? '', /metadata/)
    assert.strictEqual(mcpUrlIssue('https://mcp.example.com/mcp'), undefined)
  })

  it('⛔ a URL normalizada pelo URL (mapeado em hexa) também é metadado', () => {
    assert.match(mcpUrlIssue('http://[::ffff:169.254.169.254]/x') ?? '', /metadata/)
    assert.match(mcpUrlIssue('http://[::ffff:a9fe:a9fe]/x') ?? '', /metadata/)
    assert.match(mcpUrlIssue('http://[2002:a9fe:a9fe::1]/x') ?? '', /metadata/)
  })

  it('na CONEXÃO: o endereço cadastrado passa (loopback e LAN, global ou de projeto); ⛔ o link-local, nunca', async () => {
    const quiet = console.warn
    console.warn = () => undefined
    try {
      for (const url of ['http://127.0.0.1:9/mcp', 'http://[::ffff:7f00:1]:9/mcp']) {
        const local = new McpServerClient(url, {}, { auth: 'none' })
        assert.strictEqual(await local.connect(), false)
        assert.doesNotMatch(local.lastError ?? '', /loopback|rede local|link-local/, url)
      }
      const metadata = new McpServerClient('http://169.254.169.254/mcp', {}, { auth: 'none' })
      assert.strictEqual(await metadata.connect(), false)
      assert.match(metadata.lastError ?? '', /link-local/)
    } finally {
      console.warn = quiet
    }
  })
})
