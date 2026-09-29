/**
 * 主题内部使用的数据类型与数据访问接口
 *
 * 类型沿用主题原有的结构（节点信息 Client、实时状态 NodeStatus、历史记录等），
 * 数据全部来自 CF-Server-Monitor 的公开接口，转换逻辑见 ./cfsm.ts。
 */

import type { CfsmHistoryRow, ProbeSample } from '@/utils/cfsm'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import {
  ADMIN_HISTORY_HOURS,
  CfsmError,
  fetchHistory,
  getLatencyWindow,
  historyWindowFor,
  isLatencyWindowEnabled,
  mibToBytes,
  numOrNaN,
  parseGpuInfo,
  parseLoadAvg,
  probeName,
  PROBES,
  probeSamplesFromRow,
  PUBLIC_HISTORY_HOURS,
} from '@/utils/cfsm'

// ==================== 类型定义 ====================

export interface Client {
  uuid: string
  token?: string
  name: string
  cpu_name: string
  virtualization: string
  arch: string
  cpu_cores: number
  cpu_physical_cores?: number
  os: string
  kernel_version: string
  gpu_name?: string
  ipv4?: string
  ipv6?: string
  region: string
  remark?: string
  public_remark: string
  mem_total: number
  swap_total: number
  disk_total: number
  version?: string
  weight: number
  price: number
  billing_cycle: number
  auto_renewal: boolean
  currency: string
  expired_at: string
  group: string
  tags: string
  hidden: boolean
  traffic_limit: number
  traffic_limit_type: string
  created_at: string
  updated_at: string
}

/**
 * 单个 Ping 任务的最新探测汇总
 * 注意：该字段在 getNodesLatestStatus 响应中实际存在，但官方文档与旧类型定义遗漏，键为 task_id 字符串
 */
export interface NodeStatusPing {
  name: string
  /** 最新探测延迟（毫秒）；<0 表示丢包，与 PingRecord.value === -1 同义 */
  latest: number
  avg: number
  tail: number
  /** 丢包率（%） */
  loss: number
  min: number
  max: number
}

export interface GpuDetailedInfo {
  name?: string
  device_name?: string
  device_index?: number
  memory_total?: number
  memory_used?: number
  utilization?: number
  usage?: number
  temperature?: number
}

/** 节点状态 */
export interface NodeStatus {
  client: string
  time: string
  cpu: number
  gpu: number
  gpu_count?: number
  gpu_average_usage?: number
  gpu_detailed_info?: GpuDetailedInfo[]
  ram: number
  ram_total: number
  swap: number
  swap_total: number
  load: number
  load5: number
  load15: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  net_total_up: number
  net_total_down: number
  traffic_up?: number
  traffic_down?: number
  process: number
  connections: number
  connections_udp: number
  online: boolean
  uptime: number
  message?: string
  updated_at?: string
  /** 各 Ping 任务最新探测汇总，键为 task_id 字符串 */
  ping?: Record<string, NodeStatusPing>
}

/** 状态记录 */
export interface StatusRecord {
  client: string
  time: string
  cpu: number
  gpu: number
  gpu_count?: number
  gpu_average_usage?: number
  gpu_detailed_info?: GpuDetailedInfo[]
  ram: number
  ram_total: number
  swap: number
  swap_total: number
  load: number
  load5: number
  load15: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  /** 桶内最高网速（可选） */
  net_in_max?: number
  net_out_max?: number
  net_total_up: number
  net_total_down: number
  traffic_up?: number
  traffic_down?: number
  process: number
  connections: number
  connections_udp: number
}

/** Ping 记录 */
export interface PingRecord {
  client: string
  task_id: number
  time: string
  value: number
}

/** Ping 任务摘要 */
export interface PingTaskInfo {
  id: number
  weight?: number
  name: string
  interval: number
  loss: number
  default_on?: boolean
  clients?: string[]
  p99?: number
  p50?: number
  p99_p50_ratio?: number
  min?: number
  max?: number
  avg?: number
  latest?: number
  total?: number
  valid?: number
  stddev?: number
  loss_approximate?: boolean
  type?: string
}

