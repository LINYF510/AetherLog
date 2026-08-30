/**
 * 剪贴板轮询监听服务（MVP 主力实现，对齐 ADR-004）
 *
 * 核心机制：
 * - setInterval 轮询（默认 200ms，可配置）+ 焦点补采集（window focus / workspace 事件）
 * - 内容哈希去重：TTL 窗口内（默认 30 分钟）相同哈希直接丢弃（需求 R1）
 * - 关键字黑名单：正则数组命中即丢弃
 * - 错误矩阵 C01：读取失败 → 降级 1000ms 重试；连续失败 10 次 → 自动停止 + 发出错误事件
 *
 * Obsidian 沙箱限制（对齐架构文档 ADR-004 理由）：无法调用 Win32 剪贴板事件钩子，只能轮询；
 * navigator.clipboard.readText() 在文档失焦时可能被 Chromium 拦截，因此降级链兜底为
 * Electron clipboard.readText()（不受焦点限制）。
 */
import { EventEmitter } from 'events'
import type { App, EventRef } from 'obsidian'
import type { CaptureRecord } from '../types/capture.types'
import type { ClipboardListenerConfig, IClipboardListener } from '../types/clipboard.types'
import { classifyContent } from '../utils/content-classifier'
import { resolveAppName } from '../utils/app-name-resolver'
import { nowIso } from '../utils/date-utils'
import { computeHash, generateRecordId } from '../utils/hash-utils'

/** 连续读取失败达到该次数后自动停止监听并发出错误（对齐架构文档错误矩阵 C01） */
const MAX_CONSECUTIVE_READ_ERRORS = 10

/** 错误降级期间的轮询间隔（毫秒） */
const DEGRADED_POLL_INTERVAL_MS = 1000

/** Electron clipboard 模块最小结构类型（仅声明用到的只读成员，避免 any） */
interface ElectronClipboardLike {
  readText(): string
}

/** window.require 的最小类型 */
type WindowRequire = (id: string) => unknown

/**
 * 安全获取 Electron clipboard 模块（沙箱/移动端不支持时返回 null）
 * @returns clipboard 对象或 null
 */
function getElectronClipboard(): ElectronClipboardLike | null {
  try {
    const requireFn = (window as Window & { require?: WindowRequire }).require
    if (typeof requireFn !== 'function') return null
    const electron = requireFn('electron')
    if (typeof electron === 'object' && electron !== null) {
      const clipboard = (electron as { clipboard?: ElectronClipboardLike }).clipboard
      return clipboard ?? null
    }
    return null
  } catch {
    return null
  }
}

/**
 * 编译黑名单正则数组（非法正则降级为字面量子串匹配，避免单条脏数据拖垮整个监听）
 * @param patterns 用户配置的正则字符串数组
 * @returns 编译后的 RegExp 数组
 */
