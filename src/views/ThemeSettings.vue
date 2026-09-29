<script setup lang="ts">
import type { ThemeConfigField } from '@/utils/cfsm'
import { Icon } from '@iconify/vue'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { CardX } from '@/components/ui/card-x'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/stores/app'
import { CfsmError, configFields, configSchema, fitsField, saveThemeOptions } from '@/utils/cfsm'

defineOptions({ name: 'ThemeSettings' })

const router = useRouter()
const appStore = useAppStore()

interface Section {
  title: string
  fields: Array<ThemeConfigField & { key: string }>
}

const sections = computed<Section[]>(() => {
  const list: Section[] = []
  for (const field of configSchema) {
    if (field.type === 'title') {
      list.push({ title: field.label ?? '', fields: [] })
      continue
    }
    if (!field.key)
      continue
    if (!list.length)
      list.push({ title: '', fields: [] })
    list.at(-1)!.fields.push(field as ThemeConfigField & { key: string })
  }
  return list
})

const defaults = Object.fromEntries(configFields.map(field => [field.key, field.default]))

/** 已保存的设置；离开页面且没有保存时恢复为它 */
const committed = ref<Record<string, unknown>>({ ...defaults, ...(appStore.publicSettings?.theme_settings ?? {}) })
const draft = reactive<Record<string, unknown>>({ ...committed.value })
const saving = ref(false)

const canEdit = computed(() => appStore.isLoggedIn)
const dirty = computed(() => configFields.some(field => draft[field.key] !== committed.value[field.key]))
const invalidKeys = computed(() => configFields.filter(field => !fitsField(field, draft[field.key])).map(field => field.key))

function applyPreview(values: Record<string, unknown>): void {
  if (appStore.publicSettings)
    appStore.publicSettings = { ...appStore.publicSettings, theme_settings: { ...values } }
}

// 修改即预览，保存后才写入 CFSM
watch(draft, () => {
  if (!invalidKeys.value.length)
    applyPreview(draft)
}, { deep: true })

onBeforeUnmount(() => {
  if (dirty.value)
    applyPreview(committed.value)
})

function setNumber(key: string, value: string | number): void {
  const number = typeof value === 'number' ? value : Number.parseFloat(value)
  draft[key] = Number.isFinite(number) ? number : value
}

function resetDraft(): void {
  Object.assign(draft, defaults)
}

function discardDraft(): void {
  Object.assign(draft, committed.value)
}

