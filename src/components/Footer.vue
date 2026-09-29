<script setup lang="ts">
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useAppStore } from '@/stores/app'

const buildVersion = __BUILD_VERSION__
const buildGitHash = __BUILD_GIT_HASH__

const appStore = useAppStore()

const workersVersion = computed(() => appStore.publicSettings?.version ?? '')
const latestWorkersVersion = computed(() => appStore.publicSettings?.latest_workers_version ?? '')
// 只有登录后 /api/config 才返回最新版本，按字符串比较
const hasWorkersUpdate = computed(() => !!latestWorkersVersion.value && !!workersVersion.value && latestWorkersVersion.value !== workersVersion.value)
</script>

<template>
  <footer class="w-full max-w-[1280px] mx-auto p-4">
    <div class="flex w-full flex-row flex-wrap items-center justify-between gap-3 text-xs text-white/85">
      <div data-footer-credit="powered" class="dora-footer-credit flex shrink-0 items-center gap-1 whitespace-nowrap">
        Powered by
        <a
          href="https://github.com/huilang-me/CF-Server-Monitor/" target="_blank" rel="noopener noreferrer"
          class="transition-opacity hover:opacity-80"
        >
          <span class="font-semibold text-white underline decoration-[#ffd700] decoration-2 underline-offset-2">CF-Server-Monitor</span>
        </a>
        <span v-if="workersVersion">v{{ workersVersion }}</span>
        <DataTooltip
          v-if="hasWorkersUpdate"
          as="span"
          placement="top"
          :content="`Workers 有新版本 v${latestWorkersVersion}`"
        >
          <a
            href="https://github.com/huilang-me/CF-Server-Monitor/releases" target="_blank" rel="noopener noreferrer"
            class="ml-1 inline-flex items-center gap-1 rounded-full bg-[#e60012] px-2 py-0.5 font-semibold text-white"
          >
            <span class="size-1.5 rounded-full bg-[#ffd700]" />可升级
          </a>
        </DataTooltip>
      </div>
      <div data-footer-credit="theme" class="dora-footer-credit flex shrink-0 items-center justify-end gap-1 whitespace-nowrap text-right">
        Theme by
        <DataTooltip
          as="span"
          placement="top"
          :content="`v${buildVersion}\n${buildGitHash}`"
        >
          <a
            href="https://github.com/dongbo501/cfsm-doraemon-theme" target="_blank" rel="noopener noreferrer"
            class="transition-opacity hover:opacity-80"
          >
            <span class="font-semibold text-white underline decoration-[#ffd700] decoration-2 underline-offset-2">Doraemon Edition</span>
          </a>
        </DataTooltip>
      </div>
    </div>
  </footer>
</template>

<style scoped>
/* 页脚压在小镇天际线上，晴空模式的白色围栏会吃掉白字，给署名垫一层半透明底 */
.dora-footer-credit {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgb(0 45 85 / 55%);
  backdrop-filter: blur(4px);
}
</style>