export interface MetricDefinition {
  name: string
  description: string | Record<string, string>
  type: string
  unit?: string
  retention_days: number
  metadata?: Record<string, string>
  created_at?: string
  updated_at?: string
}

export interface MetricPoint {
  time: string
  value: number | null
  count?: number
  /** @deprecated legacy alias; prefer tags. */
  tag?: Record<string, unknown>
  tags?: Record<string, unknown>
  labels?: Record<string, unknown>
}

export interface MetricSeries {
  metric_key: string
  entity_id: string
  type?: string
  unit?: string
  retention_days?: number
  /** @deprecated legacy alias; prefer tags. */
  tag?: Record<string, unknown>
  tags?: Record<string, unknown>
  downsampled: boolean
  downsample_algorithm?: string
  fill_empty?: boolean
  max_points?: number
  interval_seconds?: number
  count: number
  points: MetricPoint[]
}

export interface MetricQueryParams {
  [key: string]: unknown
  metric_key?: string
  metric_keys?: string[]
  metrics?: string[]
  entity_id?: string
  entity_ids?: string[]
  start?: string | number
  start_time?: string | number
  end?: string | number
  end_time?: string | number
  hours?: number
  tags?: Record<string, unknown>
  downsample?: boolean
  server_downsample?: boolean
  downsample_by_metric?: Record<string, boolean>
  server_downsample_by_metric?: Record<string, boolean>
  fill_empty?: boolean
  max_points?: number
  downsample_points?: number
  max_points_by_metric?: Record<string, number>
  points_by_metric?: Record<string, number>
  aggregation?: string
  downsample_algorithm?: string
  algorithm?: string
  aggregation_by_metric?: Record<string, string>
  downsample_algorithm_by_metric?: Record<string, string>
  algorithm_by_metric?: Record<string, string>
}

export interface MetricQueryResponse {
  start: string
  end: string
  server_downsample_default?: boolean
  default_points?: number
  series: MetricSeries[]
  count: number
}

export interface PingMetricStatsParams {
  [key: string]: unknown
  uuid?: string
  entity_id?: string
  entity_ids?: string[]
  task_id?: string | number
  task_ids?: Array<string | number>
  start?: string | number
  start_time?: string | number
  end?: string | number
  end_time?: string | number
  hours?: number
  max_points?: number
  downsample_points?: number
}

export interface PingMetricTaskStats {
  entity_id: string
  task_id: string
  name?: string
  type?: string
  interval?: number
  tags: Record<string, unknown>
  total: number
  valid: number
  loss: number
  loss_approximate: boolean
  min?: number
  max?: number
  avg?: number
  latest?: number
  p50?: number
  p99?: number
  stddev?: number
  p99_p50_ratio?: number
}

export interface PingMetricStatsResponse {
  start: string
  end: string
  interval_seconds: number
  stats: PingMetricTaskStats[]
  count: number
}

