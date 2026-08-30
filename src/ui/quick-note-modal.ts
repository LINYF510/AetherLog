/**
 * M5 速记面板（QuickNoteModal）
 * 布局/交互对齐 docs/design/v1.0_UI与数据格式规范.md §1（速记面板）
 *
 * 两条强制规范：
 * 1. 聚焦 3 次重试（最高优先级）：面板打开后必须「一打开就能打字」，
 *    onOpen 内 100% 按窗口 B 任务书伪代码落地（rAF + setTimeout 指数退避双保险）。
 * 2. UI 层禁止直接操作 Vault：所有业务数据写入统一走 app.aetherlog 全局桥接
 *    （A 窗口 M4 挂载 insertQuickNote），或由 options.onSubmit 注入。
 */
import { App, Modal, Notice } from 'obsidian'
import type { MetadataCache } from 'obsidian'
import type { AetherLogGlobal, CaptureRecord } from '../types/capture.types'
import type { AetherLogSettings } from '../types/settings.types'
import type AetherLogPlugin from '../main'
import { computeHash } from '../utils/hash-utils'
import { classifyContent } from '../utils/content-classifier'
import { resolveAppName } from '../utils/app-name-resolver'
import { nowIso } from '../utils/date-utils'

/** 「自定义」分类占位值（仅作下拉切换标记，不作为真实分类名落盘） */
const CUSTOM_CATEGORY = '__custom__'

/** 分类下拉兜底列表（options.settings 缺失时使用，与 DEFAULT_SETTINGS 对齐） */
const FALLBACK_CATEGORIES: readonly string[] = ['灵感', '待办', '摘抄', '想法', '备忘']

/** 标签联想候选项上限（对齐窗口 B 任务书：最多展示 8 个） */
const TAG_SUGGEST_LIMIT = 8

/** 速记面板构造选项 */
export interface QuickNoteModalOptions {
  /** 初始选中分类（缺省取 settings.quickNoteCategories[0]；不在预设列表中视为自定义预填） */
  defaultCategory?: string
  /** 提交回调（缺省走 app.aetherlog.insertQuickNote 全局桥接） */
  onSubmit?: (record: CaptureRecord) => Promise<void>
  /** 插件设置（读取分类预设；缺省用内置兜底列表） */
  settings?: AetherLogSettings
}

/**
 * AetherLog 速记面板
 *
 * @example
 * new QuickNoteModal(app, { settings: plugin.settings }).open()
 */
export default class QuickNoteModal extends Modal {
  private readonly options: QuickNoteModalOptions
  private readonly categories: readonly string[]
  /** 已选用户标签（不含 # 前缀；# 前缀由仓储层统一补齐，对齐 CaptureRecord.tags 契约） */
  private selectedTags: string[] = []
  /** 当前标签联想候选 */
  private suggestCandidates: string[] = []
  /** 联想列表高亮索引（-1 = 无高亮） */
  private suggestIndex = -1

  private textareaEl!: HTMLTextAreaElement
  private categorySelectEl!: HTMLSelectElement
  private categoryInputEl!: HTMLInputElement
  private tagInputEl!: HTMLInputElement
  private suggestEl!: HTMLDivElement
  private chipsEl!: HTMLDivElement

  public constructor(app: App, options: QuickNoteModalOptions = {}) {
    super(app)
    this.options = options
    const configured = options.settings?.quickNoteCategories
    this.categories = configured !== undefined && configured.length > 0 ? configured : FALLBACK_CATEGORIES
  }