async function save(): Promise<void> {
  if (saving.value || invalidKeys.value.length)
    return
  saving.value = true
  try {
    const values = Object.fromEntries(configFields.map(field => [field.key, draft[field.key]]))
    const saved = await saveThemeOptions(values)
    committed.value = { ...defaults, ...saved }
    Object.assign(draft, committed.value)
    applyPreview(committed.value)
    window.$message?.success('主题设置已保存，所有访客刷新后生效。')
  }
  catch (error) {
    if (error instanceof CfsmError && error.status === 401) {
      appStore.updateLoginState(false)
      window.$message?.error('登录已失效，请先到后台重新登录。')
    }
    else {
      window.$message?.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  finally {
    saving.value = false
  }
}

function optionLabel(field: ThemeConfigField, value: unknown): string {
  return field.options?.find(option => option.value === value)?.label ?? String(value ?? '')
}
</script>

<template>
  <div class="theme-settings space-y-4 px-4 pb-6">
    <div class="flex flex-wrap items-center gap-2 sm:gap-4">
      <Button variant="ghost" size="icon-sm" class="bg-background/50 hover:bg-background" aria-label="返回首页" @click="router.push('/')">
        <Icon icon="tabler:arrow-left" :width="16" :height="16" />
      </Button>
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-bold text-white drop-shadow">
          哆啦A梦主题设置
        </h2>
        <p class="text-xs text-white/85">
          保存到 CF-Server-Monitor 的 theme_options，对所有访客生效；修改时当前页面会先预览。
        </p>
      </div>
      <template v-if="canEdit">
        <Button variant="outline" size="sm" :disabled="saving" @click="resetDraft">
          <Icon icon="tabler:restore" />恢复默认
        </Button>
        <Button variant="outline" size="sm" :disabled="saving || !dirty" @click="discardDraft">
          <Icon icon="tabler:arrow-back-up" />撤销修改
        </Button>
        <Button size="sm" :disabled="saving || !dirty || invalidKeys.length > 0" @click="save">
          <Icon :icon="saving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="saving && 'animate-spin'" />
          {{ saving ? '保存中' : '保存设置' }}
        </Button>
      </template>
    </div>

    <CardX v-if="!canEdit">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <img src="/assets/images/doraemon/doraemon.svg" alt="" width="72" height="77">
        <p class="font-semibold">
          只有站长（哆啦A梦）可以修改主题设置
        </p>
        <p class="text-sm text-muted-foreground">
          请先在 CF-Server-Monitor 后台登录，再回到这里。
        </p>
        <Button as="a" href="/admin#admin">
          <Icon icon="icon-park-outline:setting" />前往后台登录
        </Button>
      </div>
    </CardX>

    <template v-else>
      <CardX v-for="section in sections" :key="section.title" :title="section.title">
        <div class="grid gap-x-6 gap-y-4 md:grid-cols-2">
          <div
            v-for="field in section.fields"
            :key="field.key"
            class="theme-field"
            :class="[field.type === 'text' && 'md:col-span-2', invalidKeys.includes(field.key) && 'theme-field--invalid']"
          >
            <div class="flex items-center justify-between gap-3">
              <label :for="`theme-field-${field.key}`" class="text-sm font-semibold">
                {{ field.label }}
                <span v-if="draft[field.key] !== committed[field.key]" class="theme-field__dot" title="未保存" />
              </label>
              <button
                v-if="field.type === 'boolean'"
                :id="`theme-field-${field.key}`"
                type="button"
                role="switch"
                class="theme-switch"
                :aria-checked="draft[field.key] === true"
                @click="draft[field.key] = draft[field.key] !== true"
              >
                <span />
              </button>
            </div>

            <select
              v-if="field.type === 'select'"
              :id="`theme-field-${field.key}`"
              v-model="draft[field.key]"
              class="theme-input"
            >
              <option v-for="option in field.options" :key="option.value" :value="option.value">
                {{ option.label ?? option.value }}
              </option>
            </select>
            <Input
              v-else-if="field.type === 'number'"
              :id="`theme-field-${field.key}`"
              type="number"
              :min="field.min"
              :max="field.max"
              :model-value="draft[field.key] as number"
              @update:model-value="setNumber(field.key, $event)"
            />
            <textarea
              v-else-if="field.type === 'text'"
              :id="`theme-field-${field.key}`"
              v-model="draft[field.key] as string"
              rows="4"
              class="theme-input font-mono text-xs"
            />
            <Input
              v-else-if="field.type !== 'boolean'"
              :id="`theme-field-${field.key}`"
              v-model="draft[field.key] as string"
            />

            <p v-if="field.help" class="mt-1 text-xs leading-relaxed text-muted-foreground">
              {{ field.help }}
            </p>
            <p v-if="invalidKeys.includes(field.key)" class="mt-1 text-xs text-destructive">
              取值无效{{ field.type === 'number' ? `，范围 ${field.min ?? '-∞'} ~ ${field.max ?? '∞'}` : '' }}
            </p>
            <p v-else-if="field.type === 'select' && draft[field.key] !== field.default" class="mt-1 text-[11px] text-muted-foreground/80">
              默认：{{ optionLabel(field, field.default) }}
            </p>
          </div>
        </div>
      </CardX>
    </template>
  </div>
</template>

<style scoped>
.theme-field__dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 4px;
  border-radius: 999px;
  background: #ffd700;
  box-shadow: 0 0 0 2px rgb(230 0 18 / 55%);
  vertical-align: middle;
}

.theme-field select,
.theme-field textarea,
.theme-field input {
  margin-top: 6px;
}

.theme-field--invalid :is(select, textarea, input) {
  border-color: var(--destructive, #e60012);
}

.theme-input {
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--input, #cbd5e1);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 0.875rem;
  outline: none;
}

.theme-input:focus-visible {
  border-color: var(--ring, #0096e0);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring, #0096e0) 35%, transparent);
}

.theme-input option {
  color: #0b2540;
}

.theme-switch {
  position: relative;
  flex-shrink: 0;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: rgb(120 140 160 / 45%);
  transition: background-color 0.2s;
}

.theme-switch span {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
  transition: transform 0.2s;
}

.theme-switch[aria-checked='true'] {
  background: #0096e0;
}

.theme-switch[aria-checked='true'] span {
  transform: translateX(18px);
  background: #ffd700;
}
</style>