/** RPC 错误 */
export class RpcError extends Error {
  code: number
  data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/** 方法不存在（与 JSON-RPC 的 -32601 一致），调用方据此回落到兼容路径 */
const METHOD_NOT_FOUND = -32601

function toRpcError(error: unknown): unknown {
  if (error instanceof CfsmError)
    return new RpcError(error.status, error.message)
  return error
}

// ==================== 节点上下文 ====================

/**
 * 历史记录里的总量字段可能缺失，用节点快照补齐；汇总查询需要知道当前可见的节点。
 * 由 init 在每次拿到快照时更新。
 */
interface NodeContext {
  mem_total: number
  swap_total: number
  disk_total: number
}

const nodeContext = new Map<string, NodeContext>()
let visibleNodeIds: string[] = []
let historyCeiling = PUBLIC_HISTORY_HOURS

export function updateNodeContext(statuses: Record<string, NodeStatus>, authed: boolean, replaceVisible = true): void {
  historyCeiling = authed ? ADMIN_HISTORY_HOURS : PUBLIC_HISTORY_HOURS
  if (replaceVisible)
    visibleNodeIds = Object.keys(statuses)
  for (const [uuid, status] of Object.entries(statuses)) {
    nodeContext.set(uuid, {
      mem_total: status.ram_total,
      swap_total: status.swap_total,
      disk_total: status.disk_total,
    })
    recordLiveSample(status)
  }
}

export function getHistoryCeilingHours(): number {
  return historyCeiling
}

// ==================== 实时采样缓冲 ====================

/**
 * 实时图表使用浏览器收到的每一个采样点（WebSocket 推送或轮询快照），
 * 刚打开页面、缓冲还不够时，用最近 1 小时的历史补齐。
 */
const LIVE_BUFFER_SIZE = 150
const liveSamples = new Map<string, StatusRecord[]>()

export function recordLiveSample(status: NodeStatus): void {
  if (!status.online || status.message === 'unavailable' || !status.time)
    return
  const buffer = liveSamples.get(status.client) ?? []
  const last = buffer.at(-1)
  if (last && last.time >= status.time)
    return
  buffer.push({
    client: status.client,
    time: status.time,
    cpu: status.cpu,
    gpu: status.gpu_count ? status.gpu : Number.NaN,
    ram: status.ram,
    ram_total: status.ram_total,
    swap: status.swap,
    swap_total: status.swap_total,
    load: status.load,
    load5: status.load5,
    load15: status.load15,
    temp: Number.NaN,
    disk: status.disk,
    disk_total: status.disk_total,
    net_in: status.net_in,
    net_out: status.net_out,
    net_total_up: status.net_total_up,
    net_total_down: status.net_total_down,
    traffic_up: status.traffic_up,
    traffic_down: status.traffic_down,
    process: status.process,
    connections: status.connections,
    connections_udp: status.connections_udp,
  })
  if (buffer.length > LIVE_BUFFER_SIZE)
    buffer.splice(0, buffer.length - LIVE_BUFFER_SIZE)
  liveSamples.set(status.client, buffer)
}

// ==================== 历史转换 ====================

/** CFSM 历史行 → 主题的状态记录；缺失的指标以 NaN 表示「没有数据」，图表会跳过 */
function rowToStatusRecord(uuid: string, row: CfsmHistoryRow): StatusRecord {
  const context = nodeContext.get(uuid)
  const [load1, load5, load15] = parseLoadAvg(row.load_avg)
  const gpuUsages = parseGpuInfo(row.gpu_info).map(gpu => gpu.info).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return {
    client: uuid,
    time: new Date(row.timestamp).toISOString(),
    cpu: numOrNaN(row.cpu),
    gpu: gpuUsages.length ? gpuUsages.reduce((sum, v) => sum + v, 0) / gpuUsages.length : Number.NaN,
    ram: mibToBytes(row.ram_used, Number.NaN),
    ram_total: mibToBytes(row.ram_total, context?.mem_total ?? 0),
    swap: mibToBytes(row.swap_used, Number.NaN),
    swap_total: mibToBytes(row.swap_total, context?.swap_total ?? 0),
    load: load1,
    load5,
    load15,
    temp: Number.NaN,
    disk: mibToBytes(row.disk_used, Number.NaN),
    disk_total: mibToBytes(row.disk_total, context?.disk_total ?? 0),
    net_in: numOrNaN(row.net_in_speed),
    net_out: numOrNaN(row.net_out_speed),
    net_total_up: Number.NaN,
    net_total_down: Number.NaN,
    process: numOrNaN(row.processes),
    connections: numOrNaN(row.tcp_conn),
    connections_udp: numOrNaN(row.udp_conn),
  }
}

interface ResolvedRange {
  /** 请求 /api/history/all 使用的档位 */
  window: number
  from: number
  to: number
}

/** CFSM 只接受「最近 N 小时」的固定档位：取覆盖所需时段的最小档位，再裁剪到所需时段 */
function resolveRange(params: { hours?: number, start?: string | number, start_time?: string | number, end?: string | number, end_time?: string | number }): ResolvedRange {
  const startValue = params.start ?? params.start_time
  const endValue = params.end ?? params.end_time
  const now = Date.now()
  if (startValue !== undefined) {
    const from = new Date(startValue).getTime()
    const to = endValue !== undefined ? new Date(endValue).getTime() : now
    if (Number.isFinite(from)) {
      return {
        window: historyWindowFor((now - from) / 3_600_000, historyCeiling),
        from,
        to: Number.isFinite(to) ? to : now,
      }
    }
  }
  const hours = Math.min(historyCeiling, Math.max(0.167, params.hours ?? 6))
  return { window: historyWindowFor(hours, historyCeiling), from: now - hours * 3_600_000, to: now }
}

async function loadHistoryRows(uuid: string, range: ResolvedRange, signal?: AbortSignal): Promise<CfsmHistoryRow[]> {
  const rows = await fetchHistory(uuid, range.window, signal)
  return rows.filter(row => row.timestamp >= range.from && row.timestamp <= range.to)
}

/** 已见过的探测路线，按固定顺序（三网、BGP、自定义节点）排列 */
const seenProbeTasks = new Set<number>()

function rememberProbeSamples(samples: ProbeSample[]): void {
  for (const sample of samples)
    seenProbeTasks.add(sample.taskId)
}

/**
 * 延迟数据。首页卡片的延迟小图（max_points 不超过摘要点数）直接使用 /api/servers 附带的
 * 2 小时窗口，不为每张卡片单独查询历史；后台关闭三网详情时窗口为空，卡片不显示延迟小图。
 * 详情页图表按所选时段读取历史。
 */
async function loadProbeSamples(uuid: string, range: ResolvedRange, maxPoints: number | undefined, signal?: AbortSignal): Promise<ProbeSample[]> {
  let samples: ProbeSample[]
  if (maxPoints !== undefined && maxPoints <= PING_SUMMARY_MAX_COUNT) {
    samples = isLatencyWindowEnabled() ? (getLatencyWindow(uuid) ?? []) : []
    samples = samples.filter(sample => sample.ts >= range.from && sample.ts <= range.to)
  }
  else {
    const rows = await loadHistoryRows(uuid, range, signal)
    samples = rows.flatMap(row => probeSamplesFromRow(row, row.timestamp))
  }
  rememberProbeSamples(samples)
  return samples
}

function samplesToRecords(uuid: string, samples: ProbeSample[]): PingRecord[] {
  return samples.map(sample => ({
    client: uuid,
    task_id: sample.taskId,
    time: new Date(sample.ts).toISOString(),
    value: sample.latency ?? -1,
  }))
}

function groupByTask(samples: ProbeSample[]): Map<number, ProbeSample[]> {
  const byTask = new Map<number, ProbeSample[]>()
  for (const sample of samples) {
    const list = byTask.get(sample.taskId) ?? []
    list.push(sample)
    byTask.set(sample.taskId, list)
  }
  return new Map([...byTask.entries()].sort((a, b) => a[0] - b[0]))
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length)
    return undefined
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const a = sorted[lower]!
  const b = sorted[upper]!
  return a + (b - a) * (position - lower)
}

