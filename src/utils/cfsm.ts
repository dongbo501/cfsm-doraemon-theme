/**
 * CF-Server-Monitor 数据层
 *
 * 主题只使用 CFSM 的公开接口（见 theme-develop.md）：
 *   GET  /api/config         站点配置、登录状态、Turnstile、主题设置 theme_options
 *   GET  /api/servers        首页服务器列表（含最新指标与三网延迟窗口）
 *   GET  /api/server?id=     详情页单台服务器
 *   GET  /api/history/all    历史指标
 *   GET  /api/ws             实时推送（batchUpdate）
 *   POST /api/theme_options  站长保存主题设置
 *
 * 这里把 CFSM 的服务器对象转换成主题组件原本使用的 Client / NodeStatus 结构，
 * 其余界面代码因此不需要感知数据来自哪一种后端。
 *
 * 字段一律按「可能缺失」处理：WebSocket 推送是增量字段，旧探针没有磁盘 IO、GPU 等字段。
 */

import type { Client, NodeStatus, NodeStatusPing } from '@/utils/rpc'
import manifest from '../../theme.json'

// ==================== CFSM 响应类型 ====================

export type ProbeValue = number | null | false

export interface CfsmLatencyPoint {
  ts: number
  [probe: string]: ProbeValue | undefined
}

export interface CfsmGpu {
  id?: string
  name?: string
  info?: number | null
}

export interface CfsmServer {
  id: string
  name?: string
  server_group?: string
  tags?: string
  price?: string | number
  billing_cycle?: string
  auto_renewal?: string | number | boolean
  currency?: string
  expire_date?: string
  traffic_limit?: string | number
  traffic_calc_type?: string
  reset_day?: number
  is_hidden?: string | number | boolean
  sort_order?: number
  cpu?: number | string
  load_avg?: string
  net_in_speed?: number | string
  net_out_speed?: number | string
  net_rx?: number | string
  net_tx?: number | string
  net_rx_monthly?: number | string
  net_tx_monthly?: number | string
  processes?: number | string
  tcp_conn?: number | string
  udp_conn?: number | string
  ram_total?: number | string
  ram_used?: number | string
  swap_total?: number | string
  swap_used?: number | string
  disk_total?: number | string
  disk_used?: number | string
  cpu_cores?: number | string
  cpu_info?: string
  gpu_info?: CfsmGpu[] | string
  arch?: string
  os?: string
  kernel_version?: string
  region?: string
  ip_v4?: string
  ip_v6?: string
  boot_time?: string | number
  agent_version?: string
  last_updated?: number
  timestamp?: number
  is_online?: boolean
  ping?: CfsmLatencyPoint[]
  loss?: CfsmLatencyPoint[]
  [key: string]: unknown
}

export interface CfsmSysConfig {
  show_price?: boolean
  show_expire?: boolean
  show_tf?: boolean
  show_three_net_details?: boolean
  long_history_points?: number
}

export interface CfsmServersResponse {
  servers: CfsmServer[]
  sysConfig?: CfsmSysConfig
  /** 最近约 5 分钟内各服务器的上报样本，可用来预热实时图表 */
  latestReportUpdates?: CfsmServerUpdate[]
}

export interface CfsmConfig {
  version?: string
  last_workers_version?: string | null
  last_agent_version?: string | null
  is_public?: boolean
  authorization?: boolean
  turnstile_enabled?: boolean
  turnstile_site_key?: string
  custom_ct_name?: string
  custom_cu_name?: string
  custom_cm_name?: string
  custom_bd_name?: string
  node_1_name?: string
  node_2_name?: string
  node_3_name?: string
  node_4_name?: string
  site_title?: string
  preferred_theme?: string
  theme_options?: Record<string, unknown>
  verified?: boolean
  turnstile_verified?: string | null
  frontend_ws_timeout_minutes?: number
  long_history_points?: number
}

export interface CfsmHistoryRow {
  timestamp: number
  [key: string]: unknown
}

export interface CfsmSample {
  ts?: number
  timestamp?: number
  data?: Partial<CfsmServer>
  payload?: Partial<CfsmServer>
  metrics?: Partial<CfsmServer>
}

export interface CfsmServerUpdate {
  serverId: string
  samples?: CfsmSample[]
}

// ==================== 错误 ====================

export class CfsmError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'CfsmError'
  }
}

// ==================== API Base ====================

const TRAILING_SLASH_REGEX = /\/+$/
const HTTP_PROTOCOL_REGEX = /^https?:$/

