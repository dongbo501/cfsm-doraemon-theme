/**
 * 应用初始化与实时数据
 *
 * 启动：GET /api/config（必要时先完成 Turnstile 验证）→ 按当前页面取数据：
 *   首页   GET /api/servers，WebSocket subscribe=all 并通过通道提交服务器 ID
 *   详情页 GET /api/server?id=，WebSocket subscribe=<id>
 * 选择 HTTP 轮询时按同样的页面范围轮询。
 *
 * 页面进入后台时关闭连接、保留最后一次数据；回到前台先补一次 REST 数据再恢复实时更新。
 * 后台设置了实时连接时长上限时，到时关闭连接，由访客选择是否继续。
 */

import type { CfsmServer, CfsmServerUpdate, LiveSocket } from '@/utils/cfsm'
import { toast } from 'vue-sonner'
import { REALTIME_CONFIG } from '@/constants/realtime'
import router from '@/router'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getSharedApi } from '@/utils/api'
import {
  appendLatencySample,
  baseForServer,
  CfsmError,
  cfsmServerToClient,
  cfsmServerToStatus,
  fetchAllServers,
  fetchServer,
  getApiBases,
  openLiveSocket,
  rememberLatencyWindows,
  sampleData,
  serversToMaps,
} from '@/utils/cfsm'
import { recordLiveSample, updateNodeContext } from '@/utils/rpc'

const WS_RECONNECT_INTERVAL_MS = REALTIME_CONFIG.websocket.reconnectInterval
const WS_MAX_RECONNECT_ATTEMPTS = REALTIME_CONFIG.websocket.maxReconnectAttempts
const POST_FAILURE_THRESHOLD = REALTIME_CONFIG.polling.postFailureThreshold
/** 没有新上报时也定期重算在线状态，让停止上报的服务器按时显示为离线 */
const ONLINE_RECHECK_MS = 30_000
const WS_TIMEOUT_TOAST_ID = 'cfsm-ws-timeout'

type Scope = { type: 'home' } | { type: 'detail', id: string }

function scopeKey(scope: Scope): string {
  return scope.type === 'home' ? 'home' : `detail:${scope.id}`
}

function currentScope(): Scope {
  const route = router.currentRoute.value
  const id = route.name === 'instance-detail' ? route.params.id : undefined
  if (typeof id === 'string' && id)
    return { type: 'detail', id }
  return { type: 'home' }
}

class InitManager {
  private appStore = useAppStore()
  private nodesStore = useNodesStore()
  private servers = new Map<string, CfsmServer>()
  /** 已经拉过完整列表（首页数据） */
  private hasFullList = false
  private scope: Scope = { type: 'home' }
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private onlineTimer: ReturnType<typeof setInterval> | null = null
  private sockets: LiveSocket[] = []
  private socketGeneration = 0
  private useWebSocket = false
  private isPolling = false
  private destroyed = false
  private isInitialized = false
  private failureCount = 0
  /** 实时连接达到时长上限后暂停，等访客选择继续 */
  private pausedByTimeout = false
  private removeRouteHook: (() => void) | null = null

  private readonly handleVisibility = (): void => {
    if (!this.isInitialized || this.destroyed)
      return
    if (document.visibilityState === 'hidden') {
      this.stopRealtime()
      return
    }
    if (!this.pausedByTimeout)
      void this.resume()
  }

  async init(): Promise<void> {
    this.destroyed = false
    if (this.isInitialized)
      return

    try {
      const ready = await this.runStartupRequests()
      if (this.destroyed || !ready)
        return
      this.isInitialized = true
      this.startRealtime()
      this.onlineTimer = setInterval(() => this.recheckOnline(), ONLINE_RECHECK_MS)
      document.addEventListener('visibilitychange', this.handleVisibility)
      this.removeRouteHook = router.afterEach(() => {
        void this.onRouteChange()
      })
    }
    catch (error) {
      console.error('[InitManager] Initialization failed:', error)
      this.appStore.connectionError = true
      throw error
    }
    finally {
      this.appStore.loading = false
    }
  }

