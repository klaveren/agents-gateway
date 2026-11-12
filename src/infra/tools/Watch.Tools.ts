import type { WatchService } from '@application/Watch.Service'
import type { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import {
  IWatchCheck,
  WAKE_ME_TOOL,
  WATCH_LIMITS,
  WATCH_LIST_TOOL,
  WATCH_START_TOOL,
  WATCH_STOP_TOOL,
  wakeInput,
  watchLine,
  watchSpan,
  watchStartInput,
} from '@domain/models/Watch.Model'
import { ILocalTool, IToolResult } from './Tool.Types'

/** O terminal do agente, como o `run_bash` o roda (cerca, regras `terminal`, segredos, máscara), no limite da conferência. */
export type TWatchBash = (command: string, context: IExecutionContext) => Promise<IToolResult>

/**
 * O BALCÃO das vigias: liga, depois de montados, o serviço (que as ferramentas chamam) e o terminal (que a conferência
 * usa). ⚖️ Ligação tardia, como o `DelegationSlot`: as ferramentas nascem antes do serviço e o serviço confere pelo
 * terminal que nasce com elas.
 */
export class WatchDesk {
  private service?: WatchService
  private bash?: TWatchBash

  /** `resolve` monta o serviço na primeira chamada de uma ferramenta (a composição); o teste liga com `bind`. */
  constructor(private readonly resolve?: () => WatchService) {}

  bind(service: WatchService): void {
    this.service = service
  }

  get(): WatchService | undefined {
    this.service ??= this.resolve?.()
    return this.service
  }

  useBash(bash: TWatchBash): void {
    this.bash = bash
  }

  /** Uma conferência: o comando no terminal do agente, lido como aconteceu / ainda não / não rodou. */
  async check(command: string, context: IExecutionContext): Promise<IWatchCheck> {
    if (!this.bash) return { verdict: 'refused', output: 'Este gateway não tem como conferir comandos: use wake_me.' }
    return watchVerdict(await this.bash(command, context))
  }
}

/**
 * O que a saída do terminal diz da conferência. ⚖️ Saiu com 0 = aconteceu; saiu com outro código = ainda não; 126 e 127
 * (não executável, comando inexistente) e qualquer recusa = a conferência não roda, e esperar não conserta.
 */
export function watchVerdict(outcome: IToolResult): IWatchCheck {
  if (outcome.status === 'success') return { verdict: 'met', output: outcome.result }
  const exit = /(?:^|\n)Exit code (\d+):/.exec(outcome.result)
  if (exit) return { verdict: exit[1] === '126' || exit[1] === '127' ? 'refused' : 'unmet', output: outcome.result }
  if (outcome.result.includes('Tempo esgotado')) return { verdict: 'timeout', output: outcome.result }
  return { verdict: 'refused', output: outcome.result }
}

const OUTSIDE = 'A vigia só funciona dentro de uma conversa.'
const OFF = 'As vigias não estão ligadas neste gateway.'

const error = (result: string): IToolResult => ({ status: 'error', result })
const success = (result: string): IToolResult => ({ status: 'success', result })

/** As ferramentas de vigia (ver `Watch.Model`). */
export function makeWatchTools(desk: WatchDesk, now: () => Date = () => new Date()): ILocalTool[] {
  return [
    {
      origin: 'local',
      name: WATCH_START_TOOL,
      description:
        'Arms a watch on this conversation: the gateway runs `command` every `everySeconds` (no tokens are spent while waiting) and, when it exits 0, wakes this conversation with a notice so you continue from where you stopped. Use it whenever you would tell the person "I will let you know when…" about something that outlasts the turn: a server coming back, a rollout finishing, a file appearing. The command runs once right away: if it already exits 0, nothing is armed and you proceed now. The watch also fires when the deadline passes without the condition. The command must be quick (30 s limit) and only check, never change anything. It runs exactly like run_bash (same folder, same access rules): what run_bash cannot see or run reads as "not yet" until the deadline, so when unsure try the command with run_bash first.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'What is being waited for, in a few words, in the language of the person (shown on screen)' },
          command: { type: 'string', description: 'Bash command that checks the condition: exit 0 = it happened, any other exit = not yet' },
          everySeconds: { type: 'number', description: `Seconds between checks (minimum ${WATCH_LIMITS.minEverySeconds}, default ${WATCH_LIMITS.defaultEverySeconds})` },
          deadlineMinutes: { type: 'number', description: `Give up after this many minutes (default ${WATCH_LIMITS.defaultDeadlineMinutes}, maximum 7 days)` },
          then: { type: 'string', description: 'Note to yourself: what you will do when it happens. It comes back to you in the notice' },
        },
        required: ['label', 'command', 'then'],
        additionalProperties: false,
      },
      async execute(args, context): Promise<IToolResult> {
        const service = desk.get()
        if (!service) return error(OFF)
        if (!context?.sessionId) return error(OUTSIDE)
        const input = watchStartInput(args)
        if ('issues' in input) return error(`Corrija e chame de novo:\n- ${input.issues.join('\n- ')}`)
        const armed = await service.startCommand(context.sessionId, input.value)
        if ('refused' in armed) return error(armed.refused)
        if ('already' in armed)
          return success(
            `Já aconteceu: a conferência passou agora, nenhuma vigia foi armada. Siga com o que ia fazer.${armed.already ? `\nSaída da conferência:\n${armed.already}` : ''}`,
          )
        const { watch } = armed
        return success(
          [
            `Vigia armada (${watch.id}): "${watch.label}". A conferência rodou agora e ainda não passou.`,
            `O gateway confere a cada ${watch.everySeconds} s, por até ${watchSpan(watch.deadlineAt.getTime() - watch.createdAt.getTime())}.`,
            'Quando acontecer (ou o prazo passar), esta conversa recebe um aviso e você continua. Pode encerrar o turno dizendo à pessoa o que está sendo vigiado.',
          ].join('\n'),
        )
      },
    },
    {
      origin: 'local',
      name: WAKE_ME_TOOL,
      description:
        'Wakes this conversation after `afterMinutes`, with a notice, so you check something no shell command can see (a ticket, a job behind another tool) and continue. No tokens are spent while waiting. If it has not happened yet when you wake, call wake_me again. When a shell command can check the condition, prefer watch_start.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'What is being waited for, in a few words, in the language of the person (shown on screen)' },
          afterMinutes: { type: 'number', description: `Minutes from now (minimum ${WATCH_LIMITS.minWakeMinutes}, maximum 7 days)` },
          then: { type: 'string', description: 'Note to yourself: what you will check and do when you wake. It comes back to you in the notice' },
        },
        required: ['label', 'afterMinutes', 'then'],
        additionalProperties: false,
      },
      async execute(args, context): Promise<IToolResult> {
        const service = desk.get()
        if (!service) return error(OFF)
        if (!context?.sessionId) return error(OUTSIDE)
        const input = wakeInput(args)
        if ('issues' in input) return error(`Corrija e chame de novo:\n- ${input.issues.join('\n- ')}`)
        const armed = await service.wake(context.sessionId, input.value)
        if ('refused' in armed) return error(armed.refused)
        const { watch } = armed
        return success(
          `Despertador armado (${watch.id}): "${watch.label}", daqui a ${watchSpan(watch.deadlineAt.getTime() - watch.createdAt.getTime())}. Esta conversa recebe um aviso na hora e você continua. Pode encerrar o turno dizendo à pessoa o que está sendo esperado.`,
        )
      },
    },
    {
      origin: 'local',
      name: WATCH_LIST_TOOL,
      description: 'Lists the watches of this conversation (armed, fired, expired, cancelled) with the state of each.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute(_args, context): Promise<IToolResult> {
        const service = desk.get()
        if (!service) return error(OFF)
        if (!context?.sessionId) return error(OUTSIDE)
        const watches = service.list(context.sessionId)
        if (!watches.length) return success('Nenhuma vigia nesta conversa.')
        const at = now()
        return success(watches.map((watch) => watchLine(watch, at)).join('\n'))
      },
    },
    {
      origin: 'local',
      name: WATCH_STOP_TOOL,
      description: 'Cancels an armed watch of this conversation, by id (see watch_list). No notice is sent for a cancelled watch.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The watch id (w-…)' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, context): Promise<IToolResult> {
        const service = desk.get()
        if (!service) return error(OFF)
        if (!context?.sessionId) return error(OUTSIDE)
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        const stopped = service.stop(context.sessionId, id)
        return stopped ? success(`Vigia cancelada: "${stopped.label}".`) : error(`Não há vigia ativa com o id "${id}" nesta conversa. Veja as que existem com watch_list.`)
      },
    },
  ]
}