/**
 * 同域部署时 API Base 就是当前页面；纯静态部署时由 <meta name="apiBase"> 指定，多个地址用英文逗号分隔。
 */
export function getApiBases(): string[] {
  const meta = typeof document !== 'undefined'
    ? document.querySelector<HTMLMetaElement>('meta[name="apiBase"]')?.content ?? ''
    : ''
  const bases = meta.split(',')
    .map(item => item.trim().replace(TRAILING_SLASH_REGEX, ''))
    .filter((item) => {
      try {
        return HTTP_PROTOCOL_REGEX.test(new URL(item).protocol)
      }
      catch {
        return false
      }
    })
  return bases.length ? [...new Set(bases)] : [location.origin]
}

export function primaryApiBase(): string {
  return getApiBases()[0]!
}

/** 多站模式下每台服务器只属于返回它的那个后端 */
const serverBase = new Map<string, string>()

export function baseForServer(id: string): string {
  return serverBase.get(id) ?? primaryApiBase()
}

// ==================== 登录与 Turnstile 凭证 ====================

const JWT_KEY = 'jwt_token'
const TURNSTILE_TOKEN_KEY = 'turnstile_token'
const TURNSTILE_VERIFIED_KEY = 'turnstile_verified'

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  }
  catch {
    return ''
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value)
      localStorage.setItem(key, value)
    else
      localStorage.removeItem(key)
  }
  catch {}
}

/** 内置后台登录后把 JWT 存在同源 localStorage 的 jwt_token 里 */
export function getJwt(): string {
  return readStorage(JWT_KEY)
}

export function clearTurnstileCredentials(): void {
  writeStorage(TURNSTILE_TOKEN_KEY, null)
  writeStorage(TURNSTILE_VERIFIED_KEY, null)
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  /** 是否携带 Turnstile 凭证；/api/config 首次探测时不带，否则过期凭证会直接 403 */
  turnstile?: boolean
  /** 本次请求用的一次性 Turnstile token */
  turnstileToken?: string
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined)
    headers['Content-Type'] = 'application/json'
  const jwt = getJwt()
  if (jwt)
    headers.Authorization = `Bearer ${jwt}`
  if (options.turnstileToken) {
    headers['X-Turnstile-Token'] = options.turnstileToken
  }
  else if (options.turnstile !== false) {
    const verified = readStorage(TURNSTILE_VERIFIED_KEY)
    if (verified)
      headers['X-Turnstile-Verified'] = verified
    else if (readStorage(TURNSTILE_TOKEN_KEY))
      headers['X-Turnstile-Token'] = readStorage(TURNSTILE_TOKEN_KEY)
  }
  return headers
}

async function readError(res: Response): Promise<CfsmError> {
  let message = `HTTP ${res.status}`
  try {
    const body = await res.json() as { error?: string, message?: string }
    message = body.error || body.message || message
  }
  catch {}
  return new CfsmError(res.status, message)
}

// ==================== Turnstile 人机验证 ====================

/**
 * 需要人机验证时由界面层（TurnstileGate）弹出验证组件并返回一次性 token。
 * 数据层只负责在 403 时发起验证、换取 1 小时有效的 turnstile_verified 凭证。
 */
type TurnstileSolver = (siteKey: string) => Promise<string>
let turnstileSolver: TurnstileSolver | null = null
let turnstileSiteKey = ''
let turnstilePromise: Promise<void> | null = null

export function setTurnstileSolver(solver: TurnstileSolver): void {
  turnstileSolver = solver
}

async function verifyTurnstile(base: string): Promise<void> {
  if (!turnstileSiteKey || !turnstileSolver)
    throw new CfsmError(403, 'Turnstile verification required')
  if (!turnstilePromise) {
    turnstilePromise = (async () => {
      clearTurnstileCredentials()
      const token = await turnstileSolver!(turnstileSiteKey)
      writeStorage(TURNSTILE_TOKEN_KEY, token)
      // 带 X-Turnstile-Token 请求 /api/config，响应体返回可复用 1 小时的加密凭证
      const config = await rawRequest<CfsmConfig>(base, '/api/config', { turnstileToken: token })
      if (!config.turnstile_verified && !config.verified)
        throw new CfsmError(403, 'Turnstile verification failed')
    })().finally(() => {
      turnstilePromise = null
    })
  }
  return turnstilePromise
}

