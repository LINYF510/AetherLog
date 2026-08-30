/**
 * AetherLog 剪贴板监听接口与配置定义
 * 对齐 docs/design/v1.0_AetherLog架构设计.md ADR-004（200ms 轮询 + 焦点补采集）
 */
import type { CaptureRecord } from './capture.types'

/**
 * 剪贴板监听策略接口（替换点①：MVP 为 PollingListener 轮询实现，Phase 3 可替换原生钩子）
 *
 * 事件契约：
 * - 'capture'：仅当「内容哈希真的变了」时触发，同内容重复复制不触发
 * - 'error'：读取剪贴板连续失败达到阈值等致命错误时触发（携带 Error）
 */
export interface IClipboardListener {
  /** 开始监听，Promise resolve = 监听器已就绪（不等于首次读到内容） */
  start(): Promise<void>
  /** 停止监听，清理定时器与事件注册 */
  stop(): Promise<void>
  /** 当前是否正在监听 */
  isRunning(): boolean
  /** 注册内容捕获回调 */
  on(event: 'capture', listener: (record: CaptureRecord) => void): void
  /** 注册错误回调 */
  on(event: 'error', listener: (error: Error) => void): void
  /** 注销内容捕获回调 */
  off(event: 'capture', listener: (record: CaptureRecord) => void): void
  /** 注销错误回调 */
  off(event: 'error', listener: (error: Error) => void): void
}

/** 剪贴板监听配置 */
export interface ClipboardListenerConfig {
  /** 轮询间隔（毫秒），默认 200（对齐 ADR-004） */
  pollIntervalMs: number
  /** 是否启用焦点补采集（window focus / workspace active-leaf-change 触发立即检查） */
  focusSupplementary: boolean
  /** 焦点补采集防抖窗口（毫秒）：窗口内的重复触发只检查一次 */
  focusWindowMs: number
  /** 内容关键字黑名单（正则数组，命中任一则丢弃，不写入） */
  blacklistPatterns: string[]
  /** 内容哈希去重缓存 TTL（秒）：窗口内相同哈希直接丢弃，默认 1800（30 分钟） */
  contentHashCacheTtlSec: number
}
