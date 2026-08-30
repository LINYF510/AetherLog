/**
 * 捕获记录日文件仓储（MVP 主力实现，对齐 ADR-005 存储策略）
 *
 * 写入格式（对齐窗口 A 任务书 Callout 正则锚点，精确到字符）：
 * - 剪贴板蓝分组头：> [!note]+ aetherlog/clipboard ### 📋 剪贴板捕获 (今天共 N 条)
 * - 速记绿分组头：  > [!tip|aetherlog-success]+ aetherlog/quicknote ### 💡 我的速记 (今天共 N 条)
 * - 语音紫分组头：  > [!example|aetherlog-purple]+ aetherlog/voice ### 🎙️ 语音转写 (今天共 N 条)
 *
 * 每条记录结构：分组头 → '> ---' 元信息分隔线 → 记录（新的在顶，时间倒序）：
 *   > **时间戳:** … · **来源应用:** … · **内容哈希:** `…`
 *   > **字数统计:** … · **内容类型:** … · **语言:** …
 *   > **分类:** …（可选） / > **用户标签:** …（可选）
 *   > 标签：`#aetherlog/…` `#type/…` `#lang/…`（结构化多级标签）
 *   > ```lang 原文代码块 ```
 *
 * 约束：全部文件读写使用 Obsidian Vault API（禁止 fs）；
 * 插入前按哈希去重（同哈希返回 existed 不写盘）；空分组自动移除；
 * deleteAll 为软删除（备份到 aetherlog_trash_{时间戳} 文件夹，对齐里程碑 Checklist C4）。
 */
import { normalizePath, TFile, Vault } from 'obsidian'
import type { CaptureRecord, CaptureSource, ContentType, Language } from '../types/capture.types'
import type { ICaptureRepository, InsertResult, InsertStatus } from '../types/repository.types'
import type { AetherLogSettings } from '../types/settings.types'
import { detectCodeLanguage } from '../utils/content-classifier'
import { formatDate, formatTimestampForFolder, getDayFilePath, normalizeDirPath, nowIso } from '../utils/date-utils'

/** 单个来源的 Callout 分组定义 */
interface GroupDef {
  source: CaptureSource
  /** callout 类型（note/tip/example，Obsidian 内建类型保证零插件渲染） */
  type: string
  /** [!type|metadata] 中的 metadata（null 表示无） */
  metadata: string | null
  /** 分组标题（含 emoji） */
  title: string
}

/** 三种来源分组固定顺序（clipboard → quicknote → voice），新分组按此顺序插入 */
const GROUP_DEFS: readonly GroupDef[] = [
  { source: 'clipboard', type: 'note', metadata: null, title: '📋 剪贴板捕获' },
  { source: 'quicknote', type: 'tip', metadata: 'aetherlog-success', title: '💡 我的速记' },
  { source: 'voice', type: 'example', metadata: 'aetherlog-purple', title: '🎙️ 语音转写' },
]

/** 记录元信息首行（时间戳 · 来源应用 · 内容哈希） */
const META_LINE_1_RE = /^> \*\*时间戳:\*\* (.+?) · \*\*来源应用:\*\* (.+?) · \*\*内容哈希:\*\* `([^`]+)`$/

/** 记录元信息次行（字数统计 · 内容类型 · 语言） */
const META_LINE_2_RE = /^> \*\*字数统计:\*\* (\d+) · \*\*内容类型:\*\* (\w+) · \*\*语言:\*\* (\w+)$/

/** 可选分类行 */
const CATEGORY_LINE_RE = /^> \*\*分类:\*\* (.+)$/

/** 可选用户标签行 */
const USER_TAGS_LINE_RE = /^> \*\*用户标签:\*\* (.+)$/

/** 记录代码块起始行（> ```lang） */
const FENCE_START_RE = /^> (`{3,})(\w*)$/

/** 顶部统计概览行 */
const OVERVIEW_LINE_RE = /^> 📊 \*\*本日概览\*\* · 共捕获：\d+ 条 · 📋 剪贴板：\d+ · 💡 速记：\d+ · 🎙️ 语音：\d+$/

/** 最后更新时间行 */
const LAST_UPDATED_LINE_RE = /^> \*最后更新：.+\*$/

/**
 * 转义正则特殊字符
 * @param text 原始文本
 * @returns 可安全嵌入正则的文本
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 渲染分组头行（精确匹配任务书锚点格式）
 * @param def 分组定义
 * @param count 当日该来源记录数
 * @returns 分组头行
 */
function renderGroupHeader(def: GroupDef, count: number): string {
  const meta = def.metadata !== null ? `|${def.metadata}` : ''
  return `> [!${def.type}${meta}]+ aetherlog/${def.source} ### ${def.title} (今天共 ${count} 条)`
}

