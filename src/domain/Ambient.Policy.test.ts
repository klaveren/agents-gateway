import assert from 'node:assert'
import { describe, it } from 'node:test'
import { ambientSection, conversationNote, secretNamesOf, secretsChangedNote, waitLine } from './Ambient.Policy'

/** A linha de todo agente sem vigia: não promete avisar depois. */
const NO_WATCH = waitLine({})

describe('Ambient.Policy', () => {
  it('com o painel: um item por pedido, e as etapas do item no update_todos', () => {
    const section = ambientSection({ agentId: 'atlas', panel: true })
    assert.match(section, /\*\*Um item por pedido\.\*\*/)
    assert.match(section, /Nunca um item genérico/)
    assert.match(section, /As etapas do item vão no `update_todos`/)
  })

  it('sem projeto nem diretório: o agente e a pasta vazia da conversa', () => {
    assert.strictEqual(ambientSection({ agentId: 'atlas' }), `## Ambiente\n- Agente: atlas.\n- Diretório de trabalho: uma pasta vazia, só desta conversa.\n${NO_WATCH}`)
  })

  it('o agente do projeto: o projeto e a pasta dele', () => {
    assert.strictEqual(
      ambientSection({ agentId: 'dev', project: { id: 'alfa', name: 'Alfa', own: true }, directory: '/dados/projects/alfa' }),
      [
        '## Ambiente',
        '- Agente: dev.',
        '- Projeto: Alfa (projectId "alfa").',
        '- Diretório de trabalho: /dados/projects/alfa — persistente e compartilhado pelas conversas do projeto. Fora dele você não lê nem grava.',
        NO_WATCH,
      ].join('\n'),
    )
  })

  it('o global numa conversa do projeto: o que ele criar pertence ao projeto; sem nome, só o id', () => {
    assert.strictEqual(
      ambientSection({ agentId: 'atlas', project: { id: 'alfa', own: false } }),
      [
        '## Ambiente',
        '- Agente: atlas.',
        '- Projeto atual: projectId "alfa". Agentes, hooks e conversas que você criar aqui pertencem a este projeto.',
        '- Diretório de trabalho: uma pasta vazia, só desta conversa.',
        NO_WATCH,
      ].join('\n'),
    )
  })

  it('aberta numa worktree: o repositório, a worktree, o branch e a pasta dela', () => {
    const text = ambientSection({
      agentId: 'dev',
      project: { id: 'alfa', name: 'Alfa', own: false },
      repository: { name: 'gateway', worktree: 'wt-x', branch: 'feat/x' },
      directory: '/dados/projects/alfa/repositories/gateway/_wt/wt-x',
    })
    assert.match(text, /\n- Projeto: Alfa \(projectId "alfa"\)\.\n- Repositório: gateway, worktree wt-x \(branch feat\/x\)\.\n/)
    assert.match(text, /- Diretório de trabalho: \/dados\/projects\/alfa\/repositories\/gateway\/_wt\/wt-x\. Fora dele você não lê nem grava; o git dele funciona/)
  })

  it('⛔ worktree com o principal conhecido: a pasta de trabalho é a worktree, o principal é só leitura', () => {
    const text = ambientSection({
      agentId: 'vera',
      project: { id: 'alfa', own: false },
      repository: { name: 'logiccus', worktree: 'wt-x', main: '/dados/projects/alfa/repositories/logiccus' },
      directory: '/dados/projects/alfa/repositories/_wt/wt-x',
    })
    assert.match(text, /- Diretório de trabalho: \/dados\/projects\/alfa\/repositories\/_wt\/wt-x\. Fora dele você não grava;/)
    assert.match(
      text,
      /\n- Sua pasta de trabalho é `\/dados\/projects\/alfa\/repositories\/_wt\/wt-x` \(rode testes, builds e scripts lá\)\. O repositório principal `\/dados\/projects\/alfa\/repositories\/logiccus` é só leitura nesta conversa\.\n/,
    )
  })

  it('o id da conversa, numa linha marcada como do sistema', () => {
    assert.strictEqual(conversationNote('gw_01ABC'), '<contexto>id desta conversa: gw_01ABC</contexto>')
  })

  it('o agente com arquivos sabe onde eles estão (só leitura)', () => {
    const reading = ambientSection({ agentId: 'maya', files: { dir: '/dados/global/agents/maya', write: false } })
    assert.match(reading, /- Sua pasta: \/dados\/global\/agents\/maya — privada, sua: nenhum outro agente a vê\./)
    assert.match(reading, /só leitura para você: gravar pede Escrever arquivos/)
    assert.match(ambientSection({ agentId: 'maya', files: { dir: '/dados/global/agents/maya', write: true } }), /Leia e grave nela seus scripts, notas e dados de trabalho/)
    // O terminal: a linha da pasta temporária (o /tmp dele some a cada comando); sem terminal, nada.
    assert.match(
      ambientSection({ agentId: 'maya', terminal: true }),
      /use `\$TMPDIR` \(persiste entre os comandos do terminal\)\. O `\/tmp` do terminal é seu e some no fim do comando.*pasta tmp do projeto/,
    )
    assert.doesNotMatch(ambientSection({ agentId: 'maya' }), /TMPDIR/)
  })

  it('🔌 a porta do próprio gateway: o agente com terminal sabe que é negada, salvo a Configuração do admin; ligada, a linha some', () => {
    assert.match(ambientSection({ agentId: 'maya', terminal: true }), /portas do próprio gateway.*sempre negadas.*Agentes alcançam a API deste gateway/)
    assert.doesNotMatch(ambientSection({ agentId: 'maya', terminal: true, gatewayReach: true }), /portas do próprio gateway/)
    assert.doesNotMatch(ambientSection({ agentId: 'maya' }), /portas do próprio gateway/)
  })

  it('⛔ a promessa vazia: sem vigia, o agente não promete avisar; com vigia, espera no turno ou arma uma', () => {
    assert.match(NO_WATCH, /^- Você não volta sozinho a esta conversa: só fala quando recebe mensagem\. Não prometa avisar depois/)
    assert.match(NO_WATCH, /é preciso perguntar de novo\.$/)
    assert.doesNotMatch(NO_WATCH, /watch_start|wake_me/)

    const full = ambientSection({ agentId: 'argos', terminal: true, watch: true })
    assert.match(full, /se é curto \(até uns minutos\), espere DENTRO do turno e confira antes de responder/)
    assert.match(full, /arme uma vigia — `watch_start` \(um comando confere de tempos em tempos[^\n]+ou `wake_me`/)
    assert.match(full, /Só prometa "te aviso quando…" com a vigia armada/)

    // Sem o terminal não há vigia por comando: só o despertador.
    const alarm = waitLine({ watch: true })
    assert.match(alarm, /arme uma vigia — `wake_me` \(acorda esta conversa num horário/)
    assert.doesNotMatch(alarm, /watch_start/)
  })
})

describe('Ambient — agente de máquina', () => {
  it('🖥️ diz que a pasta é só o ponto de partida, o que segue fechado e que o sudo não roda', () => {
    const text = ambientSection({ agentId: 'zeus', project: { id: 'xpto', own: true }, directory: '/dados/projects/xpto', machine: true })
    assert.match(text, /ponto de partida/)
    assert.match(text, /AGENTE DE MÁQUINA/)
    assert.match(text, /sudo/)
    assert.doesNotMatch(text, /Fora dele você não lê nem grava/)
  })
})

describe('🔑 variáveis secretas que mudam no meio da conversa', () => {
  it('junta os nomes do agente, do projeto e das skills, sem repetir', () => {
    assert.deepStrictEqual(secretNamesOf({ agent: ['B'], project: ['A', 'B'], resources: [{ kind: 'skill', id: 's', names: ['C'] }] }), ['A', 'B', 'C'])
    assert.deepStrictEqual(secretNamesOf(undefined), [])
  })

  it('diz as novas e as removidas; sem mudança, nada', () => {
    const note = secretsChangedNote(['LOGICCUS_CD_CI'], ['E2E_PROVIDER_PASSWORD', 'LOGICCUS_CD_CI'])
    assert.match(note, /novas, já no ambiente dos seus comandos.*`E2E_PROVIDER_PASSWORD`/)
    assert.doesNotMatch(note, /removidas/)
    assert.match(secretsChangedNote(['A', 'B'], ['A']), /removidas: `B`/)
    assert.strictEqual(secretsChangedNote(['A'], ['A']), '')
  })

  it('conversa de antes do aviso: a lista inteira de agora, uma vez; sem nenhuma, nada', () => {
    assert.match(secretsChangedNote(undefined, ['A', 'B']), /agora .*`A`, `B`/)
    assert.strictEqual(secretsChangedNote(undefined, []), '')
  })
})
