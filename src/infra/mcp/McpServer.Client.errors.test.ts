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

  it('⛔ na CONEXÃO: o MCP de projeto não alcança loopback nem LAN; o link-local nunca (nem o global)', async () => {
    const quiet = console.warn
    console.warn = () => undefined
    try {
      const project = new McpServerClient('http://127.0.0.1:9/mcp', {}, { auth: 'none' })
      assert.strictEqual(await project.connect(), false)
      assert.match(project.lastError ?? '', /loopback/)
      const mapped = new McpServerClient('http://[::ffff:7f00:1]:9/mcp', {}, { auth: 'none' })
      assert.strictEqual(await mapped.connect(), false)
      assert.match(mapped.lastError ?? '', /loopback/)
      const lan = new McpServerClient('http://10.255.255.1/mcp', {}, { auth: 'none' })
      assert.strictEqual(await lan.connect(), false)
      assert.match(lan.lastError ?? '', /rede local/)
      const global = new McpServerClient('http://169.254.169.254/mcp', {}, { auth: 'none', allowPrivate: true })
      assert.strictEqual(await global.connect(), false)
      assert.match(global.lastError ?? '', /link-local/)
    } finally {
      console.warn = quiet
    }
  })
})
