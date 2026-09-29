import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import vueDevTools from 'vite-plugin-vue-devtools'

interface ThemeManifest {
  version?: unknown
}

const themeJsonPath = resolve(__dirname, 'theme.json')
// 开发服务器把 /api（含 WebSocket）以及默认皮肤的 /flags、/os-icons 代理到这个 CFSM Worker
const cfsmTarget = process.env.CFSM_API || 'http://127.0.0.1:8787'

function getThemeVersion(): string {
  if (!existsSync(themeJsonPath))
    throw new Error('theme.json not found')

  const version = (JSON.parse(readFileSync(themeJsonPath, 'utf-8')) as ThemeManifest).version
  if (typeof version !== 'string' || !version.trim())
    throw new TypeError('theme.json does not contain a top-level string version field')

  return version.trim()
}

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    return 'unknown'
  }
}

/**
 * CF-Server-Monitor 只从主题目录读取 index.html 和 assets/，
 * 所以构建产物只有这两样：public/ 下的静态文件也都放在 public/assets/ 里。
 */
export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(getThemeVersion()),
    __BUILD_GIT_HASH__: JSON.stringify(getCommitHash()),
  },
  plugins: [
    vue(),
    vueDevTools(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: cfsmTarget,
        changeOrigin: true,
        ws: true,
      },
      '/flags': {
        target: cfsmTarget,
        changeOrigin: true,
      },
      '/os-icons': {
        target: cfsmTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: ['es2018', 'safari15.4'],
    cssTarget: 'safari15.4',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'echarts': ['echarts', 'vue-echarts'],
          'reka-ui': ['reka-ui'],
          'vueuse': ['@vueuse/core'],
          'v3-services': [
            './src/services/history.service.ts',
            './src/services/metrics.service.ts',
            './src/services/request.service.ts',
            './src/services/cache.service.ts',
            './src/utils/osImageHelper.ts',
            './src/utils/metricSeries.ts',
            './src/composables/useNodePingDisplay.ts',
          ],
        },
      },
    },
  },
})
