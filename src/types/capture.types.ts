/**
 * AetherLog 捕获记录核心类型定义
 * 对齐 docs/design/v1.0_UI与数据格式规范.md §5.1 CaptureRecord 11 字段
 */
import type { InsertResult } from './repository.types'

/** 捕获来源：剪贴板（被动捕获）/ 速记面板（用户主动输入）/ 语音转写（Phase 2） */
export type CaptureSource = 'clipboard' | 'quicknote' | 'voice'

/** 内容类型（10 类自动判断，规则见 content-classifier.ts） */
export type ContentType =
  | 'url'
  | 'email'
  | 'code'
  | 'path'
  | 'json'
  | 'xml'
  | 'html'
  | 'css'
  | 'markdown'
  | 'text'

/** 内容语言（中文 / 英文 / 混合 / 不确定） */
export type Language = 'chinese' | 'english' | 'mixed' | 'unknown'

/**
 * 捕获记录统一结构（三来源归一）
 *
 * 字段说明：
 * - id: 运行时生成的类 ULID 唯一标识（不持久化到 md 文件）
 * - hash: 内容 SHA-256 哈希前 12 位 hex（去重与查询锚点）
 * - timestamp: 用户本地时区 ISO 字符串（如 2026-08-29T14:32:15.328+08:00）
 * - appName: 来源应用名（尽力而为策略，拿不到时为 'Unknown'）
 * - wordCount: 字数统计（含中文按字计数，纯英文按空格分词）
 * - category: 分类（仅速记/语音来源填写，剪贴板来源缺省）
 * - tags: 用户标签（速记面板选择的标签 + 截断等特殊标记，如 'type/truncated'）
 */
export interface CaptureRecord {
  id: string
  hash: string
  source: CaptureSource
  content: string
  timestamp: string
  appName: string
  wordCount: number
  contentType: ContentType
  language: Language
  category?: string
  tags: string[]
}

/**
 * AetherLog 挂载在 Obsidian App 对象上的桥接接口
 * 用途：UI 层（B 窗口速记面板 / M5）与业务层（A 窗口仓储）解耦。
 * M4 主入口先挂桩函数，B 窗口实现 Modal 后覆盖 openQuickNote。
 */
export interface AetherLogGlobal {
  /** 插入一条速记/语音来源的捕获记录（走与剪贴板相同的存储链路） */
  insertQuickNote: (record: CaptureRecord) => Promise<InsertResult>
  /** 打开速记面板（M4 为桩，M5 由 B 窗口覆盖为真正的 QuickNoteModal.open） */
  openQuickNote: () => void
}

declare module 'obsidian' {
  interface App {
    /** AetherLog 桥接挂载点（onunload 时 delete） */
    aetherlog?: AetherLogGlobal
  }
}
