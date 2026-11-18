import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './style.css'

// ⚠️ Depois de um deploy, a página aberta pede os pedaços (telas, painéis) da build ANTIGA, que não existem mais: o
// clique não abre nada. Recarrega para a build nova — uma vez por minuto no máximo, para não entrar em laço.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'gateway:reloaded-for-build'
  try {
    if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    // Sem sessionStorage: recarrega mesmo assim.
  }
  event.preventDefault()
  window.location.reload()
})

/**
 * 📱 No app da tela de início do iPhone, a tela às vezes termina antes do fim físico (acima da barra de gestos): aí o
 * `env(safe-area-inset-bottom)` contaria duas vezes. Confere a altura de verdade e marca o `<html>` (ver `style.css`).
 */
function markShortViewport(): void {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  const portrait = window.innerHeight > window.innerWidth
  const short = standalone && portrait && window.screen.height - window.innerHeight > 1
  document.documentElement.toggleAttribute('data-short-viewport', short)
}
markShortViewport()
window.addEventListener('resize', markShortViewport)

createApp(App).use(createPinia()).use(router).mount('#app')
