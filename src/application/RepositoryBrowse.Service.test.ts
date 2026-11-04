import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { IRepoEntry, IRepoText } from '@domain/ports/FormatDetector.Port'
import { RepositoryBrowseError, RepositoryBrowseService } from './RepositoryBrowse.Service'

/** Um repositório falso: os caminhos e o texto; a exclusão é a do serviço (o que ele passa é o que vale). */
function setup(repositories: string[] = ['app']) {
  const files: Record<string, string> = {
    'apps/form.vue': '<i-form :fields="x" />',
    '.agents/skills/form/SKILL.md': 'Use <i-form :fields>.',
    '.env': 'SEGREDO=1',
    '.env.example': 'SEGREDO=',
    'conf/secrets.json': '{"k":"v"}',
    'keys/server.pem': 'PEM',
    'vendor/lib.js': 'x',
  }
  const seen: string[] = []
  const service = new RepositoryBrowseService({
    repositories: () => repositories,
    projectIgnore: () => ['vendor'],
    files: {
      list: (_project, repository, _under, exclude) => (
        seen.push(repository),
        Object.keys(files)
          .filter((path) => !exclude(path))
          .map((path): IRepoEntry => ({ path, aliases: [], bytes: files[path].length }))
      ),
      read: (_project, repository, path, exclude): IRepoText | 'excluded' | 'not_found' => {
        seen.push(repository)
        if (exclude(path)) return 'excluded'
        return files[path] === undefined ? 'not_found' : { path, bytes: files[path].length, text: files[path] }
      },
    },
  })
  return { service, seen }
}

describe('RepositoryBrowseService — o construtor lê o repositório do projeto', () => {
  it('⛔ lista e lê o código, nunca credenciais, .env*, arquivos de segredo da camada sistema nem o ignorar do projeto', () => {
    const { service } = setup()
    const listed = service.list('alfa')
    assert.match(listed, /apps\/form\.vue/)
    assert.match(listed, /\.agents\/skills\/form\/SKILL\.md/)
    for (const hidden of ['.env ', '.env.example', 'secrets.json', 'server.pem', 'vendor/lib.js']) assert.ok(!listed.includes(hidden), hidden)
    assert.match(service.read('alfa', { path: 'apps/form.vue' }), /<i-form :fields="x" \/>/)
    for (const path of ['.env', 'conf/secrets.json', 'keys/server.pem'])
      assert.throws(
        () => service.read('alfa', { path }),
        (error: unknown) => error instanceof RepositoryBrowseError && /excluded/.test(error.message),
      )
  })

  it('o repositório: o único do projeto sem pedir; com vários, pede qual; ⛔ o que não é do projeto é recusado', () => {
    const { service, seen } = setup(['app', 'api'])
    assert.throws(() => service.list('alfa'), /say which one \(app, api\)/)
    service.list('alfa', { repository: 'api' })
    assert.deepStrictEqual(seen, ['api'])
    assert.throws(() => service.read('alfa', { repository: 'outro', path: 'x' }), /not a repository of project alfa/)
    assert.throws(() => setup([]).service.list('alfa'), /has no repository/)
  })

  it('lê em páginas e diz onde continuar', () => {
    const { service } = setup()
    const page = service.read('alfa', { path: '.agents/skills/form/SKILL.md', offset: 0, limit: 5 })
    assert.match(page, /characters 0–5 of 21\. More: call again with offset 5\./)
  })
})
