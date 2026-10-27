<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import { api, ApiError } from '@/lib/api'
import { docSlug, GLOBAL_SCOPE, scopeLabel, scopeToProjectId } from '@/lib/guidance'
import { renderMarkdown } from '@/lib/markdown'
import type { IProjectDoc, TDocKind } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * SPECS ou ADRs (só admin), uma página para cada (`kind`): documentos em markdown que os agentes consultam.
 * ⚖️ A conversa recebe só o índice (id, título, resumo) — os globais e os do projeto dela — e o agente lê o
 * documento inteiro com `read_doc` quando precisa. O status de uma ADR fica no próprio texto.
 */
const props = defineProps<{ kind: TDocKind; id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()

/** O que é cada tipo, para quem cadastra: a página explica antes de pedir o texto. */
const KIND: Record<TDocKind, { title: string; one: string; base: string; short: string; lead: string; when: string[]; example: string; placeholder: string }> = {
  spec: {
    title: 'Specs',
    one: 'spec',
    base: '/specs',
    short: 'Como algo deve ser: o que o agente segue. Globais e do projeto da conversa.',
    lead: 'Uma spec diz COMO algo deve ser: requisitos, formatos, contratos e critérios de aceite. É o que o agente segue quando constrói ou responde.',
    when: ['Formato de um arquivo, relatório ou resposta', 'Contrato de uma API ou de uma integração', 'Critérios para dar uma tarefa por pronta'],
    example: 'Ex.: "Nomes de arquivo — todo arquivo novo usa AAAA-MM-DD-assunto.md".',
    placeholder: 'Nomes de arquivo',
  },
  adr: {
    title: 'ADRs',
    one: 'ADR',
    base: '/adrs',
    short: 'Decisões tomadas e o porquê: o que o agente não desfaz. Globais e do projeto da conversa.',
    lead: 'Uma ADR (Architecture Decision Record) registra UMA decisão: o contexto, o que se decidiu, as alternativas e as consequências. É o que impede o agente de desfazer, sem saber, algo que foi escolhido de propósito.',
    when: ['Uma escolha de tecnologia ou de arquitetura', 'Um caminho descartado, e por quê', 'Uma decisão que troca outra (diga qual no texto)'],
    example: 'O status vai no próprio texto: Proposta, Aceita, Substituída por…',
    placeholder: 'Autenticação por sessão',
  },
}
const TEMPLATE: Record<TDocKind, string> = {
  spec: '# Objetivo\n\n# Requisitos\n- \n\n# Fora do escopo\n- ',
  adr: '**Status:** Proposta\n\n# Contexto\n\n# Decisão\n\n# Consequências\n- ',
}

const scope = ref<string>(projects.current ?? GLOBAL_SCOPE)
const list = ref<IProjectDoc[]>([])
const loadError = ref<string>()
const adding = computed(() => route.name === `${props.kind}-new`)
const info = computed(() => KIND[props.kind])

const form = ref({ id: '', kind: 'spec' as TDocKind, title: '', summary: '', body: '', global: true, project: '' })
const loaded = ref<IProjectDoc>()
const preview = ref(false)
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const note = ref<string>()
const busy = ref(false)
const removing = ref(false)

const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const shown = computed(() => list.value.filter((doc) => doc.kind === props.kind))
const formScope = computed(() => (form.value.global ? GLOBAL_SCOPE : form.value.project))
const dirty = computed(() => {
  const doc = loaded.value
  if (!doc) return true
  return (
    form.value.title !== doc.title ||
    form.value.summary !== doc.summary ||
    form.value.body !== (doc.body ?? '') ||
    formScope.value !== (doc.projectId ?? GLOBAL_SCOPE)
  )
})

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  await loadList()
})
watch(scope, () => void loadList())

