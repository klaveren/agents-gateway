<script setup lang="ts">
  import { computed, nextTick, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { useResource } from '@/composables/useResource'
  import { ago, fullTime } from '@/lib/format'
  import { useAuthStore } from '@/stores/auth'
  import { type ILoginSession, useSessionsStore } from '@/stores/sessions'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * As sessões de login abertas da conta: o aparelho (resumido do navegador), o último uso e "Encerrar" em cada uma. A
   * desta tela não se encerra por aqui (é o "Sair" do menu da conta).
   */
  const auth = useAuthStore()
  const store = useSessionsStore()
  const userId = computed(() => auth.user?.id)
  const { data, error: listError } = useResource(store.lists, userId)
  const sessions = computed(() => data.value ?? [])
  const others = computed(() => sessions.value.filter((session) => !session.current))
  const actionError = ref<string>()
  const loadError = computed(
    () => actionError.value ?? (listError.value === undefined ? undefined : listError.value instanceof Error ? listError.value.message : String(listError.value)),
  )
  const ending = ref<ILoginSession>()
  const root = ref<HTMLElement>()

  // Vindo do menu da conta (`/profile#sessions`): a lista aparece na tela, e não lá embaixo do perfil.
  const route = useRoute()
  watch(
    () => route.hash,
    async (hash) => {
      if (hash !== '#sessions') return
      await nextTick()
      root.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
    { immediate: true },
  )
  const endingOthers = ref(false)

  async function run(work: () => Promise<void>) {
    actionError.value = undefined
    await work().catch((error: unknown) => (actionError.value = error instanceof Error ? error.message : String(error)))
  }

  async function end() {
    const target = ending.value
    ending.value = undefined
    if (target && userId.value) await run(() => store.end(userId.value!, target.id))
  }

  async function endOthers() {
    endingOthers.value = false
    if (userId.value) await run(() => store.endOthers(userId.value!))
  }
</script>

<template>
  <section id="sessions" ref="root" class="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5" data-test="open-sessions">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-medium">Sessões abertas</h2>
      <button v-if="others.length" class="btn btn-sm btn-danger" data-test="end-other-sessions" @click="endingOthers = true">Encerrar as outras</button>
    </div>
    <p class="text-xs text-zinc-400">Onde a sua conta está conectada. Encerre a de um aparelho que você não usa mais ou não reconhece.</p>
    <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

    <ul v-if="sessions.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="session in sessions" :key="session.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-test="session-row">
        <div class="min-w-0 flex-1 basis-48">
          <div class="flex items-center gap-2">
            <span class="truncate text-sm font-medium">{{ session.device }}</span>
            <span v-if="session.current" class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[10px] text-emerald-200">esta</span>
          </div>
          <div class="text-xs text-zinc-500" :title="`Entrou ${fullTime(session.createdAt)} · vale até ${fullTime(session.expiresAt)}`">
            {{ session.current ? 'em uso agora' : `usada ${ago(session.lastUsedAt)}` }} ·
            {{ session.keepSignedIn ? 'mantida conectada' : `vale até ${fullTime(session.expiresAt)}` }}
          </div>
        </div>
        <button v-if="!session.current" class="btn btn-sm btn-secondary" data-test="end-session" @click="ending = session">Encerrar</button>
      </li>
    </ul>
    <p v-else-if="data" class="text-xs text-zinc-500">Nenhuma sessão listada.</p>

    <ConfirmDialog
      :open="!!ending"
      :title="`Encerrar a sessão ${ending?.device ?? ''}?`"
      message="Aquele aparelho precisa entrar de novo. O que já está rodando lá termina o que estava fazendo."
      action="Encerrar"
      @confirm="end"
      @cancel="ending = undefined"
    />
    <ConfirmDialog
      :open="endingOthers"
      title="Encerrar as outras sessões?"
      message="Todos os outros aparelhos e navegadores precisam entrar de novo. Esta tela continua conectada."
      action="Encerrar as outras"
      @confirm="endOthers"
      @cancel="endingOthers = false"
    />
  </section>
</template>
