import assert from 'node:assert'
import { describe, it } from 'node:test'
import { isCloudMetadataHost } from '@domain/Url.Policy'
import { mcpUrlIssue } from '@domain/models/McpServer.Model'
import { withoutRemoteBody } from './McpServer.Client'

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
})