  /** 读取站点配置和当前页面的数据；站点未公开且未登录时返回 false */
  private async runStartupRequests(): Promise<boolean> {
    const api = getSharedApi()
    let config
    try {
      config = await api.getConfig(true)
    }
    catch (error) {
      console.error('[InitManager] Failed to load /api/config:', error)
      this.appStore.connectionError = true
      return false
    }
    this.appStore.publicSettings = await api.getPublicSettings()
    this.appStore.updateLoginState(config.authorization === true, {
      logged_in: config.authorization === true,
      username: config.authorization ? '站长' : '',
    })

    if (config.is_public === false && !config.authorization) {
      this.appStore.accessDenied = true
      return false
    }
    this.appStore.accessDenied = false

    // 直接打开详情页时，要等初始路由解析完才能知道只需要单台服务器
    await router.isReady()
    this.scope = currentScope()
    const ok = await this.refreshScope(true)
    if (ok) {
      this.appStore.connectionError = false
      this.failureCount = 0
    }
    return true
  }

  async retry(): Promise<boolean> {
    if (this.destroyed)
      return false
    if (!this.isInitialized) {
      await this.init()
      return this.isInitialized && !this.appStore.connectionError
    }
    const ok = await this.refreshScope()
    if (ok) {
      this.appStore.connectionError = false
      // 之前的失败可能让实时连接没有建立（没有服务器 ID 可订阅），恢复后重新建立
      if (!this.pausedByTimeout) {
        this.stopRealtime()
        this.startRealtime()
      }
    }
    return ok
  }

  // ==================== REST 数据 ====================

  /** 按当前页面补一次 REST 数据 */
  private async refreshScope(initial = false): Promise<boolean> {
    try {
      if (this.scope.type === 'home')
        await this.loadAllServers(initial)
      else
        await this.loadSingleServer(this.scope.id, initial)
      return true
    }
    catch (error) {
      this.handleRequestError(error, initial)
      return false
    }
  }

  private handleRequestError(error: unknown, initial: boolean): void {
    if (error instanceof CfsmError && error.status === 401) {
      // 登录已失效或站点改为非公开
      this.appStore.updateLoginState(false)
      if (this.appStore.publicSettings?.public_page === false) {
        this.appStore.accessDenied = true
        this.stopRealtime()
        return
      }
    }
    console.error('[InitManager] Request failed:', error)
    if (initial)
      this.appStore.connectionError = true
  }

  private async loadAllServers(initial: boolean): Promise<void> {
    const snapshot = await fetchAllServers()
    if (this.destroyed)
      return
    rememberLatencyWindows(snapshot)
    this.servers = new Map(snapshot.servers.map(server => [server.id, server]))
    const { clients, statuses } = serversToMaps(snapshot.servers)
    this.seedLiveSamples(snapshot.updates)
    updateNodeContext(statuses, this.appStore.isLoggedIn)
    if (initial || !this.hasFullList) {
      this.nodesStore.initNodes(clients, statuses)
    }
    else {
      this.nodesStore.updateNodeClients(clients)
      this.nodesStore.updateNodeStatuses(statuses)
    }
    this.hasFullList = true
  }

  private async loadSingleServer(id: string, initial: boolean): Promise<void> {
    let server: CfsmServer
    try {
      server = await fetchServer(id)
    }
    catch (error) {
      // 服务器不存在或已隐藏：交给详情页显示「找不到」
      if (error instanceof CfsmError && error.status === 404) {
        if (initial)
          this.nodesStore.initNodes({}, {})
        return
      }
      throw error
    }
    if (this.destroyed)
      return
    const { latestReportUpdates, ...rest } = server
    const merged: CfsmServer = { ...(this.servers.get(id) ?? {}), ...rest, id }
    this.servers.set(id, merged)
    const { clients, statuses } = serversToMaps([merged])
    this.seedLiveSamples(Array.isArray(latestReportUpdates) ? latestReportUpdates as CfsmServerUpdate[] : [])
    updateNodeContext(statuses, this.appStore.isLoggedIn, !this.hasFullList)
    if (initial && !this.hasFullList)
      this.nodesStore.initNodes(clients, statuses)
    else
      this.nodesStore.upsertNodes(clients, statuses)
  }

  /** REST 响应附带的最近上报样本，用来预热实时图表 */
  private seedLiveSamples(updates: CfsmServerUpdate[]): void {
    for (const update of updates) {
      const server = this.servers.get(String(update?.serverId))
      if (!server || !Array.isArray(update.samples))
        continue
      for (const sample of update.samples) {
        const data = sampleData(sample)
        const ts = Number(sample.ts ?? sample.timestamp)
        if (!data || !Number.isFinite(ts) || ts <= 0)
          continue
        recordLiveSample(cfsmServerToStatus({ ...server, ...data, id: server.id, last_updated: ts }, ts))
      }
    }
  }