function compileBlacklistPatterns(patterns: readonly string[]): RegExp[] {
  const regexps: RegExp[] = []
  for (const pattern of patterns) {
    try {
      regexps.push(new RegExp(pattern))
    } catch {
      regexps.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  }
  return regexps
}

/**
 * 剪贴板轮询监听器
 *
 * @example
 * const listener = new ClipboardListener(app, { pollIntervalMs: 200, ... })
 * listener.on('capture', (record) => console.log(record.contentType))
 * await listener.start()
 */
export class ClipboardListener extends EventEmitter implements IClipboardListener {
  private readonly app: App
  private readonly config: ClipboardListenerConfig
  private readonly blacklistRegexps: RegExp[]
  /** 内容哈希 → 上次见到的时间戳（毫秒），TTL 去重缓存 */
  private readonly hashLastSeen = new Map<string, number>()
  private intervalId: ReturnType<typeof setInterval> | null = null
  private workspaceEventRef: EventRef | null = null
  private readonly windowFocusHandler = (): void => {
    void this.checkOnce()
  }
  private running = false
  /** 上一次 pollClipboard 尚未完成时不启动下一次（轮询节流，对齐架构文档 §6.1） */
  private inFlight = false
  /** 是否处于错误降级（1000ms 慢轮询）状态 */
  private degraded = false
  private consecutiveReadErrors = 0
  /** 上一帧剪贴板内容（帧间比对） */
  private lastClipboardText = ''
  /** 上次焦点补采集触发时间（防抖） */
  private lastFocusCheckAt = 0

  /**
   * @param app Obsidian App 实例（用于 workspace 事件注册）
   * @param config 监听配置（间隔/焦点补采/黑名单/去重 TTL）
   */
  constructor(app: App, config: ClipboardListenerConfig) {
    super()
    this.app = app
    this.config = config
    this.blacklistRegexps = compileBlacklistPatterns(config.blacklistPatterns)
  }

  // ------------------------------------------------------------
  // 事件 API（类型化重载，避免使用方落入 any 推断）
  // ------------------------------------------------------------

  public on(event: 'capture', listener: (record: CaptureRecord) => void): this
  public on(event: 'error', listener: (error: Error) => void): this
  public on(event: string | symbol, listener: (...args: unknown[]) => void): this
  public on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  public off(event: 'capture', listener: (record: CaptureRecord) => void): this
  public off(event: 'error', listener: (error: Error) => void): this
  public off(event: string | symbol, listener: (...args: unknown[]) => void): this
  public off(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }

  public emit(event: 'capture', record: CaptureRecord): boolean
  public emit(event: 'error', error: Error): boolean
  public emit(event: string | symbol, ...args: unknown[]): boolean
  public emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args)
  }

  // ------------------------------------------------------------
  // 生命周期 API（实现 IClipboardListener）
  // ------------------------------------------------------------

  /**
   * 开始监听：建立剪贴板基线快照（不触发 capture）→ 启动轮询 → 注册焦点补采集
   */
  public async start(): Promise<void> {
    if (this.running) return
    this.running = true
    // 基线快照：记录启动时剪贴板已有内容，避免把历史内容当作新捕获
    try {
      this.lastClipboardText = await this.readClipboardText()
    } catch {
      this.lastClipboardText = ''
    }
    this.consecutiveReadErrors = 0
    this.setPollInterval(this.config.pollIntervalMs)
    if (this.config.focusSupplementary) {
      this.workspaceEventRef = this.app.workspace.on('active-leaf-change', this.windowFocusHandler)
      window.addEventListener('focus', this.windowFocusHandler)
    }
  }

  /**
   * 停止监听：清理定时器、workspace 事件与 window 焦点监听，并移除全部事件回调
   */
  public async stop(): Promise<void> {
    this.running = false
    this.inFlight = false
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.workspaceEventRef !== null) {
      this.app.workspace.offref(this.workspaceEventRef)
      this.workspaceEventRef = null
    }
    window.removeEventListener('focus', this.windowFocusHandler)
    this.removeAllListeners()
  }

  /** 当前是否正在监听 */
  public isRunning(): boolean {
    return this.running
  }

  /**
   * 主动检查一次剪贴板（焦点补采集场景），带 focusWindowMs 防抖
   */
  public async checkOnce(): Promise<void> {
    if (!this.running) return
    const now = Date.now()
    if (now - this.lastFocusCheckAt < this.config.focusWindowMs) return
    this.lastFocusCheckAt = now
    await this.pollClipboard()
  }

  /**
   * 当前连续读取失败计数（C01 错误矩阵的 clipboardErrorCount，内存计数不持久化）
   */
  public getClipboardErrorCount(): number {
    return this.consecutiveReadErrors
  }

  // ------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------

  /** 设置/切换轮询间隔（立即生效，不需要重启监听） */
  private setPollInterval(ms: number): void {
    if (this.intervalId !== null) clearInterval(this.intervalId)
    this.intervalId = setInterval(() => {
      void this.pollClipboard()
    }, ms)
  }

  /**
   * 单次轮询：读剪贴板 → 帧间比对 → 去重 → 黑名单 → 分析 → 构造记录 → emit('capture')
   */
  private async pollClipboard(): Promise<void> {
    if (!this.running || this.inFlight) return
    this.inFlight = true
    try {
      const text = await this.readClipboardText()
      this.consecutiveReadErrors = 0
      if (this.degraded) {
        this.degraded = false
        this.setPollInterval(this.config.pollIntervalMs)
      }
      if (text !== this.lastClipboardText) {
        this.lastClipboardText = text
        if (text.length > 0) {
          await this.handleNewContent(text)
        }
      }
    } catch (err) {
      this.handleReadError(err)
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 读取剪贴板文本
   * 主路径 navigator.clipboard.readText()（对齐任务书）；文档失焦被拦截时
   * 降级 Electron clipboard.readText()（不受焦点限制，后台轮询的关键兜底）
   * @returns 剪贴板文本
   * @throws 两条路径均不可用时抛错（走 C01 错误处理）
   */
  private async readClipboardText(): Promise<string> {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        return await navigator.clipboard.readText()
      }
    } catch {
      // 失焦被 Chromium 拦截属预期场景，走 Electron 降级链
    }
    const electronClipboard = getElectronClipboard()
    if (electronClipboard) {
      return electronClipboard.readText()
    }
    throw new Error('剪贴板读取不可用：navigator.clipboard 与 Electron clipboard 均不可用（C01）')
  }

  /**
   * 处理新捕获内容：哈希去重 → 黑名单过滤 → 分析 → 构造 CaptureRecord → 发射事件
   * @param text 剪贴板新内容
   */
  private async handleNewContent(text: string): Promise<void> {
    const hash = computeHash(text)
    if (this.isRecentlySeen(hash)) return
    if (this.matchesBlacklist(text)) return
    const analysis = classifyContent(text)
    const record: CaptureRecord = {
      id: generateRecordId(),
      hash,
      source: 'clipboard',
      content: text,
      timestamp: nowIso(),
      appName: resolveAppName(),
      wordCount: analysis.wordCount,
      contentType: analysis.contentType,
      language: analysis.language,
      tags: [],
    }
    this.emit('capture', record)
  }

  /**
   * TTL 去重缓存查询（命中则刷新时间戳并返回 true）
   * @param hash 内容哈希
   * @returns TTL 窗口内是否已捕获过
   */
  private isRecentlySeen(hash: string): boolean {
    const now = Date.now()
    const ttlMs = this.config.contentHashCacheTtlSec * 1000
    for (const [key, seenAt] of this.hashLastSeen) {
      if (now - seenAt > ttlMs) this.hashLastSeen.delete(key)
    }
    if (this.hashLastSeen.has(hash)) {
      this.hashLastSeen.set(hash, now)
      return true
    }
    this.hashLastSeen.set(hash, now)
    return false
  }

  /**
   * 黑名单过滤
   * @param text 待检测内容
   * @returns 命中任一黑名单正则则 true（丢弃）
   */
  private matchesBlacklist(text: string): boolean {
    return this.blacklistRegexps.some((regexp: RegExp): boolean => regexp.test(text))
  }

  /**
   * 读取失败处理（错误矩阵 C01）：降级 1000ms 慢轮询；连续 10 次先发错误事件再自动停止
   * @param err 捕获到的异常
   */
  private handleReadError(err: unknown): void {
    this.consecutiveReadErrors++
    const message = err instanceof Error ? err.message : String(err)
    if (!this.degraded) {
      this.degraded = true
      this.setPollInterval(DEGRADED_POLL_INTERVAL_MS)
    }
    if (this.consecutiveReadErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
      // 先发事件再停止（stop 会 removeAllListeners），确保上层能收到最后一次通知
      this.emit(
        'error',
        new Error(
          `剪贴板读取连续失败 ${MAX_CONSECUTIVE_READ_ERRORS} 次，已自动停止监听（C01）：${message}`
        )
      )
      void this.stop()
    }
  }
}