  public override onOpen(): void {
    super.onOpen()
    this.modalEl.addClass('aetherlog-quicknote-modal')
    this.render()
    // —— 聚焦 3 次重试机制（强制规范，100% 对齐任务书伪代码，一字不差）——
    const textarea = this.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea.aetherlog-quicknote-input'
    )!
    setTimeout(() => {
      let tries = 0
      const tryFocus = (): void => {
        textarea.focus()
        textarea.select()
        if (document.activeElement !== textarea && tries < 3) {
          tries++
          requestAnimationFrame(tryFocus) // 双保险：rAF + setTimeout
          setTimeout(tryFocus, 50 * tries) // 指数退避
        } else if (document.activeElement !== textarea) {
          new Notice('[AetherLog] ⚠️ 速记面板聚焦失败，请点击输入框开始输入（已记录到日志）', 4000)
          console.warn('[AetherLog][QuickNoteModal] focus failed after 3 retries')
        }
      }
      tryFocus()
    }, 0)
  }

  public override onClose(): void {
    super.onClose()
    // MVP 无草稿（autoSaveDraft 为 Phase 2 功能，任务书明确 MVP 不做）；
    // 全部事件监听器都挂在面板内部 DOM 上，随 contentEl 销毁自动回收，
    // 此处仅清空运行时状态，防止 Modal 实例被外部持有时的内存泄漏
    this.selectedTags = []
    this.suggestCandidates = []
    this.suggestIndex = -1
    this.hideSuggest()
  }

  /** 渲染面板骨架：标题栏 → 输入区 → 工具栏（分类/标签/语音）→ 底栏 */
  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('aetherlog-quicknote-container')

    // 顶部：标题 + 右对齐 ESC 快捷键提示小字
    const header = contentEl.createDiv('aetherlog-quicknote-header')
    header.createSpan({ text: 'AetherLog 速记 · 输入即保存', cls: 'aetherlog-quicknote-title' })
    header.createSpan({ text: 'ESC 关闭', cls: 'aetherlog-quicknote-esc-hint' })

    // 中部：多行 TextArea（flex 撑满约 80% 高度）
    this.textareaEl = contentEl.createEl('textarea', { cls: 'aetherlog-quicknote-input' })
    this.textareaEl.placeholder = '输入速记内容，Ctrl+Enter 提交，Enter 换行（或切换）'
    this.textareaEl.addEventListener('keydown', (evt: KeyboardEvent) => this.onTextareaKeyDown(evt))

    // 工具栏行：左分类 / 中标签 / 右语音（flex 两端对齐）
    const toolbar = contentEl.createDiv('aetherlog-quicknote-toolbar')
    this.renderCategoryControl(toolbar)
    this.renderTagControl(toolbar)
    const voiceBtn = toolbar.createEl('button', { cls: 'aetherlog-quicknote-voice clickable-icon', text: '🎙️' })
    voiceBtn.type = 'button'
    voiceBtn.title = '语音输入（Phase 2）'
    voiceBtn.addEventListener('click', () => {
      new Notice('🎙️ 语音输入功能 Phase 2 推出，敬请期待', 2500)
    })

    // 底部：主提交按钮 + 清空按钮
    const footer = contentEl.createDiv('aetherlog-quicknote-footer')
    const submitBtn = footer.createEl('button', {
      cls: 'mod-cta aetherlog-quicknote-submit',
      text: '保存速记 (Ctrl+Enter)',
    })
    submitBtn.type = 'button'
    submitBtn.addEventListener('click', () => void this.handleSubmit())
    const clearBtn = footer.createEl('button', { cls: 'aetherlog-quicknote-clear', text: '清空' })
    clearBtn.type = 'button'
    clearBtn.addEventListener('click', () => {
      this.textareaEl.value = ''
      this.textareaEl.focus()
    })
  }

  /** 分类下拉：预设分类 + 「自定义」项（选自定义后切换为输入框） */
  private renderCategoryControl(toolbar: HTMLElement): void {
    const wrap = toolbar.createDiv('aetherlog-quicknote-category')
    wrap.createSpan({ text: '🏷️', cls: 'aetherlog-quicknote-category-icon' })

    this.categorySelectEl = wrap.createEl('select', { cls: 'dropdown aetherlog-quicknote-category-select' })
    for (const category of this.categories) {
      this.categorySelectEl.createEl('option', { text: category }).value = category
    }
    this.categorySelectEl.createEl('option', { text: '自定义' }).value = CUSTOM_CATEGORY

    this.categoryInputEl = wrap.createEl('input', { cls: 'aetherlog-quicknote-category-input' })
    this.categoryInputEl.type = 'text'
    this.categoryInputEl.placeholder = '自定义分类名'

    // 初始值：defaultCategory 不在预设列表 → 视为自定义预填；否则选中对应预设项
    const preferred = this.options.defaultCategory?.trim() ?? ''
    if (preferred.length > 0 && !this.categories.includes(preferred)) {
      this.categorySelectEl.value = CUSTOM_CATEGORY
      this.categorySelectEl.style.display = 'none'
      this.categoryInputEl.value = preferred
    } else {
      this.categorySelectEl.value = preferred.length > 0 ? preferred : (this.categories[0] ?? '')
      this.categoryInputEl.style.display = 'none'
    }

    this.categorySelectEl.addEventListener('change', () => {
      const isCustom = this.categorySelectEl.value === CUSTOM_CATEGORY
      this.categorySelectEl.style.display = isCustom ? 'none' : ''
      this.categoryInputEl.style.display = isCustom ? '' : 'none'
      if (isCustom) this.categoryInputEl.focus()
    })
  }

  /** 标签输入：chip 展示 + Vault 标签联想（最多 8 项） */
  private renderTagControl(toolbar: HTMLElement): void {
    const wrap = toolbar.createDiv('aetherlog-quicknote-tags')
    this.chipsEl = wrap.createDiv('aetherlog-quicknote-chips')
    this.tagInputEl = wrap.createEl('input', { cls: 'aetherlog-quicknote-tag-input' })
    this.tagInputEl.type = 'text'
    this.tagInputEl.placeholder = '🏷️ 标签（回车/空格添加，支持联想）'
    this.suggestEl = wrap.createDiv('aetherlog-quicknote-suggest')
    this.suggestEl.style.display = 'none'

    this.tagInputEl.addEventListener('input', () => this.onTagInput())
    this.tagInputEl.addEventListener('keydown', (evt: KeyboardEvent) => this.onTagInputKeyDown(evt))
    this.tagInputEl.addEventListener('blur', () => this.hideSuggest())
    this.tagInputEl.addEventListener('focus', () => {
      if (this.tagInputEl.value.length > 0) this.onTagInput()
    })
  }

  /** 读取当前分类（自定义 → 输入框值） */
  private currentCategory(): string {
    if (this.categorySelectEl.value === CUSTOM_CATEGORY) return this.categoryInputEl.value.trim()
    return this.categorySelectEl.value
  }

  /** 标签联想：查 Vault 全局标签（getTags 为未公开 API，结构化收窄读取） */
  private onTagInput(): void {
    const raw = this.tagInputEl.value.replace(/^#+/, '').trim().toLowerCase()
    if (raw.length === 0) {
      this.hideSuggest()
      return
    }
    // Obsidian 官方 d.ts 未声明 metadataCache.getTags()（返回 标签 → 使用次数），
    // 该 API 运行时稳定且为标签搜索基石，此处结构化收窄调用
    const cache = this.app.metadataCache as MetadataCache & { getTags?: () => Record<string, number> }
    const allTags = cache.getTags?.() ?? {}
    this.suggestCandidates = Object.keys(allTags)
      .filter((tag: string): boolean => tag.toLowerCase().includes(raw))
      .sort((a: string, b: string): number => (allTags[b] ?? 0) - (allTags[a] ?? 0))
      .slice(0, TAG_SUGGEST_LIMIT)
    this.suggestIndex = -1
    this.renderSuggest()
  }

  /** 渲染联想下拉列表（鼠标 mousedown 点选，避免与 blur 竞态） */
  private renderSuggest(): void {
    if (this.suggestCandidates.length === 0) {
      this.hideSuggest()
      return
    }
    this.suggestEl.empty()
    this.suggestCandidates.forEach((tag: string, idx: number): void => {
      const item = this.suggestEl.createDiv({ text: tag, cls: 'aetherlog-quicknote-suggest-item' })
      if (idx === this.suggestIndex) item.addClass('is-active')
      item.addEventListener('mousedown', (evt: MouseEvent) => {
        evt.preventDefault() // 抢在 blur 之前，防止联想框先被关闭
        this.addTag(tag)
      })
    })
    this.suggestEl.style.display = ''
  }

  /** 隐藏联想框 */
  private hideSuggest(): void {
    this.suggestEl.style.display = 'none'
  }

  /** 标签输入框键盘交互：↑↓ 选择 / Enter 确认 / 空格逗号结束标签 / 空时 Backspace 删 chip */
  private onTagInputKeyDown(evt: KeyboardEvent): void {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      if (this.suggestEl.style.display === 'none') return
      evt.preventDefault()
      const count = this.suggestCandidates.length
      if (count === 0) return
      const delta = evt.key === 'ArrowDown' ? 1 : -1
      this.suggestIndex = (this.suggestIndex + delta + count) % count
      this.renderSuggest()
      return
    }
    if (evt.key === 'Enter') {
      evt.preventDefault()
      const highlighted =
        this.suggestIndex >= 0 && this.suggestEl.style.display !== 'none'
          ? this.suggestCandidates[this.suggestIndex]
          : null
      this.addTag(highlighted ?? this.tagInputEl.value)
      return
    }
    if (evt.key === 'Escape') {
      this.hideSuggest()
      return
    }
    if (evt.key === ',' || evt.key === ' ') {
      evt.preventDefault()
      this.addTag(this.tagInputEl.value)
      return
    }
    if (evt.key === 'Backspace' && this.tagInputEl.value.length === 0) {
      this.selectedTags.pop()
      this.renderChips()
    }
  }

  /**
   * 添加一个标签：去 # 前缀、trim、内部空白转连字符、转小写
   * （对齐 UI 规范 §1.3 自定义新标签规范；# 前缀由仓储层补齐）
   */
  private addTag(input: string): void {
    const tag = input.replace(/^#+/, '').trim().replace(/\s+/g, '-').toLowerCase()
    this.tagInputEl.value = ''
    this.hideSuggest()
    if (tag.length === 0) return
    if (this.selectedTags.includes(tag)) return
    this.selectedTags.push(tag)
    this.renderChips()
  }

  /** 渲染已选标签 chip（pill 样式 + × 删除） */
  private renderChips(): void {
    this.chipsEl.empty()
    for (const tag of this.selectedTags) {
      const chip = this.chipsEl.createSpan({ text: `#${tag}`, cls: 'aetherlog-quicknote-tag-chip' })
      chip.createSpan({ text: '×', cls: 'aetherlog-quicknote-chip-remove' }).addEventListener(
        'click',
        () => {
          this.selectedTags = this.selectedTags.filter((t: string): boolean => t !== tag)
          this.renderChips()
        }
      )
    }
  }

  /** 主输入区键盘交互（对齐 UI 规范 §1.2 提交策略） */
  private onTextareaKeyDown(evt: KeyboardEvent): void {
    // Ctrl/Cmd+Enter：无条件立即提交（任何情况下都必须能提交）
    if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
      evt.preventDefault()
      void this.handleSubmit()
      return
    }
    // Ctrl+Shift+C：复制当前内容到剪贴板
    if ((evt.ctrlKey || evt.metaKey) && evt.shiftKey && (evt.key === 'c' || evt.key === 'C')) {
      evt.preventDefault()
      void this.copyContent()
      return
    }
    // Enter：单行内容直接提交；多行内容插入换行并轻提示（任务书默认行为）
    if (evt.key === 'Enter' && !evt.shiftKey && !evt.altKey) {
      if (!this.textareaEl.value.includes('\n')) {
        evt.preventDefault()
        void this.handleSubmit()
      } else {
        new Notice('📝 多行模式，Ctrl+Enter 提交', 1500)
      }
    }
  }

  /** 复制当前速记内容到系统剪贴板 */
  private async copyContent(): Promise<void> {
    const text = this.textareaEl.value
    if (text.length === 0) {
      new Notice('[AetherLog] 没有可复制的内容', 1500)
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      new Notice('已复制速记内容', 1500)
    } catch {
      new Notice('[AetherLog] 复制失败：剪贴板不可用', 3000)
    }
  }

  /**
   * 提交：构造 CaptureRecord 并经全局桥接写入（UI 层不直接操作 Vault）
   */
  private async handleSubmit(): Promise<void> {
    const content = this.textareaEl.value.trim()
    if (content.length === 0) {
      new Notice('[AetherLog] 内容不能为空', 2000)
      return
    }
    const analysis = classifyContent(content)
    const category = this.currentCategory()
    const record: CaptureRecord = {
      id: 'qn-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      hash: computeHash(content),
      source: 'quicknote',
      content,
      timestamp: nowIso(),
      appName: resolveAppName(),
      wordCount: analysis.wordCount,
      contentType: analysis.contentType,
      language: analysis.language,
      category: category.length > 0 ? category : undefined,
      tags: [...this.selectedTags],
    }
    const ok = await this.submitRecord(record)
    if (ok) {
      this.close()
      new Notice(`[AetherLog] 已保存速记（${analysis.wordCount}字）`, 1500)
    }
  }

  /**
   * 写入记录：优先 options.onSubmit，缺省走 app.aetherlog 全局桥接（含就绪保护）
   * @returns 是否成功（失败时面板保持打开，供用户重试）
   */
  private async submitRecord(record: CaptureRecord): Promise<boolean> {
    if (this.options.onSubmit !== undefined) {
      try {
        await this.options.onSubmit(record)
        return true
      } catch (err) {
        this.notifySubmitError(err)
        return false
      }
    }
    // 全局桥接保护：A 窗口 M4 未就绪时提示并保留面板
    const bridge = this.app.aetherlog
    if (typeof bridge?.insertQuickNote !== 'function') {
      new Notice('[AetherLog] 核心模块未就绪，请等待主入口启动完成', 3000)
      return false
    }
    try {
      await bridge.insertQuickNote(record)
      return true
    } catch (err) {
      this.notifySubmitError(err)
      return false
    }
  }

  /** 提交失败提示（保留面板不关闭，对齐任务书提交逻辑第 6 步） */
  private notifySubmitError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    new Notice(`[AetherLog] 保存速记失败: ${message}`, 8000)
    console.warn('[AetherLog][QuickNoteModal] submit failed:', err)
  }
}