async function rawRequest<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: buildHeaders(options),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'include',
    signal: options.signal,
  })
  if (!res.ok) {
    if (res.status === 403)
      clearTurnstileCredentials()
    throw await readError(res)
  }
  const data = await res.json() as T & { turnstile_verified?: string | null }
  if (data && typeof data === 'object' && typeof data.turnstile_verified === 'string' && data.turnstile_verified) {
    writeStorage(TURNSTILE_VERIFIED_KEY, data.turnstile_verified)
    writeStorage(TURNSTILE_TOKEN_KEY, null)
  }
  return data
}

/** 普通 API 请求：Turnstile 凭证过期返回 403 时，完成一次人机验证后重试 */
async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(base, path, options)
  }
  catch (error) {
    if (error instanceof CfsmError && error.status === 403 && turnstileSiteKey && turnstileSolver) {
      await verifyTurnstile(base)
      return rawRequest<T>(base, path, options)
    }
    throw error
  }
}

// ==================== 站点配置 ====================

/**
 * 读取 /api/config。缓存的 Turnstile 凭证过期时这里会 403，清掉后不带凭证再探测一次；
 * 启用了全局人机验证且尚未验证时，先完成验证再继续加载。
 */
export async function fetchConfig(base = primaryApiBase()): Promise<CfsmConfig> {
  let config: CfsmConfig
  try {
    config = await rawRequest<CfsmConfig>(base, '/api/config')
  }
  catch (error) {
    if (!(error instanceof CfsmError) || error.status !== 403)
      throw error
    clearTurnstileCredentials()
    config = await rawRequest<CfsmConfig>(base, '/api/config', { turnstile: false })
  }

  turnstileSiteKey = config.turnstile_enabled ? String(config.turnstile_site_key ?? '').trim() : ''
  if (config.turnstile_enabled && !config.verified) {
    await verifyTurnstile(base)
    config = await rawRequest<CfsmConfig>(base, '/api/config')
  }
  return config
}

// ---- 主题设置 ----

interface ConfigField {
  key?: string
  type: string
  label?: string
  help?: string
  default?: unknown
  options?: Array<{ value: string, label?: string }>
  min?: number
  max?: number
}

export type ThemeConfigField = ConfigField

/** theme.json 中声明的全部设置项（含分组标题），主题设置页按它渲染 */
export const configSchema = manifest.config as ConfigField[]

/** theme.json 中声明的设置项（去掉分组标题） */
export const configFields = configSchema.filter(
  (field): field is ConfigField & { key: string } => field.type !== 'title' && typeof field.key === 'string',
)

/** 保存的值可能来自旧版本主题，对不上的当作没保存过 */
export function fitsField(field: ConfigField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && value >= (field.min ?? Number.NEGATIVE_INFINITY) && value <= (field.max ?? Number.POSITIVE_INFINITY)
    case 'select':
      return !!field.options?.some(option => option.value === value)
    default:
      return typeof value === 'string'
  }
}

/** theme.json 默认值 + 站长通过 POST /api/theme_options 保存的值 */
export function resolveThemeOptions(saved: unknown): Record<string, unknown> {
  const values = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
  return Object.fromEntries(configFields.map(field => [field.key, fitsField(field, values[field.key]) ? values[field.key] : field.default]))
}

/** 保存主题设置：只更新 appearance_options.theme_options，需要登录 */
export async function saveThemeOptions(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await request<{ theme_options?: Record<string, unknown> }>(primaryApiBase(), '/api/theme_options', {
    method: 'POST',
    body: { theme_options: options },
  })
  return result.theme_options ?? options
}

// ==================== 服务器列表与详情 ====================

export interface ServersSnapshot {
  servers: CfsmServer[]
  sysConfig: CfsmSysConfig
  updates: CfsmServerUpdate[]
}

/** 读取所有 apiBase 的服务器列表；只要有一个后端成功就返回，全部失败时抛出第一个错误 */
export async function fetchAllServers(signal?: AbortSignal): Promise<ServersSnapshot> {
  const bases = getApiBases()
  const results = await Promise.allSettled(bases.map(base => request<CfsmServersResponse>(base, '/api/servers', { signal })))
  const servers: CfsmServer[] = []
  const updates: CfsmServerUpdate[] = []
  let sysConfig: CfsmSysConfig | undefined
  let firstError: unknown
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      firstError ??= result.reason
      return
    }
    const base = bases[index]!
    sysConfig ??= result.value?.sysConfig
    if (Array.isArray(result.value?.latestReportUpdates))
      updates.push(...result.value.latestReportUpdates)
    for (const server of Array.isArray(result.value?.servers) ? result.value.servers : []) {
      if (!server || server.id === undefined || server.id === null)
        continue
      const id = String(server.id)
      serverBase.set(id, base)
      servers.push({ ...server, id })
    }
  })
  if (!sysConfig && firstError)
    throw firstError
  return { servers, sysConfig: sysConfig ?? {}, updates }
}