function pingStatsFor(uuid: string, samples: ProbeSample[]): PingMetricTaskStats[] {
  return Array.from(groupByTask(samples).entries(), ([taskId, rows]) => {
    const latencies = rows.map(row => row.latency).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    const sorted = [...latencies].sort((a, b) => a - b)
    const avg = latencies.length ? latencies.reduce((sum, v) => sum + v, 0) / latencies.length : undefined
    const stddev = avg !== undefined && latencies.length
      ? Math.sqrt(latencies.reduce((sum, v) => sum + (v - avg) ** 2, 0) / latencies.length)
      : undefined
    const p50 = percentile(sorted, 0.5)
    const p99 = percentile(sorted, 0.99)
    const latest = [...rows].reverse().find(row => typeof row.latency === 'number')?.latency ?? undefined
    return {
      entity_id: uuid,
      task_id: String(taskId),
      name: probeName(taskId),
      tags: { task_id: String(taskId) },
      total: rows.length,
      valid: latencies.length,
      // 探针每轮上报的丢包率按时间平均
      loss: rows.length ? rows.reduce((sum, row) => sum + row.loss, 0) / rows.length : 0,
      loss_approximate: false,
      min: sorted[0],
      max: sorted.at(-1),
      avg,
      latest: latest ?? undefined,
      p50,
      p99,
      stddev,
      p99_p50_ratio: p50 && p99 ? p99 / p50 : undefined,
    }
  })
}