  // ==================== 实时推送 ====================

  private applyUpdates(updates: CfsmServerUpdate[]): void {
    const now = Date.now()
    const clients: Record<string, ReturnType<typeof cfsmServerToClient>> = {}
    const statuses: Record<string, ReturnType<typeof cfsmServerToStatus>> = {}
    for (const update of updates) {
      const id = String(update?.serverId ?? '')
      const server = this.servers.get(id)
      if (!server || !Array.isArray(update.samples))
        continue
      const samples = update.samples
        .map(sample => ({ data: sampleData(sample), ts: Number(sample.ts ?? sample.timestamp) || now }))
        .filter((sample): sample is { data: Partial<CfsmServer>, ts: number } => !!sample.data)
        .sort((a, b) => a.ts - b.ts)
      if (!samples.length)
        continue
      for (const sample of samples) {
        Object.assign(server, sample.data, { id })
        // 每个采样点都进实时图表，时间用采样时间
        recordLiveSample(cfsmServerToStatus({ ...server, last_updated: sample.ts }, sample.ts))
        appendLatencySample(id, sample.data, sample.ts)
      }
      // 在线判断以浏览器收到推送的时间为准，与默认主题一致
      server.last_updated = now
      clients[id] = cfsmServerToClient(server)
      statuses[id] = cfsmServerToStatus(server, now)
    }
    if (Object.keys(statuses).length) {
      this.nodesStore.upsertNodes(clients, statuses)
      this.failureCount = 0
      this.appStore.connectionError = false
    }
  }

  private recheckOnline(): void {
    if (!this.servers.size)
      return
    const now = Date.now()
    const statuses = Object.fromEntries(Array.from(this.servers.values(), server => [server.id, cfsmServerToStatus(server, now)]))
    this.nodesStore.updateNodeStatuses(statuses)
  }

  private startRealtime(): void {
    if (this.destroyed || this.pausedByTimeout || this.appStore.accessDenied)
      return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      return
    this.useWebSocket = this.appStore.rpcTransportMode === 'websocket' && typeof WebSocket !== 'undefined'
    if (this.useWebSocket)
      this.connectWebSocket()
    else
      this.schedulePoll()
  }