/** 详情页只取单台服务器，不拉全量列表 */
export async function fetchServer(id: string, signal?: AbortSignal): Promise<CfsmServer> {
  const server = await request<CfsmServer>(baseForServer(id), `/api/server?id=${encodeURIComponent(id)}`, { signal })
  return { ...server, id: String(server.id ?? id) }
}

// ==================== 历史查询 ====================

/** /api/history/all 只接受这几档小时数；未登录最多 24 小时，登录后 168 小时 */
const HISTORY_HOUR_STEPS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168]
export const PUBLIC_HISTORY_HOURS = 24
export const ADMIN_HISTORY_HOURS = 168

/** 取能覆盖所需时长的最小档位 */
export function historyWindowFor(hours: number, ceiling: number): number {
  const wanted = Math.min(Math.max(hours, 0.167), ceiling)
  return HISTORY_HOUR_STEPS.find(step => step >= wanted && step <= ceiling) ?? Math.min(ceiling, 168)
}

/** 同时最多 3 个历史查询，避免首页多个组件同时触发时打满 Workers 并发 */
const HISTORY_CONCURRENCY = 3
let historyActive = 0
const historyWaiters: Array<() => void> = []

async function acquireHistorySlot(signal?: AbortSignal): Promise<void> {
  if (historyActive < HISTORY_CONCURRENCY) {
    historyActive += 1
    return
  }
  await new Promise<void>((resolve, reject) => {
    function grant(): void {
      signal?.removeEventListener('abort', onAbort)
      historyActive += 1
      resolve()
    }
    function onAbort(): void {
      const index = historyWaiters.indexOf(grant)
      if (index >= 0)
        historyWaiters.splice(index, 1)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    historyWaiters.push(grant)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function releaseHistorySlot(): void {
  historyActive = Math.max(0, historyActive - 1)
  historyWaiters.shift()?.()
}

const historyCache = new Map<string, { at: number, promise: Promise<CfsmHistoryRow[]> }>()
const HISTORY_CACHE_MS = 30_000

/** 读取一台服务器最近 hours 小时的历史（hours 必须是允许的档位，见 historyWindowFor） */
export function fetchHistory(id: string, hours: number, signal?: AbortSignal): Promise<CfsmHistoryRow[]> {
  const path = `/api/history/all?id=${encodeURIComponent(id)}&hours=${hours}`
  const key = `${baseForServer(id)}${path}`

  // 同一窗口的请求在短时间内合并，避免图表、统计和延迟面板各自重复查询
  const cached = historyCache.get(key)
  if (cached && Date.now() - cached.at < HISTORY_CACHE_MS)
    return cached.promise

  const promise = (async () => {
    await acquireHistorySlot(signal)
    try {
      const rows = await request<CfsmHistoryRow[]>(baseForServer(id), path, { signal })
      return (Array.isArray(rows) ? rows : [])
        .map(row => ({ ...row, timestamp: normalizeTimestamp(row?.timestamp) }))
        .filter(row => row.timestamp > 0)
        .sort((a, b) => a.timestamp - b.timestamp)
    }
    finally {
      releaseHistorySlot()
    }
  })()

  historyCache.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (historyCache.get(key)?.promise === promise)
      historyCache.delete(key)
  })
  return promise
}

// ==================== 延迟探测（三网 / 自定义节点） ====================

export interface ProbeDefinition {
  key: string
  taskId: number
  nameKey: keyof CfsmConfig
  fallbackName: string
}

/** 每台服务器最多 8 路探测：三网、BGP 与 4 个自定义节点。task_id 只在主题内部使用 */
export const PROBES: ProbeDefinition[] = [
  { key: 'ct', taskId: 1, nameKey: 'custom_ct_name', fallbackName: '电信' },
  { key: 'cu', taskId: 2, nameKey: 'custom_cu_name', fallbackName: '联通' },
  { key: 'cm', taskId: 3, nameKey: 'custom_cm_name', fallbackName: '移动' },
  { key: 'bd', taskId: 4, nameKey: 'custom_bd_name', fallbackName: 'BGP' },
  { key: 'node_1', taskId: 5, nameKey: 'node_1_name', fallbackName: 'Node 1' },
  { key: 'node_2', taskId: 6, nameKey: 'node_2_name', fallbackName: 'Node 2' },
  { key: 'node_3', taskId: 7, nameKey: 'node_3_name', fallbackName: 'Node 3' },
  { key: 'node_4', taskId: 8, nameKey: 'node_4_name', fallbackName: 'Node 4' },
]

const probeNames = new Map<number, string>(PROBES.map(probe => [probe.taskId, probe.fallbackName]))

export function setProbeNames(config: CfsmConfig): void {
  for (const probe of PROBES) {
    const name = config[probe.nameKey]
    if (typeof name === 'string' && name.trim())
      probeNames.set(probe.taskId, name.trim())
  }
}

export function probeName(taskId: number): string {
  return probeNames.get(taskId) ?? `探测 ${taskId}`
}

/**
 * 延迟 / 丢包取值约定：false 表示未配置或未取样（不显示）；null 表示本轮探测超时；数字 0 是有效数据。
 */
export function readProbeValue(value: unknown): ProbeValue | undefined {
  if (value === false || value === 'false')
    return false
  if (value === null)
    return null
  if (value === undefined || value === '')
    return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export interface ProbeSample {
  taskId: number
  /** 毫秒时间戳 */
  ts: number
  /** 延迟毫秒；null 表示超时 */
  latency: number | null
  /** 丢包百分比 0-100 */
  loss: number
}

/**
 * 一路探测的一个采样点。false 表示未配置；丢包为 null 表示这一轮没有可用样本（未配置的自定义节点也是这样），
 * 两者都不显示。延迟为 null 而丢包有值时是探测超时。
 */
function toProbeSample(taskId: number, ts: number, ping: ProbeValue | undefined, loss: ProbeValue | undefined): ProbeSample | null {
  if (ping === false || loss === false)
    return null
  const latency = typeof ping === 'number' ? ping : null
  if (latency === null && typeof loss !== 'number')
    return null
  return {
    taskId,
    ts,
    latency,
    loss: typeof loss === 'number' ? Math.min(100, Math.max(0, loss)) : 0,
  }
}

/** 从一行数据（历史行或服务器快照）中取出每路探测的延迟与丢包 */
export function probeSamplesFromRow(row: Record<string, unknown>, ts: number): ProbeSample[] {
  const samples: ProbeSample[] = []
  for (const probe of PROBES) {
    const ping = readProbeValue(row[`ping_${probe.key}`])
    const loss = readProbeValue(row[`loss_${probe.key}`])
    const sample = toProbeSample(probe.taskId, ts, ping, loss)
    if (sample)
      samples.push(sample)
  }
  return samples
}

/**
 * /api/servers 为每台服务器附带最近 2 小时、最多 20 个点的三网延迟窗口（后台开启三网详情时）。
 * 首页卡片直接用它展示延迟小图，不为每张卡片单独查询历史。
 */
const latencyWindows = new Map<string, ProbeSample[]>()
let latencyWindowsEnabled = false

export function isLatencyWindowEnabled(): boolean {
  return latencyWindowsEnabled
}

export function getLatencyWindow(id: string): ProbeSample[] | undefined {
  return latencyWindows.get(id)
}

export function rememberLatencyWindows(snapshot: ServersSnapshot): void {
  latencyWindowsEnabled = snapshot.sysConfig.show_three_net_details === true
  for (const server of snapshot.servers) {
    const pings = Array.isArray(server.ping) ? server.ping : []
    const losses = Array.isArray(server.loss) ? server.loss : []
    const lossByTs = new Map(losses.map(point => [normalizeTimestamp(point?.ts), point]))
    const samples: ProbeSample[] = []
    for (const point of pings) {
      const ts = normalizeTimestamp(point?.ts)
      if (!ts)
        continue
      const lossPoint = lossByTs.get(ts)
      for (const probe of PROBES) {
        const sample = toProbeSample(probe.taskId, ts, readProbeValue(point[probe.key]), readProbeValue(lossPoint?.[probe.key]))
        if (sample)
          samples.push(sample)
      }
    }
    latencyWindows.set(server.id, samples.sort((a, b) => a.ts - b.ts))
  }
}

const LATENCY_WINDOW_MS = 2 * 60 * 60 * 1000
/** 与后端窗口的抽样间隔（约 6 分钟）对齐，避免实时推送把窗口挤成最近几分钟 */
const LATENCY_WINDOW_STEP_MS = 5 * 60 * 1000

/** WebSocket 推送的报告级样本带有最新延迟，按窗口的抽样间隔追加，首页延迟小图因此随推送更新 */
export function appendLatencySample(id: string, data: Record<string, unknown>, ts: number): void {
  const window = latencyWindows.get(id)
  if (!latencyWindowsEnabled || !window)
    return
  const fresh = probeSamplesFromRow(data, ts)
  if (!fresh.length)
    return
  const lastTs = window.at(-1)?.ts ?? 0
  if (ts - lastTs < LATENCY_WINDOW_STEP_MS)
    return
  const cutoff = ts - LATENCY_WINDOW_MS
  latencyWindows.set(id, [...window.filter(sample => sample.ts >= cutoff), ...fresh])
}

// ==================== 字段转换 ====================

const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})/
const WHITESPACE_REGEX = /\s+/
const TAG_SEPARATOR_REGEX = /[,，;；]/
const FLAG_CODE_REGEX = /^[a-z]{2}$/
const THOUSANDS_SEPARATOR_REGEX = /,/g
const PRICE_NUMBER_REGEX = /-?[\d.]+/

export function normalizeTimestamp(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0)
    return 0
  return number < 10_000_000_000 ? number * 1000 : number
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

/** 缺失时返回 NaN，图表按「无数据」处理 */
export function numOrNaN(value: unknown): number {
  return num(value, Number.NaN)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** CFSM 的内存、Swap、磁盘单位是 MiB，主题内部统一用字节 */
export function mibToBytes(value: unknown, fallback = 0): number {
  const mib = num(value, Number.NaN)
  return Number.isFinite(mib) ? mib * MIB : fallback
}

/** ISO 3166 两位代码 → 旗帜 emoji（主题的地区工具以 emoji 为键） */
export function countryToFlag(code: string | undefined): string {
  const cc = (code ?? '').trim().toUpperCase()
  if (!COUNTRY_CODE_REGEX.test(cc))
    return ''
  return String.fromCodePoint(...Array.from(cc, ch => 0x1F1E6 + ch.charCodeAt(0) - 65))
}

/** 旗帜图片走 CFSM 默认皮肤的静态文件 /flags/<code>.svg */
export function flagUrl(regionCode: string | undefined): string {
  const cc = (regionCode ?? '').trim().toLowerCase()
  return `/flags/${FLAG_CODE_REGEX.test(cc) ? cc : 'un'}.svg`
}

const BILLING_CYCLE_DAYS: Record<string, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  two_years: 730,
  three_years: 1095,
  four_years: 1460,
  five_years: 1825,
}

const BILLING_CYCLE_MONTHS: Record<string, number> = {
  month: 1,
  quarter: 3,
  half_year: 6,
  year: 12,
  two_years: 24,
  three_years: 36,
  four_years: 48,
  five_years: 60,
}

const BILLING_CYCLE_ALIASES: Record<string, string> = {
  monthly: 'month',
  quarterly: 'quarter',
  halfyear: 'half_year',
  yearly: 'year',
  annual: 'year',
}

function billingCycleKey(cycle: unknown): string {
  const raw = str(cycle).trim().toLowerCase()
  return BILLING_CYCLE_DAYS[raw] ? raw : BILLING_CYCLE_ALIASES[raw] ?? 'month'
}

/** CFSM 付款周期（month / quarter / year…）→ 主题使用的天数 */
export function billingCycleDays(cycle: unknown): number {
  return BILLING_CYCLE_DAYS[billingCycleKey(cycle)] ?? 30
}

/**
 * 价格：空白表示未设置（主题按 0 处理，不显示），"0" 或 "-1" 表示免费（主题的免费标记是 -1）
 */
export function normalizePrice(value: unknown): number {
  const raw = str(value).trim()
  if (!raw)
    return 0
  const price = Number.parseFloat(raw.replace(THOUSANDS_SEPARATOR_REGEX, '').match(PRICE_NUMBER_REGEX)?.[0] ?? '')
  if (!Number.isFinite(price))
    return 0
  if (price === 0 || price === -1)
    return -1
  return price < 0 ? 0 : price
}

/**
 * 到期日：CFSM 保存为 YYYY-MM-DD，按当天结束计算。
 * 开启自动续费且已过期时，按付款周期顺延到下一个未过期的日期（与默认主题一致）。
 */
export function expiryMoment(server: CfsmServer): string {
  const match = str(server.expire_date).trim().match(DATE_REGEX)
  if (!match)
    return ''
  let year = Number(match[1])
  let month = Number(match[2])
  const day = Number(match[3])
  const endOfDay = (y: number, m: number): Date => {
    const lastDay = new Date(y, m, 0).getDate()
    return new Date(y, m - 1, Math.min(day, lastDay), 23, 59, 59)
  }
  let date = endOfDay(year, month)
  if (Number.isNaN(date.getTime()))
    return ''
  if (flag(server.auto_renewal)) {
    const step = BILLING_CYCLE_MONTHS[billingCycleKey(server.billing_cycle)] ?? 1
    for (let guard = 0; date.getTime() < Date.now() && guard < 1200; guard++) {
      month += step
      year += Math.floor((month - 1) / 12)
      month = ((month - 1) % 12) + 1
      date = endOfDay(year, month)
    }
  }
  return date.toISOString()
}

const TRAFFIC_TYPES: Record<string, string> = {
  total: 'sum',
  ul: 'up',
  dl: 'down',
  max: 'max',
}

/** gpu_info 可能是数组，也可能是同结构的 JSON 字符串 */
export function parseGpuInfo(value: unknown): CfsmGpu[] {
  let list: unknown = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    }
    catch {
      return []
    }
  }
  return Array.isArray(list) ? list.filter((item): item is CfsmGpu => !!item && typeof item === 'object') : []
}