const PING_LATENCY_KEY = 'ping.latency_ms'
const PING_LOSS_KEY = 'ping.loss'

// ==================== 数据访问 ====================

export class CfsmRpc {
  /** 单节点最近的状态：实时缓冲 + 最近 1 小时历史 */
  async getNodeRecentStatus(uuid: string): Promise<{ count: number, records: StatusRecord[] }> {
    const live = liveSamples.get(uuid) ?? []
    let records = [...live]
    if (live.length < LIVE_BUFFER_SIZE) {
      try {
        const rows = await loadHistoryRows(uuid, resolveRange({ hours: 1 }))
        const firstLive = live[0]?.time
        const older = rows.map(row => rowToStatusRecord(uuid, row)).filter(record => !firstLive || record.time < firstLive)
        records = [...older, ...live].slice(-LIVE_BUFFER_SIZE)
      }
      catch (error) {
        if (!live.length)
          throw toRpcError(error)
      }
    }
    return { count: records.length, records }
  }

  /** 负载历史。未指定节点时逐个查询当前可见节点（经过并发队列） */
  async getLoadRecords(uuid?: string, hours = 6, _loadType?: string, _maxCount?: number, signal?: AbortSignal): Promise<{ records: StatusRecord[] | Record<string, StatusRecord[]> }> {
    const range = resolveRange({ hours })
    const ids = uuid ? [uuid] : visibleNodeIds
    try {
      const entries = await Promise.all(ids.map(async (id) => {
        const rows = await loadHistoryRows(id, range, signal)
        return [id, rows.map(row => rowToStatusRecord(id, row))] as const
      }))
      if (uuid)
        return { records: entries[0]?.[1] ?? [] }
      return { records: Object.fromEntries(entries) }
    }
    catch (error) {
      throw toRpcError(error)
    }
  }

  /** 延迟历史（兼容路径） */
  async getPingRecords(taskId?: number, hours = 6, maxCount?: number, signal?: AbortSignal, uuid?: string): Promise<{ records: PingRecord[], tasks?: PingTaskInfo[] }> {
    const range = resolveRange({ hours })
    const ids = uuid ? [uuid] : visibleNodeIds
    try {
      const results = await Promise.all(ids.map(async id => [id, await loadProbeSamples(id, range, maxCount, signal)] as const))
      const records: PingRecord[] = []
      const taskMap = new Map<number, PingTaskInfo>()
      for (const [id, samples] of results) {
        const rows = taskId === undefined ? samples : samples.filter(sample => sample.taskId === taskId)
        records.push(...samplesToRecords(id, rows))
        for (const stat of pingStatsFor(id, samples)) {
          const numericId = Number(stat.task_id)
          if (!taskMap.has(numericId))
            taskMap.set(numericId, { id: numericId, name: stat.name ?? probeName(numericId), interval: 0, loss: stat.loss })
        }
      }
      return { records, tasks: [...taskMap.values()].sort((a, b) => a.id - b.id) }
    }
    catch (error) {
      throw toRpcError(error)
    }
  }

