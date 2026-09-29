<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/app'
import { setTurnstileSolver } from '@/utils/cfsm'

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

const appStore = useAppStore()
const visible = ref(false)
const errorText = ref('')
const container = ref<HTMLElement | null>(null)

let scriptPromise: Promise<void> | null = null
let widgetId: string | null = null
let pending: { siteKey: string, resolve: (token: string) => void, reject: (error: Error) => void } | null = null

function loadScript(): Promise<void> {
  if (window.turnstile)
    return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        scriptPromise = null
        reject(new Error('无法加载 Cloudflare Turnstile'))
      }
      document.head.appendChild(script)
    })
  }
  return scriptPromise
}

function removeWidget(): void {
  if (widgetId && window.turnstile) {
    try {
      window.turnstile.remove(widgetId)
    }
    catch {}
  }
  widgetId = null
}

async function renderWidget(): Promise<void> {
  if (!pending)
    return
  errorText.value = ''
  try {
    await loadScript()
    await nextTick()
    if (!container.value || !window.turnstile || !pending)
      return
    removeWidget()
    widgetId = window.turnstile.render(container.value, {
      'sitekey': pending.siteKey,
      'theme': appStore.isDark ? 'dark' : 'light',
      'language': 'zh-cn',
      'callback': (token: string) => {
        const current = pending
        pending = null
        visible.value = false
        removeWidget()
        current?.resolve(token)
      },
      'error-callback': () => {
        errorText.value = '验证未通过，请重试。'
      },
      'expired-callback': () => {
        errorText.value = '验证已过期，请重试。'
      },
    })
  }
  catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

setTurnstileSolver(siteKey => new Promise<string>((resolve, reject) => {
  pending?.reject(new Error('Turnstile verification replaced'))
  pending = { siteKey, resolve, reject }
  visible.value = true
  void renderWidget()
}))

onUnmounted(() => {
  removeWidget()
  pending?.reject(new Error('Turnstile verification cancelled'))
  pending = null
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="turnstile-gate" role="dialog" aria-modal="true" aria-labelledby="turnstile-gate-title">
      <div class="turnstile-gate__card">
        <img src="/assets/images/doraemon/doraemon.svg" alt="" width="72" height="77">
        <h2 id="turnstile-gate-title">
          进入道具监控站前，先确认你是大雄
        </h2>
        <p>站长开启了 Cloudflare 人机验证，完成后 1 小时内无需重复验证。</p>
        <div ref="container" class="turnstile-gate__widget" />
        <p v-if="errorText" class="turnstile-gate__error">
          {{ errorText }}
        </p>
        <Button v-if="errorText" size="sm" variant="outline" @click="renderWidget">
          重新验证
        </Button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.turnstile-gate {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgb(0 60 110 / 55%);
  backdrop-filter: blur(6px);
}

.turnstile-gate__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: min(100%, 380px);
  padding: 24px 20px;
  border-radius: 24px;
  border-bottom: 6px solid #e60012;
  background: var(--card, #fff);
  color: var(--card-foreground, #0b2540);
  text-align: center;
  box-shadow: 0 18px 50px rgb(0 40 80 / 35%);
}

.turnstile-gate__card h2 {
  font-size: 1.05rem;
  font-weight: 700;
}

.turnstile-gate__card p {
  font-size: 0.85rem;
  opacity: 0.8;
}

.turnstile-gate__widget {
  min-height: 65px;
}

.turnstile-gate__error {
  color: #e60012;
  opacity: 1 !important;
}
</style>
