import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'

const IMAGE = 'mcr.microsoft.com/playwright/mcp:latest'
const ready = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
    execFileSync('docker', ['image', 'inspect', 'node:22-alpine'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/**
 * O isolamento DE VERDADE, com Docker e a imagem oficial do Playwright MCP. Pulado sem Docker (ou sem as
 * imagens): é a prova de que a promessa da tela vale — não um teste de unidade.
 */
describe('MCP em contêiner (Docker de verdade)', { skip: !ready && 'Docker or images not available' }, () => {
  const repository = new SqliteMcpServerRepository(':memory:')
  const now = new Date()
  const config: IMcpServerConfig = {
    id: 'pw',
    name: 'Playwright',
    kind: 'container',
    container: {
      image: IMAGE,
      args: ['--isolated', '--proxy-server={proxy}'],
      writable: ['/home/node'],
      memoryMb: 1024,
      cpus: 1,
      network: 'allowlist',
      allowedHosts: ['{meta:siteDomain}'],
      env: [],
    },
    url: '',
    transport: 'auto',
    auth: 'none',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  repository.insert(config)
  const registry = new McpRegistry(repository, { get: () => undefined })
  const metadata: Record<string, Record<string, unknown>> = { 'conv-a': { siteDomain: 'example.com' }, 'conv-b': {} }
  registry.setSessionLookup((id) => ({ agentId: 'inspetor', metadata: metadata[id] }))

  after(async () => {
    await registry.closeInstances()
  })

  const navigate = async (session: string, url: string) => {
    const client = await registry.clientFor('pw', session)
    const result = await client!.callTool('browser_navigate', { url })
    return result.result
  }

  it('⛔ a conversa A só alcança o domínio dela; outro site, o host do gateway e a LAN são bloqueados', async () => {
    assert.match(await navigate('conv-a', 'https://example.com'), /Example Domain/)
    for (const url of ['https://www.wikipedia.org', 'http://host.docker.internal:3100/v1/health', 'http://192.168.65.254:3100/', 'http://localhost:3100/']) {
      assert.doesNotMatch(await navigate('conv-a', url), /Page Title: \\S/, url)
    }
  })

  it('⛔ a conversa B tem o próprio navegador (não vê a A) e, sem domínio no metadata, não sai para a rede', async () => {
    assert.doesNotMatch(await navigate('conv-b', 'https://example.com'), /Example Domain/)
    const client = await registry.clientFor('pw', 'conv-b')
    const snapshot = await client!.callTool('browser_snapshot', {})
    assert.doesNotMatch(snapshot.result, /Example Domain/)
    assert.strictEqual(registry.status().find((entry) => entry.id === 'pw')?.instances, 2)
  })
})