function gpuUsage(value: unknown): { count: number, average: number } {
  const usages = parseGpuInfo(value).map(gpu => gpu.info).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return {
    count: parseGpuInfo(value).length,
    average: usages.length ? usages.reduce((sum, v) => sum + v, 0) / usages.length : 0,
  }
}

export function parseLoadAvg(value: unknown): [number, number, number] {
  const parts = str(value).trim().split(WHITESPACE_REGEX)
  return [num(parts[0], Number.NaN), num(parts[1], Number.NaN), num(parts[2], Number.NaN)]
}

export function cfsmServerToClient(server: CfsmServer): Client {
  const gpus = parseGpuInfo(server.gpu_info)
  const region = str(server.region).trim().toUpperCase()
  return {
    uuid: server.id,
    name: str(server.name) || server.id,
    cpu_name: str(server.cpu_info),
    virtualization: '',
    arch: str(server.arch),
    cpu_cores: num(server.cpu_cores),
    os: str(server.os),
    kernel_version: str(server.kernel_version),
    gpu_name: gpus.map(gpu => gpu.name).filter(Boolean).join(', ') || undefined,
    // CFSM 公开接口只返回 IPv4 / IPv6 是否可达，不返回地址
    ipv4: undefined,
    ipv6: undefined,
    region: countryToFlag(region),
    remark: undefined,
    public_remark: '',
    mem_total: mibToBytes(server.ram_total),
    swap_total: mibToBytes(server.swap_total),
    disk_total: mibToBytes(server.disk_total),
    version: str(server.agent_version) || undefined,
    weight: num(server.sort_order),
    price: normalizePrice(server.price),
    billing_cycle: billingCycleDays(server.billing_cycle),
    auto_renewal: flag(server.auto_renewal),
    currency: str(server.currency).trim() || '¥',
    expired_at: expiryMoment(server),
    group: str(server.server_group).trim(),
    tags: str(server.tags).split(TAG_SEPARATOR_REGEX).map(tag => tag.trim()).filter(Boolean).join(';'),
    hidden: flag(server.is_hidden),
    // CFSM 的月流量上限单位是 GB（1024³）
    traffic_limit: num(server.traffic_limit) > 0 ? num(server.traffic_limit) * GIB : 0,
    traffic_limit_type: TRAFFIC_TYPES[str(server.traffic_calc_type)] ?? 'sum',
    created_at: '',
    updated_at: '',
  }
}