/**
 * 挂载速记面板到插件主入口（M5.3）
 *
 * 职责：
 * 1. 覆盖 app.aetherlog.openQuickNote 桩函数（A 窗口 M4 预留）为真正的 Modal 打开
 * 2. 命令 aetherlog:open-quick-note 已由 A 窗口 M4 在 main.ts 注册
 *    （addCommand id='open-quick-note'，回调走 app.aetherlog.openQuickNote），
 *    此处不再重复注册，全局保持仅一份命令
 *
 * 使用方式：A 窗口在 main.ts onload 中（app.aetherlog 桥接挂载之后）调用
 *   mountQuickNoteModal(this)
 * @param plugin 插件主实例
 */
export function mountQuickNoteModal(plugin: AetherLogPlugin): void {
  const app = plugin.app
  const openQuickNote = (): void => {
    new QuickNoteModal(app, {
      settings: plugin.settings,
      defaultCategory: plugin.settings.quickNoteCategories[0],
    }).open()
  }
  // 桥接已挂载则覆盖桩函数；未挂载（M4 未执行）则先挂 openQuickNote，
  // insertQuickNote 留待 A 窗口补齐（提交侧有 typeof 就绪保护兜底）
  const bridge: AetherLogGlobal = app.aetherlog ?? ({} as AetherLogGlobal)
  bridge.openQuickNote = openQuickNote
  app.aetherlog = bridge
}
