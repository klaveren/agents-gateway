import assert from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { startCommand } from './Background.Processes'
import { diagnoseEdit, makeEditDiagnostics, readEslint, readTsc, TDiagnosticRun } from './Edit.Diagnostics'
import { makeLocalTools } from './Local.Tools'

/** O diagnóstico depois de editar (ver `Edit.Diagnostics`), com binários falsos no `node_modules/.bin` do pacote. */
describe('Edit.Diagnostics', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'diag-')))
  after(() => rmSync(root, { recursive: true, force: true }))

  const lines: Array<{ line: string; cwd: string }> = []
  const run: TDiagnosticRun = async (line, cwd, timeoutMs) => {
    lines.push({ line, cwd })
    return startCommand(line, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, shell: '/bin/bash', timeoutMs }).done
  }
  const bin = (dir: string, name: string, script: string) => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.bin', name), `#!/bin/sh\n${script}\n`)
    chmodSync(join(dir, 'node_modules', '.bin', name), 0o755)
  }

  // O monorepo: o `tsc` e o `prettier` na raiz; o pacote `app` com o próprio eslint e o tsconfig.
  const app = join(root, 'app')
  mkdirSync(join(app, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(app, 'package.json'), '{}')
  writeFileSync(join(app, 'tsconfig.json'), '{}')
  writeFileSync(join(app, 'src', 'a.ts'), 'export const a: number = "x"\n')
  writeFileSync(join(app, 'README.md'), '# app\n')
  bin(root, 'tsc', `echo "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."; echo "src/b.ts(2,1): error TS2304: Cannot find name 'y'."; exit 2`)
  bin(root, 'prettier', 'echo "[warn] src/a.ts" >&2; exit 1')
  bin(
    app,
    'eslint',
    `echo "(node) aviso no stderr"; echo '[{"filePath":"a.ts","messages":[{"line":1,"column":14,"severity":2,"message":"no","ruleId":"no-x"},{"line":2,"column":1,"severity":1,"message":"meh","ruleId":null}]}]'; exit 1`,
  )

  it('roda o que o pacote tem, no pacote certo, e filtra a saída para o arquivo editado', async () => {
    lines.length = 0
    const text = await diagnoseEdit(join(app, 'src', 'a.ts'), root, { typecheck: true, lint: true, format: true }, run)
    assert.ok(text)
    assert.match(text, /depois da edição \(app\/src\/a\.ts\)/)
    assert.match(text, /- tsc: 1 erro neste arquivo; 1 em outros arquivos do projeto\n {2}1:14 TS2322: Type 'string'/)
    assert.ok(!text.includes("Cannot find name 'y'"), 'o erro de outro arquivo só é contado')
    assert.match(text, /- eslint: 1 erro, 1 aviso\n {2}1:14 error no \(no-x\)\n {2}2:1 warn meh/)
    assert.match(text, /- prettier: fora do padrão \(rode prettier --write src\/a\.ts\)/)
    // O eslint do próprio pacote; o tsc e o prettier vêm da raiz; todos rodam na pasta do pacote.
    assert.ok(lines.every((call) => call.cwd === app))
    assert.ok(lines.some((call) => call.line.startsWith(`'${join(app, 'node_modules/.bin/eslint')}'`)))
    assert.ok(lines.some((call) => call.line.startsWith(`'${join(root, 'node_modules/.bin/tsc')}' --noEmit --pretty false -p '${app}'`)))
  })

  it('só o que vale para a extensão; o que falta é dito, não baixado; fora da pasta não roda', async () => {
    assert.strictEqual(await diagnoseEdit(join(app, 'README.md'), root, { typecheck: true, lint: true }, run), undefined)
    const md = await diagnoseEdit(join(app, 'README.md'), root, { format: true }, run)
    assert.match(md!, /prettier: fora do padrão/)
    assert.ok(!md!.includes('tsc'))

    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'diag-bare-')))
    writeFileSync(join(bare, 'x.ts'), '')
    const missing = await diagnoseEdit(join(bare, 'x.ts'), bare, { typecheck: true, lint: true }, run)
    assert.match(missing!, /fora do node_modules\/\.bin do pacote: tsc \(sem tsconfig\.json\), eslint/)
    assert.strictEqual(await diagnoseEdit(join(bare, 'x.ts'), root, { typecheck: true }, run), undefined)
    rmSync(bare, { recursive: true, force: true })
  })

  it('a leitura das saídas: tsc limpo, configuração quebrada, eslint ignorado ou sem JSON', () => {
    assert.strictEqual(readTsc({ code: 0, output: '', timedOut: false }, '/x/a.ts', '/x'), 'ok')
    assert.strictEqual(readTsc({ code: 2, output: 'b.ts(1,1): error TS1: z', timedOut: false }, '/x/a.ts', '/x'), 'ok neste arquivo; 1 em outros arquivos do projeto')
    assert.match(readTsc({ code: 1, output: "error TS5058: The specified path does not exist: 'x'.", timedOut: false }, '/x/a.ts', '/x'), /falhou \(código 1\)\n {2}error TS5058/)
    assert.strictEqual(readTsc({ code: null, output: '', timedOut: true }, '/x/a.ts', '/x'), 'tempo esgotado')
    assert.strictEqual(
      readEslint({ code: 0, output: '[{"messages":[{"message":"File ignored because of a matching ignore pattern.","severity":1}]}]', timedOut: false }),
      'arquivo ignorado pela configuração',
    )
    assert.strictEqual(readEslint({ code: 0, output: '[{"messages":[]}]', timedOut: false }), 'ok')
    assert.match(readEslint({ code: 2, output: 'Oops! Something went wrong!', timedOut: false }), /falhou \(código 2\)\n {2}Oops/)
  })

  it('desligado não roda; sem cerco no servidor, diz que não roda', async () => {
    const diagnostics = makeEditDiagnostics()
    assert.strictEqual(await diagnostics.after(join(app, 'src', 'a.ts'), root, undefined, undefined), undefined)
    assert.strictEqual(await diagnostics.after(join(app, 'src', 'a.ts'), root, { typecheck: false }, undefined), undefined)
    assert.match((await diagnostics.after(join(app, 'src', 'a.ts'), root, { typecheck: true }, undefined))!, /não monta o cerco/)
  })

  it('o write_file e o edit_file que deram certo trazem o diagnóstico do agente; o que falhou e o de outro agente, não', async () => {
    const asked: Array<{ file: string; agent?: string }> = []
    const tools = makeLocalTools({
      diagnostics: {
        async after(file, _root, settings, context) {
          if (!settings?.lint) return undefined
          asked.push({ file, ...(context?.agentId ? { agent: context.agentId } : {}) })
          return 'Diagnóstico: eslint ok'
        },
      },
      agentDiagnostics: (agentId) => (agentId === 'dev' ? { lint: true } : undefined),
    })
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
    const context = { agentId: 'dev', workFolder: { dir: app, projectDir: root } } as Parameters<(typeof tools)[number]['execute']>[1]

    const wrote = await tool('write_file').execute({ path: 'src/b.ts', content: 'export {}\n' }, context)
    assert.strictEqual(wrote.status, 'success')
    assert.match(wrote.result, /^Wrote 10 bytes to src\/b\.ts\n\nDiagnóstico: eslint ok$/)
    const edited = await tool('edit_file').execute({ path: 'src/b.ts', old_string: 'export {}', new_string: 'export const b = 1' }, context)
    assert.match(edited.result, /Diagnóstico: eslint ok$/)
    assert.deepStrictEqual(asked, [
      { file: join(app, 'src/b.ts'), agent: 'dev' },
      { file: join(app, 'src/b.ts'), agent: 'dev' },
    ])

    const failed = await tool('edit_file').execute({ path: 'src/b.ts', old_string: 'nao existe', new_string: 'x' }, context)
    assert.strictEqual(failed.status, 'error')
    assert.ok(!failed.result.includes('Diagnóstico'))
    const other = await tool('write_file').execute({ path: 'src/c.ts', content: '' }, { ...context!, agentId: 'outro' })
    assert.ok(!other.result.includes('Diagnóstico'))
    assert.strictEqual(asked.length, 2)
  })
})