/** 5 分钟内有上报视为在线，与 CFSM 的统计口径一致 */
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000

/** 最近一次上报时间。timestamp 是服务器记录本身的时间（如创建时间），不代表上报 */
export function lastReportAt(server: CfsmServer): number {
  return normalizeTimestamp(server.last_updated)
}

export function isServerOnline(server: CfsmServer, now = Date.now()): boolean {
  const last = lastReportAt(server)
  return last > 0 && now - last < ONLINE_THRESHOLD_MS
}

function latestPings(server: CfsmServer): Record<string, NodeStatusPing> | undefined {
  const result: Record<string, NodeStatusPing> = {}
  for (const sample of probeSamplesFromRow(server, lastReportAt(server))) {
    const latest = sample.latency ?? -1
    result[String(sample.taskId)] = {
      name: probeName(sample.taskId),
      latest,
      avg: latest,
      tail: latest,
      loss: sample.loss,
      min: latest,
      max: latest,
    }
  }
  return Object.keys(result).length ? result : undefined
}

export function cfsmServerToStatus(server: CfsmServer, now = Date.now()): NodeStatus {
  const [load1, load5, load15] = parseLoadAvg(server.load_avg)
  const last = lastReportAt(server)
  const online = isServerOnline(server, now)
  const bootTime = normalizeTimestamp(server.boot_time)
  const gpu = gpuUsage(server.gpu_info)
  return {
    client: server.id,
    time: last > 0 ? new Date(last).toISOString() : '',
    cpu: num(server.cpu),
    gpu: gpu.average,
    gpu_count: gpu.count || undefined,
    gpu_average_usage: gpu.count ? gpu.average : undefined,
    gpu_detailed_info: gpu.count
      ? parseGpuInfo(server.gpu_info).map((item, index) => ({ name: item.name, device_index: index, utilization: item.info ?? undefined }))
      : undefined,
    ram: mibToBytes(server.ram_used),
    ram_total: mibToBytes(server.ram_total),
    swap: mibToBytes(server.swap_used),
    swap_total: mibToBytes(server.swap_total),
    load: Number.isFinite(load1) ? load1 : 0,
    load5: Number.isFinite(load5) ? load5 : 0,
    load15: Number.isFinite(load15) ? load15 : 0,
    temp: 0,
    disk: mibToBytes(server.disk_used),
    disk_total: mibToBytes(server.disk_total),
    net_in: num(server.net_in_speed),
    net_out: num(server.net_out_speed),
    // 本月流量，与 traffic_limit 月配额对应
    net_total_up: num(server.net_tx_monthly),
    net_total_down: num(server.net_rx_monthly),
    // 探针记录的累计流量
    traffic_up: num(server.net_tx),
    traffic_down: num(server.net_rx),
    process: num(server.processes),
    connections: num(server.tcp_conn),
    connections_udp: num(server.udp_conn),
    online,
    uptime: online && bootTime > 0 ? Math.max(0, Math.floor((now - bootTime) / 1000)) : 0,
    // 从未上报过
    message: last === 0 ? 'unavailable' : undefined,
    ping: latestPings(server),
  }
}