/**
 * 生成分组头匹配正则（用于定位与解析）
 * @param def 分组定义
 * @returns 匹配该分组头的正则
 */
function groupHeaderRegex(def: GroupDef): RegExp {
  const meta = def.metadata !== null ? `\\|${escapeRegExp(def.metadata)}` : ''
  return new RegExp(
    `^> \\[!${def.type}${meta}\\]\\+ aetherlog/${def.source} ### ${escapeRegExp(def.title)} \\(今天共 (\\d+) 条\\)$`
  )
}

/**
 * 依据记录内容类型确定代码块围栏语言标注
 * @param record 捕获记录
 * @returns 围栏语言字符串
 */
function fenceLanguageFor(record: CaptureRecord): string {
  switch (record.contentType) {
    case 'json':
    case 'xml':
    case 'html':
    case 'css':
    case 'markdown':
      return record.contentType
    case 'code':
      return detectCodeLanguage(record.content)
    default:
      return 'text'
  }
}

/**
 * 计算代码块围栏所需长度（内容含 ``` 等围栏时自动加长，避免嵌套截断）
 * @param content 原文内容
 * @returns 围栏反引号个数（至少 3）
 */
function computeFenceLength(content: string): number {
  const runs = content.match(/`+/g)
  if (runs === null) return 3
  const maxRun = runs.reduce((max: number, run: string): number => Math.max(max, run.length), 0)
  return Math.max(3, maxRun + 1)
}

/** 预处理后的待写入记录数据 */
interface PreparedRecord {
  metaLines: string[]
  tagLine: string
  fenceLang: string
  content: string
}

/**
 * 日文件仓储实现
 *
 * @example
 * const repository = new CaptureRepository(app.vault, settings)
 * const result = await repository.insertCaptureRecord(record)
 * // result.status === 'inserted' | 'existed'
 */
export class CaptureRepository implements ICaptureRepository {
  private readonly vault: Vault
  private readonly settings: AetherLogSettings
  private readonly groupHeaderRes: ReadonlyMap<CaptureSource, RegExp>

  /**
   * @param vault Obsidian Vault 实例
   * @param settings 插件设置
   */
  constructor(vault: Vault, settings: AetherLogSettings) {
    this.vault = vault
    this.settings = settings
    const map = new Map<CaptureSource, RegExp>()
    for (const def of GROUP_DEFS) {
      map.set(def.source, groupHeaderRegex(def))
    }
    this.groupHeaderRes = map
  }

  /** 当日日文件路径（规范化后） */
  private get dayFilePath(): string {
    return normalizePath(getDayFilePath(this.settings.clipboardOutputPath))
  }

  /**
   * 插入一条捕获记录（同哈希去重）
   * @param record 完整捕获记录
   * @returns 插入结果（existed = 当日已有同哈希记录，未写盘）
   */
  public async insertCaptureRecord(record: CaptureRecord): Promise<InsertResult> {
    const filePath = this.dayFilePath
    await this.ensureDayFile(filePath)
    const file = this.vault.getAbstractFileByPath(filePath)
    if (!(file instanceof TFile)) {
      throw new Error(`[AetherLog] 日文件创建失败：${filePath}`)
    }
    let status: InsertStatus = 'inserted'
    await this.vault.process(file, (content: string): string => {
      if (this.contentContainsHash(content, record.hash)) {
        status = 'existed'
        return content
      }
      status = 'inserted'
      return this.insertIntoContent(content, record)
    })
    return { status, filePath }
  }

  /**
   * 查询某日期的全部捕获记录（解析当日日文件）
   * @param date 日期字符串（YYYY-MM-DD）
   * @returns 当日全部记录（文件不存在时为空数组）
   */
  public async queryDayRecords(date: string): Promise<CaptureRecord[]> {
    const dayDate = new Date(`${date}T00:00:00`)
    const filePath = normalizePath(getDayFilePath(this.settings.clipboardOutputPath, dayDate))
    const file = this.vault.getAbstractFileByPath(filePath)
    if (!(file instanceof TFile)) return []
    const content = await this.vault.read(file)
    return this.parseRecords(content)
  }

  /**
   * 按关键字全文检索输出目录下全部捕获记录
   * @param keyword 关键字（子串匹配）
   * @returns 命中的记录列表
   */
  public async searchByKeyword(keyword: string): Promise<CaptureRecord[]> {
    const results: CaptureRecord[] = []
    const basePath = normalizeDirPath(this.settings.clipboardOutputPath)
    for (const file of this.vault.getFiles()) {
      if (!file.path.startsWith(`${basePath}/`)) continue
      if (!file.name.includes('aetherlog')) continue
      const records = this.parseRecords(await this.vault.read(file))
      for (const record of records) {
        if (record.content.includes(keyword)) results.push(record)
      }
    }
    return results
  }

  /**
   * 清空全部捕获数据（软删除：移动到 Vault 根下 aetherlog_trash_{时间戳} 备份文件夹）
   * @returns 备份文件夹路径；无数据时返回空字符串
   */
  public async deleteAll(): Promise<string> {
    const basePath = normalizeDirPath(this.settings.clipboardOutputPath)
    const files = this.vault
      .getFiles()
      .filter((file: TFile): boolean => file.path.startsWith(`${basePath}/`) && file.name.includes('aetherlog'))
    if (files.length === 0) return ''
    const trashFolder = `aetherlog_trash_${formatTimestampForFolder()}`
    await this.vault.createFolder(trashFolder)
    for (const file of files) {
      // 展平子目录路径为文件名（yyyy/MM 层级折叠为单层，避免回收站内重建目录树）
      const flatName = file.path.slice(basePath.length + 1).replace(/\//g, '_')
      await this.vault.rename(file, `${trashFolder}/${flatName}`)
    }
    return trashFolder
  }

  // ------------------------------------------------------------
  // 文件与模板
  // ------------------------------------------------------------

  /** 确保日文件存在：逐级创建父文件夹（yyyy/MM）并写入首建模板 */
  private async ensureDayFile(filePath: string): Promise<void> {
    if (this.vault.getAbstractFileByPath(filePath) !== null) return
    const segments = filePath.split('/')
    segments.pop()
    let current = ''
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      if (this.vault.getAbstractFileByPath(current) === null) {
        await this.vault.createFolder(current)
      }
    }
    await this.vault.create(filePath, this.renderDayTemplate(new Date()))
  }

  /**
   * 渲染日文件首建模板（frontmatter + 标题 + 统计概览 + 分割线，对齐 UI 规范 §3.2）
   * @param date 日期
   * @returns 模板内容
   */
  private renderDayTemplate(date: Date): string {
    const dateStr = formatDate(date)
    const lines: string[] = [
      '---',
      `title: AetherLog 捕获记录 ${dateStr}`,
      `date: ${dateStr}`,
      'tags:',
      '  - Project/aetherlog',
      '  - aetherlog/daily',
      'aliases:',
      `  - AetherLog ${dateStr}`,
      'cssclasses:',
      '  - aetherlog-daily',
      '---',
      '',
      `# 🪶 AetherLog ${dateStr} 捕获记录`,
      '',
    ]
    if (this.settings.includeDailyStatsHeader) {
      lines.push('> 📊 **本日概览** · 共捕获：0 条 · 📋 剪贴板：0 · 💡 速记：0 · 🎙️ 语音：0')
      lines.push(`> *最后更新：${nowIso(date)}*`)
      lines.push('')
    }
    lines.push(this.settings.recordSeparatorLine)
    lines.push('')
    return lines.join('\n')
  }

  // ------------------------------------------------------------
  // 写入（字符串手术）
  // ------------------------------------------------------------

  /**
   * 判断文件内容中是否已存在该哈希的记录（当日去重锚点）
   * @param content 日文件内容
   * @param hash 内容哈希
   */
  private contentContainsHash(content: string, hash: string): boolean {
    return new RegExp(`\\*\\*内容哈希:\\*\\* \`${escapeRegExp(hash)}\``).test(content)
  }

  /**
   * 将记录插入日文件内容（分组定位 → 去重 → 插入 → 计数回写）
   * @param content 当前日文件内容
   * @param record 待插入记录
   * @returns 新内容
   */
  private insertIntoContent(content: string, record: CaptureRecord): string {
    const lines = content.split('\n')
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }
    const prepared = this.prepareRecord(record, this.settings.maxContentLengthChars)
    const recordLines = this.renderRecordLines(prepared)
    const def = GROUP_DEFS.find((d: GroupDef): boolean => d.source === record.source)
    if (def === undefined) return content

    const headerIndices = this.locateGroupHeaders(lines)
    const headerIdx = headerIndices.get(record.source)

    if (headerIdx !== undefined) {
      // 分组已存在：更新计数 → 新记录插到 '> ---' 之后（新的在顶）
      const count = this.countRecordsInGroup(lines, headerIdx)
      lines[headerIdx] = renderGroupHeader(def, count + 1)
      const insertAt = lines[headerIdx + 1] === '> ---' ? headerIdx + 2 : headerIdx + 1
      if (count > 0) {
        lines.splice(insertAt, 0, ...recordLines, '>')
      } else {
        lines.splice(insertAt, 0, ...recordLines)
        // 空分组首条记录后补 1 个空行，与后续分组内容分隔（G2）
        const after = insertAt + recordLines.length
        if (after < lines.length && lines[after] !== '') {
          lines.splice(after, 0, '')
        }
      }
    } else {
      // 分组不存在：按固定顺序创建（插在排序靠后的现有分组之前，否则文件末尾）
      const order = GROUP_DEFS.findIndex((d: GroupDef): boolean => d.source === record.source)
      let insertAt = lines.length
      for (const [source, idx] of headerIndices) {
        const existingOrder = GROUP_DEFS.findIndex((d: GroupDef): boolean => d.source === source)
        if (existingOrder > order && idx < insertAt) {
          insertAt = idx
        }
      }
      // 新分组前补足 2 个空行（G2）：相邻 callout 无空行间隔会被 Obsidian 渲染为同一块
      if (insertAt > 0) {
        let blanks = 0
        if (lines[insertAt - 1] === '') blanks++
        if (insertAt >= 2 && lines[insertAt - 2] === '') blanks++
        const pad = 2 - blanks
        if (pad > 0) {
          lines.splice(insertAt, 0, ...Array.from({ length: pad }, (): string => ''))
          insertAt += pad
        }
      }
      // 新分组后同样留 2 个空行，确保 Obsidian 识别为独立 callout 块
      lines.splice(insertAt, 0, renderGroupHeader(def, 1), '> ---', ...recordLines, '', '')
    }

    this.rewriteOverview(lines)
    return `${lines.join('\n')}\n`
  }

  /**
   * 预处理记录：截断超长内容、渲染元信息行与结构化标签行
   * @param record 原始记录
   * @param maxLen 最大内容长度（0 = 不限制）
   */
  private prepareRecord(record: CaptureRecord, maxLen: number): PreparedRecord {
    let content = record.content
    const specialTags: string[] = []
    if (maxLen > 0 && content.length > maxLen) {
      content = content.slice(0, maxLen)
      specialTags.push('type/truncated')
    }
    const sep = ' · '
    const metaLines: string[] = [
      `> **时间戳:** ${record.timestamp}${sep}**来源应用:** ${record.appName}${sep}**内容哈希:** \`${record.hash}\``,
      `> **字数统计:** ${record.wordCount}${sep}**内容类型:** ${record.contentType}${sep}**语言:** ${record.language}`,
    ]
    const hasCategory = record.category !== undefined && record.category.length > 0
    if (hasCategory) {
      metaLines.push(`> **分类:** ${record.category}`)
    }
    if (record.tags.length > 0) {
      metaLines.push(`> **用户标签:** ${record.tags.map((tag: string): string => `\`${tag}\``).join(' ')}`)
    }
    // 结构化多级标签行（顺序对齐 UI 规范 §3.5：来源 → 分类 → 用户/特殊标签 → 类型 → 语言）
    const tags: string[] = [`#aetherlog/${record.source}`]
    if (hasCategory) {
      tags.push(`#category/${record.category}`)
    }
    for (const tag of record.tags) {
      tags.push(`#${tag}`)
    }
    for (const tag of specialTags) {
      tags.push(`#${tag}`)
    }
    tags.push(`#type/${record.contentType}`)
    tags.push(`#lang/${record.language}`)
    const tagLine = `> 标签：${tags.map((tag: string): string => `\`${tag}\``).join(' ')}`
    return { metaLines, tagLine, fenceLang: fenceLanguageFor(record), content }
  }

  /**
   * 渲染单条记录的全部行（元信息 + 标签行 + 代码块围栏）
   * @param prepared 预处理后的记录
   */
  private renderRecordLines(prepared: PreparedRecord): string[] {
    const lines: string[] = [...prepared.metaLines, prepared.tagLine]
    const fence = '`'.repeat(computeFenceLength(prepared.content))
    lines.push(`> ${fence}${prepared.fenceLang}`)
    for (const line of prepared.content.split('\n')) {
      lines.push(line.length > 0 ? `> ${line}` : '>')
    }
    lines.push(`> ${fence}`)
    return lines
  }

  /**
   * 定位各分组头在行数组中的行号
   * @param lines 日文件行数组
   * @returns 来源 → 分组头行号
   */
  private locateGroupHeaders(lines: string[]): Map<CaptureSource, number> {
    const result = new Map<CaptureSource, number>()
    lines.forEach((line: string, idx: number): void => {
      for (const def of GROUP_DEFS) {
        if (result.has(def.source)) continue
        const regex = this.groupHeaderRes.get(def.source)
        if (regex !== undefined && regex.test(line)) {
          result.set(def.source, idx)
        }
      }
    })
    return result
  }

  /**
   * 判断某行是否为（任意来源的）分组头
   * @param line 行内容
   */
  private isGroupHeaderLine(line: string): boolean {
    return GROUP_DEFS.some((def: GroupDef): boolean => {
      const regex = this.groupHeaderRes.get(def.source)
      return regex !== undefined && regex.test(line)
    })
  }

  /**
   * 统计某分组内的记录条数（从分组头下一行到下一分组头/文件尾）
   * @param lines 日文件行数组
   * @param headerIdx 分组头行号
   */
  private countRecordsInGroup(lines: string[], headerIdx: number): number {
    let count = 0
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (this.isGroupHeaderLine(lines[i])) break
      if (META_LINE_1_RE.test(lines[i])) count++
    }
    return count
  }

  /**
   * 回写顶部统计概览与最后更新时间；顺带移除空分组（防御性，正常插入不会产生空分组）
   * @param lines 日文件行数组（原地修改）
   */
  private rewriteOverview(lines: string[]): void {
    const headerIndices = this.locateGroupHeaders(lines)
    const counts = new Map<CaptureSource, number>()
    let total = 0
    for (const def of GROUP_DEFS) {
      const idx = headerIndices.get(def.source)
      const count = idx === undefined ? 0 : this.countRecordsInGroup(lines, idx)
      counts.set(def.source, count)
      total += count
    }
    if (this.settings.includeDailyStatsHeader) {
      lines.forEach((line: string, idx: number): void => {
        if (OVERVIEW_LINE_RE.test(line)) {
          lines[idx] =
            `> 📊 **本日概览** · 共捕获：${total} 条 · 📋 剪贴板：${counts.get('clipboard') ?? 0}` +
            ` · 💡 速记：${counts.get('quicknote') ?? 0} · 🎙️ 语音：${counts.get('voice') ?? 0}`
        } else if (LAST_UPDATED_LINE_RE.test(line)) {
          lines[idx] = `> *最后更新：${nowIso()}*`
        }
      })
    }
    // 空分组移除（倒序删除避免行号位移）
    const emptyGroupIdx = GROUP_DEFS.filter(
      (def: GroupDef): boolean => headerIndices.has(def.source) && (counts.get(def.source) ?? 0) === 0
    )
      .map((def: GroupDef): number => headerIndices.get(def.source) as number)
      .sort((a: number, b: number): number => b - a)
    for (const idx of emptyGroupIdx) {
      this.removeGroupAt(lines, idx)
    }
  }

  /**
   * 删除指定行号起的整个分组块（到下一分组头或文件尾）
   * @param lines 行数组（原地修改）
   * @param headerIdx 分组头行号
   */
  private removeGroupAt(lines: string[], headerIdx: number): void {
    let end = lines.length
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (this.isGroupHeaderLine(lines[i])) {
        end = i
        break
      }
    }
    lines.splice(headerIdx, end - headerIdx)
  }

  // ------------------------------------------------------------
  // 解析（读取）
  // ------------------------------------------------------------

  /**
   * 解析日文件内容为记录列表
   * @param content 日文件内容
   * @returns 记录列表（解析失败的记录自动跳过）
   */
  private parseRecords(content: string): CaptureRecord[] {
    const lines = content.split('\n')
    const records: CaptureRecord[] = []
    let currentSource: CaptureSource | null = null
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (this.isGroupHeaderLine(line)) {
        currentSource = this.matchGroupSource(line)
        i++
        continue
      }
      const metaMatch = META_LINE_1_RE.exec(line)
      if (metaMatch !== null && currentSource !== null) {
        const parsed = this.parseRecordAt(lines, i, currentSource, metaMatch)
        if (parsed !== null) {
          records.push(parsed.record)
          i = parsed.endIndex
          continue
        }
      }
      i++
    }
    return records
  }

  /**
   * 匹配分组头所属来源
   * @param line 分组头行
   * @returns 来源（未匹配返回 null）
   */
  private matchGroupSource(line: string): CaptureSource | null {
    for (const def of GROUP_DEFS) {
      const regex = this.groupHeaderRes.get(def.source)
      if (regex !== undefined && regex.test(line)) return def.source
    }
    return null
  }

  /**
   * 从记录元信息首行起解析一条完整记录
   * @param lines 行数组
   * @param startIdx 元信息首行行号
   * @param source 所属来源
   * @param metaMatch 元信息首行匹配结果
   * @returns 记录与结束行号；结构不完整时返回 null
   */
  private parseRecordAt(
    lines: string[],
    startIdx: number,
    source: CaptureSource,
    metaMatch: RegExpExecArray
  ): { record: CaptureRecord; endIndex: number } | null {
    const timestamp = metaMatch[1]
    const appName = metaMatch[2]
    const hash = metaMatch[3]
    let i = startIdx + 1
    let wordCount = 0
    let contentType: ContentType = 'text'
    let language: Language = 'unknown'
    let category: string | undefined
    let tags: string[] = []
    const secondMatch = META_LINE_2_RE.exec(lines[i] ?? '')
    if (secondMatch !== null) {
      wordCount = Number.parseInt(secondMatch[1], 10)
      contentType = secondMatch[2] as ContentType
      language = secondMatch[3] as Language
      i++
    }
    // 可选分类行与用户标签行
    while (i < lines.length) {
      const categoryMatch = CATEGORY_LINE_RE.exec(lines[i])
      if (categoryMatch !== null) {
        category = categoryMatch[1]
        i++
        continue
      }
      const tagsMatch = USER_TAGS_LINE_RE.exec(lines[i])
      if (tagsMatch !== null) {
        tags = tagsMatch[1]
          .split(' ')
          .map((tag: string): string => tag.replace(/`/g, ''))
          .filter((tag: string): boolean => tag.length > 0)
        i++
        continue
      }
      break
    }
    // 结构化标签行（仅视觉/检索辅助，解析时跳过）
    if ((lines[i] ?? '').startsWith('> 标签：')) {
      i++
    }
    // 原文代码块
    const fenceMatch = FENCE_START_RE.exec(lines[i] ?? '')
    if (fenceMatch === null) return null
    const fence = fenceMatch[1]
    i++
    const contentLines: string[] = []
    while (i < lines.length && lines[i] !== `> ${fence}`) {
      const raw = lines[i]
      contentLines.push(raw.startsWith('> ') ? raw.slice(2) : raw.replace(/^>/, ''))
      i++
    }
    i++
    const record: CaptureRecord = {
      // id 不持久化（元信息以哈希为锚点），查询结果以哈希回填 id
      id: hash,
      hash,
      source,
      content: contentLines.join('\n'),
      timestamp,
      appName,
      wordCount,
      contentType,
      language,
      category,
      tags,
    }
    return { record, endIndex: i }
  }
}
