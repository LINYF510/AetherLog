/**
 * 内容哈希与记录 ID 生成工具
 * 纯函数、零 Obsidian 依赖，可被监听服务 / B 窗口速记面板共用
 */
import { createHash, randomBytes } from 'crypto'

/** 哈希截断长度（对齐 UI 规范 {{hash12}}：SHA-256 前 12 位 hex，48bit 足够去重） */
const HASH_LENGTH = 12

/** 超过该长度（字符数）触发快速哈希截断，避免巨文本阻塞主线程（对齐架构文档 §6.1） */
const FAST_HASH_THRESHOLD_CHARS = 2 * 1024 * 1024

/** 快速哈希保留头部长度 */
const FAST_HASH_HEAD_CHARS = 1024 * 1024

/** 快速哈希保留尾部长度 */
const FAST_HASH_TAIL_CHARS = 512 * 1024

/**
 * 计算内容 SHA-256 哈希（前 12 位 hex）
 * 长文本优化：超过 2MB 时只对「前 1MB + 后 512KB + 总长度标记」组合哈希
 * @param content 原始内容
 * @returns 12 位 hex 哈希字符串
 */
export function computeHash(content: string): string {
  let input = content
  if (content.length > FAST_HASH_THRESHOLD_CHARS) {
    input =
      content.slice(0, FAST_HASH_HEAD_CHARS) +
      content.slice(content.length - FAST_HASH_TAIL_CHARS) +
      `#len:${content.length}`
  }
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_LENGTH)
}

/**
 * 生成类 ULID 的记录唯一 ID（时间戳 base36 + 随机 hex，单调递增可排序）
 * 注意：ID 仅运行时使用，不持久化到 md 文件（元信息以哈希为锚点）
 * @returns 唯一 ID 字符串
 */
export function generateRecordId(): string {
  return Date.now().toString(36) + randomBytes(5).toString('hex')
}
