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

createApp(App).use(createPinia()).use(router).mount('#app')