  /** 已出现过数据的探测路线（名称来自后台设置的三网 / 节点显示名） */
  async getPublicPingTasks(): Promise<PingTaskInfo[]> {
    return PROBES
      .filter(probe => seenProbeTasks.has(probe.taskId))
      .map(probe => ({ id: probe.taskId, weight: probe.taskId, name: probeName(probe.taskId), interval: 0, loss: 0 }))
  }

  /** 指标目录：CFSM 的历史里有每路探测的延迟和丢包，对应主题的 ping 指标 */
  async listPublicMetricDefinitions(): Promise<MetricDefinition[]> {
    return [
      { name: PING_LATENCY_KEY, description: '延迟', type: 'gauge', unit: 'ms', retention_days: 0 },
      { name: PING_LOSS_KEY, description: '丢包率', type: 'gauge', unit: 'ratio', retention_days: 0 },
    ]
  }

  /** 指标查询：只支持延迟相关的两个 key，其他 key 没有序列，调用方会回落到负载历史 */
  async queryPublicMetrics(params: MetricQueryParams, signal?: AbortSignal): Promise<MetricQueryResponse> {
    const keys = new Set([...(params.metric_keys ?? []), ...(params.metrics ?? []), ...(params.metric_key ? [params.metric_key] : [])])
    const wantsLatency = keys.has(PING_LATENCY_KEY)
    const wantsLoss = keys.has(PING_LOSS_KEY)
    const entity = params.entity_id ?? params.entity_ids?.[0]
    if (!entity || (!wantsLatency && !wantsLoss))
      throw new RpcError(METHOD_NOT_FOUND, 'metric not available')

    const range = resolveRange(params)
    let samples: ProbeSample[]
    try {
      samples = await loadProbeSamples(entity, range, params.max_points ?? params.downsample_points, signal)
    }
    catch (error) {
      throw toRpcError(error)
    }

    const series: MetricSeries[] = []
    for (const [taskId, rows] of groupByTask(samples)) {
      const tags = { task_id: String(taskId), name: probeName(taskId) }
      if (wantsLatency) {
        series.push({
          metric_key: PING_LATENCY_KEY,
          entity_id: entity,
          unit: 'ms',
          tags,
          downsampled: true,
          count: rows.length,
          points: rows.map(row => ({ time: new Date(row.ts).toISOString(), value: row.latency })),
        })
      }
      if (wantsLoss) {
        series.push({
          metric_key: PING_LOSS_KEY,
          entity_id: entity,
          unit: 'ratio',
          tags,
          downsampled: true,
          count: rows.length,
          // CFSM 的丢包是百分比，主题的 ping.loss 是 0-1 比例
          points: rows.map(row => ({ time: new Date(row.ts).toISOString(), value: row.loss / 100, count: 1 })),
        })
      }
    }

    return {
      start: new Date(range.from).toISOString(),
      end: new Date(range.to).toISOString(),
      series,
      count: series.length,
    }
  }

  /** 每路探测在窗口内的统计 */
  async getPublicPingMetricStats(params: PingMetricStatsParams, signal?: AbortSignal): Promise<PingMetricStatsResponse> {
    const entity = params.uuid ?? params.entity_id ?? params.entity_ids?.[0]
    if (!entity)
      throw new RpcError(METHOD_NOT_FOUND, 'ping stats need a node')
    const range = resolveRange(params)
    let samples: ProbeSample[]
    try {
      samples = await loadProbeSamples(entity, range, params.max_points ?? params.downsample_points, signal)
    }
    catch (error) {
      throw toRpcError(error)
    }
    const stats = pingStatsFor(entity, samples)
    return {
      start: new Date(range.from).toISOString(),
      end: new Date(range.to).toISOString(),
      interval_seconds: 60,
      stats,
      count: stats.length,
    }
  }
}

// 单例实例
let sharedRpc: CfsmRpc | null = null

export function getSharedRpc(): CfsmRpc {
  if (!sharedRpc)
    sharedRpc = new CfsmRpc()
  return sharedRpc
}
