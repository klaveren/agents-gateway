import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const SCRIPT = resolve(__dirname, '../../infra/debian/backup.sh')
const SETUP = resolve(__dirname, '../../infra/debian/setup.sh')
const root = mkdtempSync(join(tmpdir(), 'gw-backup-'))
after(() => rmSync(root, { recursive: true, force: true }))

const KEY = 'SEGREDO-DE-TESTE-NAO-PODE-APARECER-NO-LOG='

/** Uma pasta de dados de exemplo: banco em WAL, chave, projeto com repositório/.cache/.tmp. */
function makeData(name: string): string {
  const data = join(root, name)
  for (const d of ['repositories/repo', '.cache', '.tmp', 'docs']) mkdirSync(join(data, 'projects/p1', d), { recursive: true })
  writeFileSync(join(data, 'projects/p1/repositories/repo/codigo.ts'), 'clone')
  writeFileSync(join(data, 'projects/p1/.cache/x'), 'cache')
  writeFileSync(join(data, 'projects/p1/.tmp/y'), 'tmp')
  writeFileSync(join(data, 'projects/p1/docs/nota.md'), 'fica')
  writeFileSync(join(data, 'secrets.key'), KEY, { mode: 0o600 })
  const db = new DatabaseSync(join(data, 'gateway.db'))
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('um'), ('dois')")
  db.close()
  return data
}

function run(data: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NODE_BIN: process.execPath, GATEWAY_DATA: data, ...extra },
  })
}

describe('infra/debian/backup.sh', () => {
  it('é bash válido (o script e o setup)', () => {
    execFileSync('bash', ['-n', SCRIPT])
    execFileSync('bash', ['-n', SETUP])
  })

  it('o setup instala o serviço oneshot e o timer diário 03:30 persistente', () => {
    const setup = readFileSync(SETUP, 'utf8')
    assert.match(setup, /Type=oneshot/)
    assert.match(setup, /OnCalendar=\*-\*-\* 03:30:00/)
    assert.match(setup, /Persistent=true/)
    assert.match(setup, /systemctl enable --now "\$SERVICE-backup\.timer"/)
  })

  it('gera banco consistente, chave separada 0600 e projetos sem repositórios; não imprime a chave', () => {
    const data = makeData('ok')
    const r = run(data)
    assert.strictEqual(r.status, 0, r.stderr)
    assert.ok(!(r.stdout + r.stderr).includes(KEY), 'a chave vazou no log')

    const dest = join(data, 'backups')
    assert.strictEqual(statSync(dest).mode & 0o777, 0o700)
    assert.strictEqual(statSync(join(dest, 'keys')).mode & 0o777, 0o700)
    const files = readdirSync(dest)
    const dbFile = files.find((f) => /^gateway-\d{8}-\d{6}\.db$/.test(f))!
    const tarFile = files.find((f) => /^projects-\d{8}-\d{6}\.tar\.gz$/.test(f))!
    assert.ok(dbFile && tarFile)

    const copy = new DatabaseSync(join(dest, dbFile), { readOnly: true })
    assert.deepStrictEqual(
      copy
        .prepare('SELECT v FROM t ORDER BY v')
        .all()
        .map((x) => x.v),
      ['dois', 'um'],
    )
    copy.close()

    const keyFile = join(dest, 'keys', dbFile.replace('.db', '.key'))
    assert.strictEqual(readFileSync(keyFile, 'utf8'), KEY)
    assert.strictEqual(statSync(keyFile).mode & 0o777, 0o600)
    assert.strictEqual(statSync(join(dest, dbFile)).mode & 0o777, 0o600)

    const list = execFileSync('tar', ['-tzf', join(dest, tarFile)]).toString()
    assert.match(list, /projects\/p1\/docs\/nota\.md/)
    assert.doesNotMatch(list, /repositories|\.cache|\.tmp/)
  })

  it('usa SECRETS_KEY do ambiente quando não há secrets.key', () => {
    const data = makeData('env')
    rmSync(join(data, 'secrets.key'))
    const secret = 'a'.repeat(64)
    const r = run(data, { SECRETS_KEY: secret })
    assert.strictEqual(r.status, 0, r.stderr)
    assert.ok(!(r.stdout + r.stderr).includes(secret))
    const k = readdirSync(join(data, 'backups/keys'))[0]
    assert.strictEqual(readFileSync(join(data, 'backups/keys', k), 'utf8').trim(), `SECRETS_KEY=${secret}`)
  })

  it('sem chave nenhuma: erro e nenhum conjunto pela metade', () => {
    const data = makeData('nokey')
    rmSync(join(data, 'secrets.key'))
    const r = run(data)
    assert.notStrictEqual(r.status, 0)
    assert.deepStrictEqual(
      readdirSync(join(data, 'backups')).filter((f) => f !== 'keys'),
      [],
    )
  })

  it('retenção: 7 dias e 4 semanas; o resto sai (banco, projetos e chave juntos)', () => {
    const data = makeData('ret')
    const dest = join(data, 'backups')
    mkdirSync(join(dest, 'keys'), { recursive: true })
    // 60 dias antigos, um por dia, até 2026-09-01.
    const stamps: string[] = []
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 8, 1) - i * 864e5)
      stamps.push(d.toISOString().slice(0, 10).replace(/-/g, '') + '-033000')
    }
    for (const s of stamps) {
      writeFileSync(join(dest, `gateway-${s}.db`), 'x')
      writeFileSync(join(dest, `projects-${s}.tar.gz`), 'x')
      writeFileSync(join(dest, 'keys', `gateway-${s}.key`), 'x')
    }
    const r = run(data)
    assert.strictEqual(r.status, 0, r.stderr)
    const dbs = readdirSync(dest).filter((f) => f.endsWith('.db'))
    // O novo + até 6 dias antigos + as semanas que não tiveram dia guardado: poucos, nunca os 60.
    assert.ok(dbs.length >= 7 && dbs.length <= 11, `sobraram ${dbs.length}`)
    assert.ok(dbs.includes('gateway-20260901-033000.db'))
    assert.ok(!dbs.includes('gateway-20260701-033000.db'))
    // O que saiu levou a chave e os projetos junto; o que ficou tem os três.
    for (const s of stamps) {
      const has = [existsSync(join(dest, `gateway-${s}.db`)), existsSync(join(dest, `projects-${s}.tar.gz`)), existsSync(join(dest, 'keys', `gateway-${s}.key`))]
      assert.ok(has.every(Boolean) || has.every((x) => !x), `conjunto quebrado: ${s}`)
    }
  })

  it('sai com erro se o banco não existe', () => {
    const data = join(root, 'vazio')
    mkdirSync(data)
    const r = run(data)
    assert.notStrictEqual(r.status, 0)
    assert.match(r.stderr, /banco não encontrado/)
  })
})