  private stopRealtime(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer)
      this.sessionTimer = null
    }
    this.closeSockets()
    this.nodesStore.updateWsState('disconnected', 0)
  }

  private closeSockets(): void {
    this.socketGeneration += 1
    const sockets = this.sockets
    this.sockets = []
    for (const socket of sockets)
      socket.close()
  }

  /** 回到前台或继续连接：先补一次 REST 数据，再恢复实时更新 */
  private async resume(): Promise<void> {
    this.stopRealtime()
    await this.refreshScope()
    this.startRealtime()
  }

  private async onRouteChange(): Promise<void> {
    const next = currentScope()
    if (scopeKey(next) === scopeKey(this.scope) || this.appStore.accessDenied)
      return
    this.scope = next
    this.stopRealtime()
    await this.refreshScope()
    if (scopeKey(next) === scopeKey(this.scope) && !this.pausedByTimeout)
      this.startRealtime()
  }

  private connectWebSocket(): void {
    if (this.destroyed || !this.useWebSocket)
      return

    this.closeSockets()
    const generation = this.socketGeneration
    const targets: Array<{ base: string, scope: string, ids: string[] }> = []
    if (this.scope.type === 'detail') {
      targets.push({ base: baseForServer(this.scope.id), scope: this.scope.id, ids: [] })
    }
    else {
      // 多站模式：每个后端只提交它自己返回的服务器 ID
      for (const base of getApiBases()) {
        const ids = [...this.servers.keys()].filter(id => baseForServer(id) === base)
        if (ids.length)
          targets.push({ base, scope: 'all', ids })
      }
    }
    if (!targets.length)
      return

    this.nodesStore.updateWsState('connecting', this.nodesStore.wsReconnectAttempts)
    let opened = 0
    let closed = false
    this.sockets = targets.map(target => openLiveSocket(target.base, target.scope, target.ids, {
      onOpen: () => {
        if (generation !== this.socketGeneration)
          return
        opened += 1
        if (opened === 1) {
          this.nodesStore.updateWsState('connected', 0)
          this.appStore.connectionError = false
          this.startSessionTimer()
        }
      },
      onUpdates: (updates) => {
        if (generation === this.socketGeneration)
          this.applyUpdates(updates)
      },
      onClose: () => {
        if (generation !== this.socketGeneration || closed || this.destroyed || !this.useWebSocket)
          return
        closed = true
        this.closeSockets()
        if (this.sessionTimer) {
          clearTimeout(this.sessionTimer)
          this.sessionTimer = null
        }
        // 登录失效或站点改为非公开时服务端会拒绝连接，重新确认一次登录状态
        void getSharedApi().getMe().then(me => this.appStore.updateLoginState(me.logged_in, me)).catch(() => {})
        this.nodesStore.updateWsState('disconnected')
        this.scheduleReconnect(opened > 0)
      },
    }))
  }

  /** 后台设置了单次连接时长上限：到时关闭连接，由访客明确选择是否继续 */
  private startSessionTimer(): void {
    const minutes = this.appStore.publicSettings?.ws_timeout_minutes ?? 0
    if (this.sessionTimer)
      clearTimeout(this.sessionTimer)
    this.sessionTimer = null
    if (!minutes)
      return
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null
      this.pauseForTimeout()
    }, minutes * 60_000)
  }

  private pauseForTimeout(): void {
    this.pausedByTimeout = true
    this.stopRealtime()
    toast.info('任意门已休息：实时连接达到站点设置的时长上限', {
      id: WS_TIMEOUT_TOAST_ID,
      description: '当前显示的是最后一次收到的数据。',
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: '继续实时更新',
        onClick: () => {
          this.pausedByTimeout = false
          void this.resume()
        },
      },
    })
  }

  private scheduleReconnect(wasOpen: boolean): void {
    if (this.destroyed || this.reconnectTimer)
      return

    const attempts = wasOpen ? 0 : this.nodesStore.wsReconnectAttempts
    if (attempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      this.fallbackToPolling()
      return
    }
    if (attempts === 0 && !wasOpen)
      window.$message?.error('WebSocket 建立失败，正在尝试重连。')

    const next = attempts + 1
    this.nodesStore.updateWsState('reconnecting', next)
    const backoff = Math.min(WS_RECONNECT_INTERVAL_MS * 2 ** Math.max(0, next - 1), 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectWebSocket()
    }, backoff)
  }

  private fallbackToPolling(): void {
    console.error('[InitManager] WebSocket unavailable, falling back to HTTP polling')
    this.useWebSocket = false
    this.nodesStore.updateWsState('disconnected', WS_MAX_RECONNECT_ATTEMPTS)
    window.$message?.warning('WebSocket 无法连接，已改用 HTTP 轮询。')
    this.schedulePoll()
  }

  private schedulePoll(): void {
    if (this.pollTimer)
      clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      await this.poll()
      if (!this.destroyed && !this.useWebSocket && !this.pausedByTimeout && document.visibilityState !== 'hidden')
        this.schedulePoll()
    }, this.appStore.dataUpdateInterval * 1000)
  }

  private async poll(): Promise<void> {
    if (this.isPolling)
      return
    this.isPolling = true
    try {
      const ok = await this.refreshScope()
      if (ok) {
        this.failureCount = 0
        this.appStore.connectionError = false
      }
      else {
        this.failureCount += 1
        this.appStore.connectionError = this.failureCount >= POST_FAILURE_THRESHOLD
      }
    }
    finally {
      this.isPolling = false
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopRealtime()
    this.useWebSocket = false
    if (this.onlineTimer) {
      clearInterval(this.onlineTimer)
      this.onlineTimer = null
    }
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.removeRouteHook?.()
    this.removeRouteHook = null
    toast.dismiss(WS_TIMEOUT_TOAST_ID)
    this.nodesStore.clearNodes()
    this.servers.clear()
    this.hasFullList = false
    this.isInitialized = false
  }
}

let initManager: InitManager | null = null

export async function initApp(): Promise<void> {
  if (!initManager)
    initManager = new InitManager()
  await initManager.init()
}

export async function retryInitApp(): Promise<boolean> {
  if (!initManager)
    initManager = new InitManager()
  return initManager.retry()
}

export function destroyInitManager(): void {
  if (initManager) {
    initManager.destroy()
    initManager = null
  }
}
