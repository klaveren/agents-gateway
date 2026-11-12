<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import ListPager from '@/components/ListPager.vue'
import { usePaged } from '@/composables/usePaged'
import { ApiError } from '@/lib/api'
import type { IPackageHit, TPackageSource } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { usePackagesStore } from '@/stores/packages'

/**
 * A guia Pacotes: ferramentas do servidor (git, curl, jq…) do conda-forge, instaladas pelo micromamba numa
 * pasta persistente que está no PATH do gateway — o Bash dos agentes, o run_bash e os MCPs locais as veem.
 * A segunda fonte é o registro npm (mongosh, @scope/cli…): versão exata, sem scripts de instalação.
 */
const auth = useAuthStore()
const packages = usePackagesStore()

const loadError = ref<string>()
const source = ref<TPackageSource>('conda')
const query = ref('')
const hits = ref<IPackageHit[]>([])
const hitPage = usePaged(hits)
const searching = ref(false)
const searchError = ref<string>()
/** O pacote em instalação ou remoção agora (o servidor faz uma operação por vez). */
const working = ref<string>()
const result = ref<{ name: string; action: 'install' | 'remove'; ok: boolean; log: string }>()
const removing = ref<string>()
const showDeps = ref(false)
/** npm: o pacote cujo campo de versão está aberto, e a versão digitada. */
const installing = ref<string>()
const versionDraft = ref('')
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const versionValid = computed(() => NPM_VERSION.test(versionDraft.value.trim()))

onMounted(async () => {
  if (auth.isAdmin) await packages.ensure().catch((error) => (loadError.value = describe(error)))
})

const installed = computed(() => packages.state?.packages ?? [])
const requested = computed(() => installed.value.filter((entry) => entry.explicit))
const dependencies = computed(() => installed.value.filter((entry) => !entry.explicit))
const npmInstalled = computed(() => packages.state?.npm?.packages ?? [])
const requestedPage = usePaged(requested, { by: (item) => item.name })
const npmPage = usePaged(npmInstalled, { by: (item) => item.name })
const versionOf = (name: string) => (source.value === 'npm' ? npmInstalled.value : installed.value).find((entry) => entry.name === name)?.version

function describe(error: unknown): string {
  if (error instanceof ApiError && error.code === 'package_busy') return 'Outra instalação está em andamento. Espere ela terminar.'
  return error instanceof Error ? error.message : String(error)
}

// Busca com debounce: o conda-forge é grande, e cada busca leva alguns segundos.
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
watch(source, () => {
  generation++
  searching.value = false
  query.value = ''
  hits.value = []
  installing.value = undefined
  result.value = undefined
  searchError.value = undefined
})
watch(query, (text) => {
  clearTimeout(timer)
  searchError.value = undefined
  generation++
  searching.value = false
  const term = text.trim().toLowerCase()
  if (term.length < 2) {
    hits.value = []
    return
  }
  timer = setTimeout(async () => {
    const mine = ++generation
    searching.value = true
    try {
      const found = await packages.search(term, source.value)
      if (mine === generation) hits.value = found
    } catch (error) {
      if (mine === generation) searchError.value = describe(error)
    } finally {
      if (mine === generation) searching.value = false
    }
  }, 500)
})

function openInstall(hit: IPackageHit) {
  installing.value = hit.name
  versionDraft.value = hit.version
  result.value = undefined
}

async function act(name: string, action: 'install' | 'remove', version?: string) {
  working.value = name
  result.value = undefined
  try {
    const npm = source.value === 'npm'
    const outcome = npm
      ? action === 'install'
        ? await packages.installNpm(name, version ?? '')
        : await packages.removeNpm(name)
      : action === 'install'
        ? await packages.install(name)
        : await packages.remove(name)
    result.value = { name, action, ...outcome }
  } catch (error) {
    result.value = { name, action, ok: false, log: describe(error) }
  } finally {
    working.value = undefined
  }
}

async function confirmInstall(name: string) {
  if (!versionValid.value) return
  const version = versionDraft.value.trim()
  installing.value = undefined
  await act(name, 'install', version)
}

