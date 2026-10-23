import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { InvalidMcpServerError, McpServerInUseError } from '@domain/errors/Domain.Error'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { McpServersService } from './McpServers.Service'

describe('McpServersService', () => {
  const build = (agents: IAgent[] = []) => {
    const secrets = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:')
    return { service: new McpServersService(new SqliteMcpServerRepository(':memory:'), secrets, () => agents), secrets }
  }
  const agent = (allowedTools: string[]): IAgent => ({ id: 'a', name: 'Agente A', provider: EProvider.CLAUDE, systemPrompt: 'p', models: ['m'], modes: [EMode.CHAT], allowedTools })

  it('cria com os padrões, e o segredo vai para o cofre — só o final dele é visível', () => {
    const { service, secrets } = build()
    const created = service.create({ id: 'crm', name: 'CRM', url: 'https://mcp.exemplo.com/mcp', auth: 'header', secret: 'Bearer s3gr3d0' }, 'root')

    assert.deepStrictEqual([created.transport, created.auth, created.headerName, created.enabled], ['auto', 'header', undefined, true])
    assert.strictEqual(secrets.get('mcp:crm'), 'Bearer s3gr3d0')
    assert.deepStrictEqual([service.secretStatus('crm').configured, service.secretStatus('crm').last4], [true, 'r3d0'])
  })

  it('devolve todos os problemas: id, nome, URL (só http/https, sem credencial embutida)', () => {
    const { service } = build()
    assert.throws(
      () => service.create({ id: 'X', name: ' ', url: 'ftp://x' }, 'root'),
      (error: InvalidMcpServerError) => error.issues.map((issue) => issue.field).join() === 'id,name,url',
    )
    assert.throws(() => service.create({ id: 'ok-id', name: 'x', url: 'https://user:pass@x.com/mcp' }, 'root'), InvalidMcpServerError)
  })

  it('⛔ remover servidor em uso diz quais agentes usam; livre, some junto com o segredo', () => {
    const using = build([agent(['mcp:crm/stats'])])
    using.service.create({ id: 'crm', name: 'CRM', url: 'https://x.com/mcp' }, 'root')
    assert.throws(
      () => using.service.remove('crm'),
      (error: McpServerInUseError) => error.agents.join() === 'Agente A',
    )

    const free = build()
    free.service.create({ id: 'crm', name: 'CRM', url: 'https://x.com/mcp', auth: 'header', secret: 'x' }, 'root')
    free.service.remove('crm')
    assert.deepStrictEqual([free.service.list(), free.secrets.get('mcp:crm')], [[], undefined])
  })

  it('o header vale para `caller` (onde vai a credencial de quem conversa) e some com `none`', () => {
    const { service } = build()
    service.create({ id: 'crm', name: 'CRM', url: 'https://x.com/mcp', auth: 'header', headerName: 'X-Api-Key' }, 'root')
    assert.strictEqual(service.update('crm', { auth: 'caller' }, 'root').headerName, 'X-Api-Key')
    assert.strictEqual(service.update('crm', { auth: 'none' }, 'root').headerName, undefined)
  })
})