watch(
  () => [props.id, adding.value, props.kind] as const,
  async ([id, isNew, kind]) => {
    issues.value = {}
    error.value = undefined
    note.value = undefined
    preview.value = false
    if (isNew) {
      loaded.value = undefined
      form.value = { id: '', kind, title: '', summary: '', body: TEMPLATE[kind], global: scope.value === GLOBAL_SCOPE, project: scope.value === GLOBAL_SCOPE ? (projects.current ?? '') : scope.value }
      return
    }
    if (!id) return
    try {
      const doc = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}`)
      // O endereço é da outra página (uma ADR aberta em /specs): vai para a certa.
      if (doc.kind !== kind) return void router.replace(`${KIND[doc.kind].base}/${doc.id}`)
      loaded.value = doc
      form.value = { id: doc.id, kind: doc.kind, title: doc.title, summary: doc.summary, body: doc.body ?? '', global: !doc.projectId, project: doc.projectId ?? projects.current ?? '' }
    } catch (failure) {
      loaded.value = undefined
      error.value = describe(failure)
    }
  },
  { immediate: true },
)

async function loadList() {
  loadError.value = undefined
  try {
    list.value = await api<IProjectDoc[]>('/docs', { query: { project: scope.value } })
  } catch (failure) {
    loadError.value = describe(failure)
  }
}

function slug() {
  if (!form.value.id && form.value.title) form.value.id = docSlug(form.value.title)
}

async function save() {
  issues.value = {}
  error.value = undefined
  note.value = undefined
  busy.value = true
  const body = { kind: form.value.kind, title: form.value.title, summary: form.value.summary, body: form.value.body, projectId: scopeToProjectId(formScope.value) }
  try {
    if (adding.value) {
      const created = await api<IProjectDoc>('/docs', { method: 'POST', body: { id: form.value.id, ...body } })
      scope.value = created.projectId ?? GLOBAL_SCOPE
      await loadList()
      await router.push(`${info.value.base}/${created.id}`)
    } else {
      loaded.value = await api<IProjectDoc>(`/docs/${encodeURIComponent(form.value.id)}`, { method: 'PUT', body })
      note.value = 'Documento salvo. Vale para as conversas que começarem agora.'
      await loadList()
    }
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

async function confirmRemove() {
  busy.value = true
  try {
    await api(`/docs/${encodeURIComponent(form.value.id)}`, { method: 'DELETE' })
    removing.value = false
    await loadList()
    await router.push(info.value.base)
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra cadastra {{ info.title }}.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" :back-to="info.base" :back-label="info.title" :title="adding ? `Nova ${info.one}` : loaded?.title">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">{{ info.title }}</h1>
        <RouterLink :to="`${info.base}/new`" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" :title="`Nova ${info.one}`"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-2 text-xs text-zinc-500">{{ info.short }}</p>
      <div class="px-4 pb-2">
        <select v-model="scope" class="input py-1.5 text-sm" aria-label="Escopo">
          <option v-for="item in scopes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </div>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-else-if="!shown.length" class="px-4 py-2 text-sm text-zinc-500">Nenhuma {{ info.one }} em {{ scopeLabel(scope, projects.list) }}.</p>
      <RouterLink v-for="doc in shown" :key="doc.id" :to="`${info.base}/${doc.id}`" class="mx-2 block rounded-xl px-3 py-2" :class="doc.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'">
        <span class="flex items-center gap-2">
          <span class="truncate text-sm font-medium">{{ doc.title }}</span>
          <span v-if="doc.loadedIn?.length" class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300" :title="`Vai inteira no prompt de: ${doc.loadedIn.map((id) => scopeLabel(id, projects.list)).join(', ')}`">
            carregada em {{ doc.loadedIn.map((id) => scopeLabel(id, projects.list)).join(', ') }}
          </span>
        </span>
        <span class="block truncate text-xs text-zinc-500">{{ doc.id }}<template v-if="doc.summary"> · {{ doc.summary }}</template></span>
      </RouterLink>
    </template>

    <template #detail>
      <form v-if="adding || loaded" class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="save">
        <h2 class="text-lg font-semibold">{{ adding ? `Nova ${info.one}` : loaded?.title }}</h2>
        <label class="field">Título<input v-model="form.title" required maxlength="160" class="input" :placeholder="info.placeholder" @blur="slug" /><small v-for="m in issues.title" :key="m" class="error">{{ m }}</small></label>
        <label class="field">
          Id
          <input v-model="form.id" :disabled="!adding" required pattern="[a-z0-9][a-z0-9-]{1,63}" class="input font-mono disabled:opacity-60" placeholder="autenticacao-por-sessao" />
          <small class="hint">É por ele que o agente pede o documento (<code>read_doc</code>). Não muda depois.</small>
          <small v-for="m in issues.id" :key="m" class="error">{{ m }}</small>
        </label>
        <label class="field">
          Resumo
          <input v-model="form.summary" maxlength="300" class="input" placeholder="Uma linha: o que o documento cobre" />
          <small class="hint">Vai no índice de cada conversa: é o que faz o agente saber quando ler.</small>
          <small v-for="m in issues.summary" :key="m" class="error">{{ m }}</small>
        </label>
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <label class="flex items-center gap-2"><input v-model="form.global" type="checkbox" class="accent-emerald-500" /> Global (todos os projetos)</label>
          <select v-if="!form.global" v-model="form.project" required class="input w-auto py-1.5 text-sm" aria-label="Projeto">
            <option v-for="project in projects.list" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
          <small v-for="m in issues.projectId" :key="m" class="error">{{ m }}</small>
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex gap-1 text-xs">
            <button type="button" class="rounded-full px-3 py-1" :class="!preview ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'" @click="preview = false">Markdown</button>
            <button type="button" class="rounded-full px-3 py-1" :class="preview ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'" @click="preview = true">Prévia</button>
          </div>
          <textarea v-if="!preview" v-model="form.body" required rows="18" class="input font-mono text-[13px] leading-relaxed" aria-label="Conteúdo em markdown" />
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-else class="prose-agent min-h-[18rem] rounded-xl border border-zinc-800 p-4 text-sm break-words" v-html="renderMarkdown(form.body)" />
          <small v-for="m in issues.body" :key="m" class="error">{{ m }}</small>
        </div>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <div class="flex gap-2">
          <button type="submit" :disabled="busy || !dirty" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{{ adding ? 'Criar' : 'Salvar' }}</button>
          <RouterLink v-if="adding" :to="info.base" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800">Cancelar</RouterLink>
          <button v-else type="button" class="ml-auto rounded-full px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/10" @click="removing = true">Apagar</button>
        </div>
      </form>
      <p v-else-if="error" class="mx-auto max-w-3xl text-sm text-rose-300">{{ error }}</p>
      <section v-else class="mx-auto flex max-w-2xl flex-col gap-3 text-sm text-zinc-300">
        <h2 class="text-lg font-semibold text-zinc-100">O que é uma {{ info.one }}</h2>
        <p>{{ info.lead }}</p>
        <div>
          <p class="mb-1 font-medium text-zinc-200">Quando escrever uma</p>
          <ul class="list-disc pl-5 text-zinc-400">
            <li v-for="item in info.when" :key="item">{{ item }}</li>
          </ul>
        </div>
        <p class="text-zinc-400">{{ info.example }}</p>
        <p class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
          Como o agente usa: cada conversa nova recebe o índice — id, título e resumo — das {{ info.title.toLowerCase() }} globais e das do projeto dela. Quando o assunto aparece, o agente lê a {{ info.one }} inteira com <code>read_doc</code>. Por isso o resumo importa: é ele que faz o agente saber quando ler.
        </p>
        <div><RouterLink :to="`${info.base}/new`" class="inline-block rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Nova {{ info.one }}</RouterLink></div>
      </section>
    </template>
  </MasterDetail>

  <ConfirmDialog
    :open="removing"
    :title="`Apagar a ${info.one}?`"
    :message="`${form.title} sai do índice das conversas novas.`"
    :busy="busy"
    @confirm="confirmRemove"
    @cancel="removing = false"
  />
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
.hint {
  @apply text-xs font-normal text-zinc-500;
}
.error {
  @apply text-xs font-normal text-rose-300;
}
</style>