export function serversToMaps(servers: CfsmServer[], now = Date.now()): { clients: Record<string, Client>, statuses: Record<string, NodeStatus> } {
  const clients: Record<string, Client> = {}
  const statuses: Record<string, NodeStatus> = {}
  for (const server of servers) {
    try {
      clients[server.id] = cfsmServerToClient(server)
      statuses[server.id] = cfsmServerToStatus(server, now)
    }
    catch (error) {
      // 单台服务器的坏数据不影响其他服务器
      console.warn('[cfsm] skipped malformed server', server, error)
    }
  }
  return { clients, statuses }
}

// ==================== WebSocket ====================

export interface LiveSocketHandlers {
  onUpdates: (updates: CfsmServerUpdate[]) => void
  onOpen?: () => void
  onClose?: (event: CloseEvent) => void
}

export interface LiveSocket {
  close: () => void
}

const WS_PING_INTERVAL_MS = 30_000

/**
 * 订阅 /api/ws。scope 为 all 时建连后通过通道发送本后端的服务器 ID 列表；
 * scope 为单台服务器 ID 时只接收这一台的更新。
 * 同域部署靠 cfsm_auth Cookie 认证，跨域时在 URL 上附带 token。
 */
export function openLiveSocket(base: string, scope: string, ids: string[], handlers: LiveSocketHandlers): LiveSocket {
  const url = new URL('/api/ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('subscribe', scope)
  const jwt = getJwt()
  if (jwt && url.host !== location.host)
    url.searchParams.set('token', jwt)

  const socket = new WebSocket(url.toString())
  let pingTimer: ReturnType<typeof setInterval> | null = null

  socket.addEventListener('open', () => {
    if (scope === 'all')
      socket.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids: ids.slice(0, 500) }))
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
    }, WS_PING_INTERVAL_MS)
    handlers.onOpen?.()
  })
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string')
      return
    try {
      const message = JSON.parse(event.data) as { type?: string, updates?: CfsmServerUpdate[] }
      if (message?.type === 'batchUpdate' && Array.isArray(message.updates))
        handlers.onUpdates(message.updates)
    }
    catch (error) {
      console.warn('[cfsm] bad websocket frame', error)
    }
  })
  socket.addEventListener('close', (event) => {
    if (pingTimer)
      clearInterval(pingTimer)
    handlers.onClose?.(event)
  })

  return {
    close: () => {
      if (pingTimer)
        clearInterval(pingTimer)
      socket.close()
    },
  }
}

/** 按 sample.data || sample.payload || sample.metrics 读取增量字段 */
export function sampleData(sample: CfsmSample): Partial<CfsmServer> | null {
  const data = sample?.data || sample?.payload || sample?.metrics
  return data && typeof data === 'object' ? data : null
}
