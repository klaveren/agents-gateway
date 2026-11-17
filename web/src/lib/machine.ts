import { ref } from 'vue'

/**
 * 🖥️ "Permitir agentes de máquina" vale nesta instalação? Vem do `/auth/status` (para quem não lê as Configurações, como o
 * admin de projeto) e muda na hora quando o admin do gateway liga ou desliga na tela.
 */
export const machineAgentsOn = ref(false)
