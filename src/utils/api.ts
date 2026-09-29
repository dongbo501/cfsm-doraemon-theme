/**
 * 站点信息、登录状态与主题设置
 *
 * 对应 CFSM 的 GET /api/config。
 * 保留主题原有的 MeInfo / PublicSettings 结构，界面代码按原样读取。
 */

import type { CfsmConfig } from '@/utils/cfsm'
import {
  ADMIN_HISTORY_HOURS,
  CfsmError,
  fetchConfig,
  PUBLIC_HISTORY_HOURS,
  resolveThemeOptions,
  setProbeNames,
} from '@/utils/cfsm'

/** 登录状态。CFSM 只有一位站长，没有用户名 */
export interface MeInfo {
  logged_in: boolean
  username: string
}

/** 公开站点属性 */
export interface PublicSettings {
  sitename: string
  /** 站点是否公开 */
  public_page: boolean
  /** 延迟历史最多可查的小时数（未登录 24，登录后 168） */
  ping_record_preserve_time?: number
  /** 负载历史最多可查的小时数（未登录 24，登录后 168） */
  record_preserve_time?: number
  /** 站长保存的主题设置，已按 theme.json 补齐默认值 */
  theme_settings?: Record<string, unknown> | null
  /** CFSM Workers 版本 */
  version?: string
  /** 最新 Workers 版本，仅登录后返回 */
  latest_workers_version?: string
  /** 单次实时连接的最长分钟数，0 表示不限 */
  ws_timeout_minutes?: number
}

export class ApiError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

function toApiError(error: unknown): unknown {
  if (error instanceof CfsmError)
    return new ApiError(error.status, error.message)
  return error
}

const DEFAULT_SITE_TITLE = '哆啦A梦探针'

/**
 * 主题设置 = theme.json 默认值 + theme_options。
 * 站长没有在主题设置里选过天空模式时，沿用后台外观设置的默认外观（浅色 / 深色）。
 */
function themeSettingsFrom(config: CfsmConfig): Record<string, unknown> {
  const saved = { ...(config.theme_options ?? {}) }
  if (saved.themeMode === undefined && (config.preferred_theme === 'light' || config.preferred_theme === 'dark'))
    saved.themeMode = config.preferred_theme
  return resolveThemeOptions(saved)
}

export function buildPublicSettings(config: CfsmConfig): PublicSettings {
  const hours = config.authorization ? ADMIN_HISTORY_HOURS : PUBLIC_HISTORY_HOURS
  return {
    sitename: config.site_title?.trim() || DEFAULT_SITE_TITLE,
    public_page: config.is_public !== false,
    ping_record_preserve_time: hours,
    record_preserve_time: hours,
    theme_settings: themeSettingsFrom(config),
    version: config.version?.trim() || undefined,
    latest_workers_version: config.last_workers_version?.trim() || undefined,
    ws_timeout_minutes: Number.isInteger(config.frontend_ws_timeout_minutes) ? Math.max(0, config.frontend_ws_timeout_minutes!) : 0,
  }
}

export class CfsmApi {
  private configPromise: Promise<CfsmConfig> | null = null
  private lastConfig: CfsmConfig | null = null

  /** getMe 与 getPublicSettings 在启动时并行调用，共用一次请求 */
  getConfig(force = false): Promise<CfsmConfig> {
    if (force || !this.configPromise) {
      const promise = fetchConfig().then((config) => {
        this.lastConfig = config
        setProbeNames(config)
        return config
      })
      this.configPromise = promise
      promise.catch(() => {}).finally(() => {
        setTimeout(() => {
          if (this.configPromise === promise)
            this.configPromise = null
        }, 1000)
      })
    }
    return this.configPromise
  }

  get config(): CfsmConfig | null {
    return this.lastConfig
  }

  async getMe(): Promise<MeInfo> {
    try {
      const config = await this.getConfig()
      return { logged_in: config.authorization === true, username: config.authorization ? '站长' : '' }
    }
    catch (error) {
      throw toApiError(error)
    }
  }

  async getPublicSettings(): Promise<PublicSettings> {
    try {
      return buildPublicSettings(await this.getConfig())
    }
    catch (error) {
      throw toApiError(error)
    }
  }
}

let sharedApi: CfsmApi | null = null

export function getSharedApi(): CfsmApi {
  if (!sharedApi)
    sharedApi = new CfsmApi()
  return sharedApi
}