async function confirmRemove() {
  const name = removing.value
  removing.value = undefined
  if (name) await act(name, 'remove')
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra instala pacotes no servidor.</p>
  </div>

  <div v-else class="h-full overflow-y-auto">
    <section class="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
      <header class="flex items-center gap-2">
        <h1 class="text-xl font-semibold">Pacotes</h1>
      </header>
      <p class="text-xs text-zinc-500">
        Instale ferramentas no servidor (git, curl, jq, ffmpeg…). Ficam disponíveis na hora para os agentes e os MCPs locais.
      </p>
      <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

      <div v-if="packages.state" role="tablist" aria-label="Fonte dos pacotes" class="inline-flex self-start rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-sm">
        <button
          v-for="option in [{ id: 'conda', label: 'conda-forge' }, { id: 'npm', label: 'npm' }] as const"
          :key="option.id"
          type="button"
          role="tab"
          :aria-selected="source === option.id"
          :data-source="option.id"
          class="rounded-md px-3 py-1 transition-colors"
          :class="source === option.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
          @click="source = option.id"
        >
          {{ option.label }}
        </button>
      </div>

      <div v-if="packages.state && source === 'conda' && !packages.state.available" class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        O gerenciador de pacotes (micromamba) não está instalado neste servidor. Instale-o (no Mac: <code>brew install micromamba</code>) e reinicie.
      </div>
      <div v-else-if="packages.state && source === 'npm' && !packages.state.npm?.available" data-test="npm-missing" class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        O npm não está instalado neste servidor. Instale o Node.js (no Mac: <code>brew install node</code>) e reinicie.
      </div>

      <template v-else-if="packages.state">
        <p v-if="source === 'npm'" class="text-xs text-zinc-500">
          Do registro npm. A versão é exata e os scripts de instalação não rodam; se o pacote precisar deles, a instalação avisa.
        </p>
        <label class="flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 focus-within:border-emerald-500/60">
          <Icon name="search" class="h-4 w-4 shrink-0 text-zinc-500" />
          <input v-model="query" class="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none" :placeholder="source === 'npm' ? 'Buscar pacote npm: mongosh, @scope/cli…' : 'Buscar pacote: git, curl, jq, ffmpeg…'" autocomplete="off" spellcheck="false" />
          <span v-if="searching" class="text-xs text-zinc-500">buscando…</span>
        </label>
        <p v-if="searchError" class="text-sm text-rose-300">{{ searchError }}</p>

        <ul v-if="hits.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
          <li v-for="hit in hitPage.items.value" :key="hit.name" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-[13px] text-zinc-200">{{ hit.name }}</div>
              <div class="text-xs text-zinc-500">{{ hit.version }}<template v-if="hit.license"> · {{ hit.license }}</template></div>
            </div>
            <span v-if="versionOf(hit.name)" class="text-xs text-emerald-300">instalado {{ versionOf(hit.name) }}</span>
            <button v-else-if="source === 'npm'" type="button" :disabled="!!working" class="btn btn-sm btn-primary" @click="openInstall(hit)">
              {{ working === hit.name ? 'Instalando…' : 'Instalar' }}
            </button>
            <button v-else type="button" :disabled="!!working" class="btn btn-sm btn-primary" @click="act(hit.name, 'install')">
              {{ working === hit.name ? 'Instalando…' : 'Instalar' }}
            </button>
            <form v-if="source === 'npm' && installing === hit.name" data-test="npm-install" class="flex basis-full flex-col gap-1" @submit.prevent="confirmInstall(hit.name)">
              <div class="flex items-center gap-2">
                <label class="text-xs text-zinc-400" :for="`npm-version-${hit.name}`">Versão</label>
                <input
                  :id="`npm-version-${hit.name}`"
                  v-model="versionDraft"
                  data-test="npm-version"
                  class="h-8 w-40 rounded-lg border bg-zinc-950 px-2 font-mono text-[13px] text-zinc-100 outline-none"
                  :class="versionValid ? 'border-zinc-800 focus:border-emerald-500/60' : 'border-rose-500/60'"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button type="submit" data-test="npm-confirm" :disabled="!versionValid || !!working" class="btn btn-sm btn-primary">Confirmar</button>
                <button type="button" class="btn btn-sm" @click="installing = undefined">Cancelar</button>
              </div>
              <p class="text-xs" :class="versionValid ? 'text-zinc-500' : 'text-rose-300'">Versão exata, como 2.14.1 (ou 2.14.1-beta.1). Sem ^, ~ nem “latest”.</p>
            </form>
          </li>
        </ul>
        <p v-else-if="query.trim().length >= 2 && !searching && !searchError" class="text-xs text-zinc-500">Nenhum pacote com esse nome.</p>
        <ListPager v-model="hitPage.page.value" :pages="hitPage.pages.value" :total="hitPage.total.value" :size="hitPage.size" />

        <div v-if="result" class="flex flex-col gap-2">
          <p class="text-sm" :class="result.ok ? 'text-emerald-300' : 'text-rose-300'">
            {{ result.ok ? `✓ ${result.name} ${result.action === 'install' ? 'instalado' : 'removido'}.` : `✕ Não deu para ${result.action === 'install' ? 'instalar' : 'remover'} ${result.name}.` }}
          </p>
          <pre v-if="!result.ok && result.log" class="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 text-[11px] whitespace-pre-wrap text-zinc-400">{{ result.log }}</pre>
        </div>

        <div v-if="source === 'npm'" data-test="npm-installed" class="border-t border-zinc-800/80 pt-4">
          <h2 class="mb-2 text-sm font-medium text-zinc-200">Instalados (npm) <span class="text-xs font-normal text-zinc-500">{{ npmInstalled.length }}</span></h2>
          <ul v-if="npmInstalled.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            <li v-for="entry in npmPage.items.value" :key="entry.name" class="flex items-center gap-3 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-[13px] text-zinc-200">{{ entry.name }}</div>
                <div class="text-xs text-zinc-500">{{ entry.version }}</div>
              </div>
              <button type="button" :disabled="!!working" class="btn btn-sm btn-danger" @click="removing = entry.name">
                {{ working === entry.name ? 'Removendo…' : 'Desinstalar' }}
              </button>
            </li>
          </ul>
          <p v-else class="text-xs text-zinc-500">Nenhum pacote npm ainda — busque acima.</p>
          <ListPager v-model="npmPage.page.value" :pages="npmPage.pages.value" :total="npmPage.total.value" :size="npmPage.size" />
        </div>

        <div v-else class="border-t border-zinc-800/80 pt-4">
          <h2 class="mb-2 text-sm font-medium text-zinc-200">Instalados <span class="text-xs font-normal text-zinc-500">{{ requested.length }}</span></h2>
          <ul v-if="requested.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            <li v-for="entry in requestedPage.items.value" :key="entry.name" class="flex items-center gap-3 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-[13px] text-zinc-200">{{ entry.name }}</div>
                <div class="text-xs text-zinc-500">{{ entry.version }}</div>
              </div>
              <button type="button" :disabled="!!working" class="btn btn-sm btn-danger" @click="removing = entry.name">
                {{ working === entry.name ? 'Removendo…' : 'Desinstalar' }}
              </button>
            </li>
          </ul>
          <p v-else class="text-xs text-zinc-500">Nenhum pacote ainda — busque acima.</p>
          <ListPager v-model="requestedPage.page.value" :pages="requestedPage.pages.value" :total="requestedPage.total.value" :size="requestedPage.size" />
          <button v-if="dependencies.length" type="button" class="mt-2 text-xs text-zinc-500 hover:text-zinc-300" @click="showDeps = !showDeps">
            {{ showDeps ? 'esconder' : 'mostrar' }} {{ dependencies.length }} dependência(s)
          </button>
          <p v-if="showDeps" class="mt-1 font-mono text-[11px] leading-relaxed text-zinc-500">
            <span v-for="entry in dependencies" :key="entry.name" class="mr-3 inline-block">{{ entry.name }} {{ entry.version }}</span>
          </p>
        </div>
      </template>
    </section>

    <ConfirmDialog
      :open="!!removing"
      :title="`Desinstalar ${removing ?? ''}?`"
      message="Agentes e MCPs que dependem dele deixam de funcionar."
      action="Desinstalar"
      @confirm="confirmRemove"
      @cancel="removing = undefined"
    />
  </div>
</template>
