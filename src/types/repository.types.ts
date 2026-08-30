/**
 * AetherLog 捕获记录存储仓储接口与配置定义
 * 对齐 docs/design/v1.0_AetherLog架构设计.md §3.3 ICaptureRepository（替换点②：存储策略）
 */
import type { CaptureRecord } from './capture.types'

/** 插入结果：inserted = 新写入；existed = 同哈希记录已存在，未写盘 */
export type InsertStatus = 'inserted' | 'existed'

/** 单条记录插入结果 */
export interface InsertResult {
  status: InsertStatus
  /** 实际写入的 Vault 文件路径（existed 时也返回当日文件路径，便于定位） */
  filePath: string
}

/**
 * 捕获记录存储仓储接口（替换点②：MVP 为日文件存储，Phase 2 可扩展独立文件夹/Daily Notes）
 */
export interface ICaptureRepository {
  /**
   * 插入一条捕获记录
   * 写入格式：同来源 Callout 分组，分组内时间倒序（新的在顶），空分组自动移除
   * @param record 完整捕获记录
   * @returns 插入结果（同哈希去重命中时返回 existed 且不写盘）
   */
  insertCaptureRecord(record: CaptureRecord): Promise<InsertResult>
  /**
   * 查询某日期的全部捕获记录（解析当日 md 文件）
   * @param date 日期字符串，格式 YYYY-MM-DD
   * @returns 当日全部记录（文件不存在时返回空数组）
   */
  queryDayRecords(date: string): Promise<CaptureRecord[]>
  /**
   * 按关键字全文检索全部捕获记录
   * @param keyword 关键字（子串匹配）
   * @returns 命中的记录列表
   */
  searchByKeyword(keyword: string): Promise<CaptureRecord[]>
  /**
   * 清空全部捕获数据（软删除：移动到 Vault 根下 aetherlog_trash_{时间戳} 文件夹备份，
   * 对齐里程碑 Checklist C4；真实删除由用户手动清空回收站文件夹）
   * @returns 回收站备份文件夹路径；无数据可清空时返回空字符串
   */
  deleteAll(): Promise<string>
}

/** 存储仓储配置（由 AetherLogSettings 派生） */
export interface RepositoryConfig {
  /** 日文件输出根路径（相对 Vault 根），如 'aetherlog/clipboard' */
  outputPath: string
  /** 结构化标签命名空间前缀（如 aetherlog/clipboard → '#aetherlog/clipboard'） */
  notePrefix: string
  /** Callout 写入格式版本号（未来格式升级时用于迁移判断） */
  calloutFormatVersion: number
}
