import { api } from '@/lib/api'

/**
 * 📱 O AVISO NO APARELHO (Web Push): registra o service worker, pede a permissão (só num toque da pessoa — o iPhone exige,
 * e só no app instalado na tela de início) e entrega a assinatura ao gateway.
 */
export type TPushState = 'unsupported' | 'install' | 'denied' | 'off' | 'on'

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

export async function pushState(): Promise<TPushState> {
  if (!supported()) return isIos() && !standalone() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const current = await (await registration()).pushManager.getSubscription()
  return current && Notification.permission === 'granted' ? 'on' : 'off'
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

/** Liga neste aparelho. Chamar só de um clique. */
export async function enablePush(): Promise<TPushState> {
  if (!supported()) return pushState()
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const { publicKey } = await api<{ publicKey: string }>('/push/key')
  const worker = await registration()
  await navigator.serviceWorker.ready
  let subscription = await worker.pushManager.getSubscription()
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  const json = subscription.toJSON()
  await api('/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } })
  return 'on'
}

/** Desliga neste aparelho. */
export async function disablePush(): Promise<TPushState> {
  if (!supported()) return pushState()
  const subscription = await (await registration()).pushManager.getSubscription()
  if (subscription) {
    await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } }).catch(() => undefined)
    await subscription.unsubscribe()
  }
  return 'off'
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true
  const mine = keyBytes(publicKey)
  const theirs = new Uint8Array(current)
  return mine.length === theirs.length && mine.every((byte, index) => byte === theirs[index])
}
