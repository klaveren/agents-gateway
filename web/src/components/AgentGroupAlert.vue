<script setup lang="ts">
  import { ref, watch } from 'vue'
  import { api } from '@/lib/api'

  /**
   * ⚠️ "NÃO CONFIGURADO NESTA MÁQUINA": o grupo de modelos que o agente pede não existe aqui (nem no projeto, nem no gateway).
   * Acontece no projeto CONECTADO, onde da origem vem só o nome do grupo. A leitura é a da tela de grupos do projeto (quem
   * administra o projeto); quem não lê, não vê o alerta.
   */
  const props = defineProps<{ projectId: string; group: string }>()

  const missing = ref(false)
  watch(
    () => [props.projectId, props.group],
    async () => {
      missing.value = false
      try {
        const view = await api<{ missing?: Array<{ id: string }> }>(`/projects/${encodeURIComponent(props.projectId)}/model-groups`)
        missing.value = !!view.missing?.some((item) => item.id === props.group)
      } catch {
        missing.value = false
      }
    },
    { immediate: true },
  )
</script>

<template>
  <div v-if="missing" class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" role="alert" data-test="agent-group-missing">
    <p class="font-medium">
      Grupo
      <code>{{ group }}</code>
      não configurado nesta máquina
    </p>
    <p class="text-xs text-amber-200/80">
      Até configurar, valem o grupo padrão e, depois, o modelo padrão; sem nenhum, a conversa não abre. Configure em Projeto → Configurações → Modelos.
    </p>
  </div>
</template>
