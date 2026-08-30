/**
 * AetherLog 设置面板（M6 · C 窗口）
 * 布局/文案对齐 docs/design/v1.0_UI与数据格式规范.md §2；字段/默认值/验证/热更新对齐
 * docs/api/settings_API.md §4 控件映射表 + §3.2 热更新映射表；类型对齐 settings.types.ts（扁平结构）。
 * 保存策略：原地 Object.assign 合并——CaptureRepository 持有 settings 引用并按次动态读取字段，
 * 因此路径/阈值/分割线等改动无需重启即对写入链路生效（settings_API.md §3.2 末行语义）。
 */
import { FuzzySuggestModal, Notice, normalizePath, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian'
import type { App, ButtonComponent, DropdownComponent, Plugin, SliderComponent, TextAreaComponent, TextComponent, ToggleComponent } from 'obsidian'
import type { AetherLogSettings, QuickNoteStorageMode } from './types/settings.types'
import { validateSettings } from './types/settings.types'
import type { AetherLogGlobal } from './types/capture.types'
import { getDayFilePath } from './utils/date-utils'
import { setAutoStartOnBoot } from './services/window-minimizer'

/** main.ts 主插件类的最小结构契约（AetherLogPlugin 满足；saveData 为 Plugin 基类公共方法） */
export interface AetherLogPluginLike extends Plugin {
  settings: AetherLogSettings
}

/** Electron globalShortcut 合法格式（与 settings.types.ts 校验正则一致；原正则未导出，此处同款声明） */
const SHORTCUT_RE = /^(?:(?:Ctrl|Alt|Shift|Super)\+)+(?:[A-Za-z0-9]|F\d{1,2}|Space|Enter|Esc|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|PrintScreen|Insert|Delete|Backspace)$/

/** 热更新关注字段（settings_API.md §3.2）：变更后应即时作用于监听/速记/托盘/语音适配器 */
const HOT_RELOAD_KEYS: readonly string[] = [
  'clipboardEnabled', 'clipboardPollingIntervalMs', 'captureContentTypes',
  'quickNoteEnabled', 'quickNoteShortcut', 'trayEnabled',
  'voiceBackend', 'capswriterBaseUrl', 'capswriterAuthToken', 'webSpeechLang',
]

export default class AetherLogSettingsTab extends PluginSettingTab {
  public readonly plugin: AetherLogPluginLike
  /** 设置页 ID：B 窗口 M7 托盘菜单经 app.setting.openTabById('aetherlog') 打开本页，勿改 */
  public readonly id = 'aetherlog'
  public readonly name = 'AetherLog'
  /** 快捷键录制期间挂在 document 上的监听清理函数（display/hide 时卸载防泄漏） */
  private recorderCleanup: (() => void) | null = null

  public constructor(app: App, plugin: AetherLogPluginLike) {
    super(app, plugin)
    this.plugin = plugin
  }

  public override display(): void {
    this.stopShortcutRecorder()
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl('h1', { text: 'AetherLog 设置' })
    containerEl.createDiv({ cls: 'aetherlog-version-line' }).innerHTML =
      `<small>版本 v${this.plugin.manifest.version} · ` +
      '<a href="https://github.com/FancyLin/AetherLog" target="_blank" rel="noopener">项目文档</a></small>'
    this.renderStatusSection(containerEl)
    this.renderClipboardSection(containerEl)
    this.renderQuickNoteSection(containerEl)
    this.renderVoiceSection(containerEl)
    this.renderTraySection(containerEl)
    this.renderWritingSection(containerEl)
    this.renderDedupSection(containerEl)
    this.renderDataSection(containerEl)
    this.renderAboutSection(containerEl)
  }

  public override hide(): void {
    this.stopShortcutRecorder()
    super.hide()
  }

  /** 每个控件变更后立即调用：原地合并 → 持久化 → 按 §3.2 触发热更新 */
  public async saveSettingsSafe(patch: Partial<AetherLogSettings>): Promise<void> {
    Object.assign(this.plugin.settings, patch)
    await this.plugin.saveData(this.plugin.settings)
    this.applyHotReload(patch)
  }

  /** Coming Soon 统一视觉：置灰 + data-phase 徽章 + 点击弹 Notice（任务书硬指标） */
  private markComingSoon(setting: Setting, phase: 2 | 3): void {
    setting.setDisabled(true)
    setting.settingEl.addClass('aetherlog-coming-soon')
    setting.settingEl.dataset.phase = String(phase)
    setting.settingEl.addEventListener('click', (evt: Event): void => {
      evt.preventDefault()
      evt.stopPropagation()
      new Notice(`🔜 此功能 Phase ${phase} 推出，敬请期待`, 3000)
    })
  }

  /** Section 标题（统一 .setting-item-heading 样式，对齐 UI 规范 §2.1） */
  private renderSectionHeading(containerEl: HTMLElement, text: string, anchorId: string): void {
    const heading = containerEl.createEl('h2', { cls: 'setting-item-heading', text })
    heading.setAttr('id', anchorId)
  }

  /** 卸载快捷键录制监听（若正在录制） */
  private stopShortcutRecorder(): void {
    if (this.recorderCleanup !== null) {
      this.recorderCleanup()
      this.recorderCleanup = null
    }
  }

  /** settings_API.md §3.2 热更新映射：防御式调用插件/桥接暴露的可选钩子；未暴露时提示重启生效 */
  private applyHotReload(patch: Partial<AetherLogSettings>): void {
    if (!Object.keys(patch).some((key: string): boolean => HOT_RELOAD_KEYS.includes(key))) return
    type HotReloadHost = {
      reloadClipboardConfig?: () => unknown
      applyQuickNoteSettings?: () => unknown
      reloadTray?: () => unknown
    }
    // 防御式访问：A 窗口 main.ts / B 窗口托盘暴露钩子后自动生效，未暴露时不抛错
    const pluginHooks = this.plugin as AetherLogPluginLike & HotReloadHost
    const bridgeHooks = this.app.aetherlog as (AetherLogGlobal & HotReloadHost) | undefined
    const hasHook =
      bridgeHooks?.reloadClipboardConfig !== undefined ||
      bridgeHooks?.applyQuickNoteSettings !== undefined ||
      pluginHooks.reloadClipboardConfig !== undefined ||
      pluginHooks.applyQuickNoteSettings !== undefined ||
      pluginHooks.reloadTray !== undefined
    if (!hasHook) {
      new Notice('📝 [AetherLog] 此设置更改将在重启插件后生效', 3000)
      return
    }
    bridgeHooks?.reloadClipboardConfig?.()
    bridgeHooks?.applyQuickNoteSettings?.()
    pluginHooks.reloadClipboardConfig?.()
    pluginHooks.applyQuickNoteSettings?.()
    pluginHooks.reloadTray?.()
  }

  /** 状态指示条（UI 规范 §2.2 Section 0：sticky top；MVP 反映设置态+环境态，今日计数打开时读取一次） */
  private renderStatusSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    const bar = containerEl.createDiv({ cls: 'aetherlog-status-bar' })
    const clipLine = bar.createDiv({ cls: 'aetherlog-status-line' })
    if (s.clipboardEnabled) {
      clipLine.setText(`🟢 剪贴板监听：运行中 (${s.clipboardPollingIntervalMs}ms) · 今日已捕获 … 条`)
      void this.countTodayCaptures().then((count: number): void => {
        clipLine.setText(
          `🟢 剪贴板监听：运行中 (${this.plugin.settings.clipboardPollingIntervalMs}ms) · 今日已捕获 ${count} 条`
        )
      })
    } else {
      clipLine.setText('🔴 剪贴板监听：已停用（总开关已关闭，历史捕获数据不受影响）')
    }
    const trayText = !this.isElectronAvailable()
      ? '🔴 托盘功能：当前环境不支持（可继续使用命令面板快捷键）'
      : s.trayEnabled
        ? '🟡 托盘功能：已启用（托盘模块接入后显示图标）'
        : '⚪ 托盘功能：已在设置中停用'
    const trayLine = bar.createDiv({ cls: 'aetherlog-status-line', text: trayText })
    const voiceLine = bar.createDiv({
      cls: 'aetherlog-status-line',
      text: '🔴 语音识别：Coming Soon（点击跳转设置）',
    })
    const scrollTo = (anchorId: string): void => {
      containerEl.querySelector(`#${anchorId}`)?.scrollIntoView({ behavior: 'smooth' })
    }
    clipLine.addEventListener('click', (): void => scrollTo('aetherlog-section-clipboard'))
    trayLine.addEventListener('click', (): void => scrollTo('aetherlog-section-tray'))
    voiceLine.addEventListener('click', (): void => scrollTo('aetherlog-section-voice'))
  }

  /** 读取今日日文件统计已捕获条数（按元信息首行锚点计数；文件不存在返回 0） */
  private async countTodayCaptures(): Promise<number> {
    try {
      const filePath = normalizePath(getDayFilePath(this.plugin.settings.clipboardOutputPath))
      const file = this.app.vault.getAbstractFileByPath(filePath)
      if (!(file instanceof TFile)) return 0
      const content = await this.app.vault.read(file)
      return (content.match(/^> \*\*时间戳:\*\*/gm) ?? []).length
    } catch {
      return 0
    }
  }

  /** 当前运行环境是否可访问 Electron（托盘/全局快捷键能力探测） */
  private isElectronAvailable(): boolean {
    try {
      const requireFn = (window as Window & { require?: (id: string) => unknown }).require
      if (typeof requireFn !== 'function') return false
      const electron = requireFn('electron')
      return typeof electron === 'object' && electron !== null
    } catch {
      return false
    }
  }

  /** 📋 Section 1 剪贴板捕获（UI 规范 §2.2 · settings_API.md §4 Section 1） */
  private renderClipboardSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    this.renderSectionHeading(containerEl, '📋 剪贴板捕获', 'aetherlog-section-clipboard')
    // S1 总开关（关闭时下方显示灰色提示，文案对齐 UI 规范 §2.2）
    new Setting(containerEl)
      .setName('启用剪贴板监听')
      .setDesc('关闭后不捕获任何复制/剪切内容，之前的捕获数据不会删除')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.clipboardEnabled).onChange(async (val: boolean): Promise<void> => {
          await this.saveSettingsSafe({ clipboardEnabled: val })
          this.display() // 重渲染以显示/隐藏「已暂停」提示
        })
      )
    if (!s.clipboardEnabled) {
      containerEl.createDiv({ cls: 'aetherlog-paused-hint', text: '剪贴板监听已暂停，之前的捕获数据不会删除' })
    }
    // S2 输出路径（Text + 📁 文件夹选择 + 路径校验）
    const pathSetting = new Setting(containerEl)
      .setName('剪贴板输出路径')
      .setDesc('日文件输出根路径，相对 Vault 根；不允许包含 ../（默认 aetherlog/clipboard）')
    this.addPathTextInput(
      pathSetting,
      s.clipboardOutputPath,
      '剪贴板输出路径',
      async (value: string): Promise<void> => {
        await this.saveSettingsSafe({ clipboardOutputPath: value })
      },
      true
    )
    // S4 轮询间隔：滑杆（50~2000 步长 50）+ 数字输入（50~5000 clamp）双控件同步
    const intervalSetting = new Setting(containerEl)
      .setName('监听轮询间隔（毫秒）')
      .setDesc('建议 200ms，更短更及时但更费电；手机端请调到 500ms 以上')
    let sliderRef: SliderComponent | null = null
    let numberRef: TextComponent | null = null
    intervalSetting.addSlider((slider: SliderComponent): SliderComponent => {
      sliderRef = slider
      return slider
        .setLimits(50, 2000, 50)
        .setValue(s.clipboardPollingIntervalMs)
        .setDynamicTooltip()
        .onChange(async (val: number): Promise<void> => {
          numberRef?.setValue(String(val))
          await this.saveSettingsSafe({ clipboardPollingIntervalMs: val })
        })
    })
    intervalSetting.addText((text: TextComponent): TextComponent => {
      numberRef = text
      text.inputEl.type = 'number'
      text.inputEl.min = '50'
      text.inputEl.max = '5000'
      text.inputEl.step = '10'
      text.setValue(String(s.clipboardPollingIntervalMs))
      text.inputEl.addEventListener('change', async (): Promise<void> => {
        const raw = Number.parseInt(text.getValue(), 10)
        const clamped = Number.isNaN(raw) ? s.clipboardPollingIntervalMs : Math.min(5000, Math.max(50, raw))
        text.setValue(String(clamped))
        sliderRef?.setValue(clamped)
        await this.saveSettingsSafe({ clipboardPollingIntervalMs: clamped })
      })
      return text
    })
    // S3 单条最大字数
    const maxLengthSetting = new Setting(containerEl)
      .setName('单条最大字数')
      .setDesc('单条超过此长度将自动截断并标记 #type/truncated；0 = 不限制')
    this.addNumberInput(
      maxLengthSetting,
      s.maxContentLengthChars,
      0,
      10000000,
      async (value: number): Promise<void> => {
        await this.saveSettingsSafe({ maxContentLengthChars: value })
      }
    )
    // S5 捕获内容类型（4 项 Checkbox 组）
    new Setting(containerEl)
      .setName('捕获内容类型')
      .setDesc('S5：MVP 仅纯文本可用；富文本/图片/文件路径将于 Phase 2 推出')
    this.renderCaptureTypesGroup(containerEl)
    // S18 启动行为
    new Setting(containerEl)
      .setName('启动时自动开启监听')
      .setDesc('S18 Obsidian 启动加载插件后自动开启剪贴板监听')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.autoStartCaptureOnLoad).onChange(async (val: boolean): Promise<void> => {
          await this.saveSettingsSafe({ autoStartCaptureOnLoad: val })
        })
      )
  }

  /** 带校验的相对路径文本控件：../ 穿越或以 / 开头时拒绝保存并标红（settings_API.md §6） */
  private addPathTextInput(
    setting: Setting,
    current: string,
    label: string,
    onValid: (value: string) => Promise<void>,
    withFolderButton: boolean
  ): void {
    setting.addText((text: TextComponent): TextComponent => {
      text.setPlaceholder('aetherlog/...')
      text.setValue(current)
      text.inputEl.addEventListener('change', async (): Promise<void> => {
        const value = this.validateRelativePath(text, label)
        if (value === null) return
        await onValid(value)
      })
      return text
    })
    if (!withFolderButton) return
    setting.addExtraButton((btn) =>
      btn
        .setIcon('folder')
        .setTooltip('选择文件夹')
        .onClick((): void => {
          new FolderSuggestModal(this.app, async (folderPath: string): Promise<void> => {
            await onValid(folderPath)
            this.display()
          }).open()
        })
    )
  }

  /** 校验相对路径合法性；失败时输入框标红 + Notice 并返回 null（文案对齐 settings.types.ts） */
  private validateRelativePath(text: TextComponent, label: string): string | null {
    const value = text.getValue().trim()
    let error: string | null = null
    if (value.length === 0) error = `${label}不能为空`
    else if (value.includes('../') || value.includes('..\\')) error = `${label}不允许包含 ../（禁止路径穿越）`
    else if (value.startsWith('/')) error = `${label}必须是相对 Vault 根的路径，不能以 / 开头`
    if (error !== null) {
      text.inputEl.addClass('aetherlog-input-error')
      new Notice(`⚠️ ${error}`, 3000)
      return null
    }
    text.inputEl.removeClass('aetherlog-input-error')
    return value
  }

  /** 数字输入控件：change（失焦/回车）时 clamp 后保存，避免逐键触发（settings_API.md §6 超限 clamp） */
  private addNumberInput(
    setting: Setting,
    current: number,
    min: number,
    max: number,
    onSaved: (value: number) => Promise<void>
  ): void {
    setting.addText((text: TextComponent): TextComponent => {
      text.inputEl.type = 'number'
      text.inputEl.min = String(min)
      text.inputEl.max = String(max)
      text.setValue(String(current))
      text.inputEl.addEventListener('change', async (): Promise<void> => {
        const raw = Number.parseInt(text.getValue(), 10)
        const clamped = Number.isNaN(raw) ? current : Math.min(max, Math.max(min, raw))
        text.setValue(String(clamped))
        await onSaved(clamped)
      })
      return text
    })
  }

  /** S5 捕获内容类型 4 项 Checkbox 组：纯文本可用，其余三项 Coming Soon 置灰 */
  private renderCaptureTypesGroup(containerEl: HTMLElement): void {
    const types = this.plugin.settings.captureContentTypes
    const group = containerEl.createDiv({ cls: 'aetherlog-checkbox-group' })
    const addItem = (label: string, checked: boolean, phase: 2 | null): void => {
      const wrap = group.createDiv({ cls: 'aetherlog-checkbox-item' })
      const input = wrap.createEl('input', { type: 'checkbox' })
      input.checked = checked
      wrap.createSpan({ text: label })
      if (phase === null) {
        input.addEventListener('change', async (): Promise<void> => {
          await this.saveSettingsSafe({
            captureContentTypes: { ...this.plugin.settings.captureContentTypes, plainText: input.checked },
          })
        })
        return
      }
      wrap.addClass('aetherlog-coming-soon')
      wrap.dataset.phase = String(phase)
      input.disabled = true
      wrap.addEventListener('click', (evt: Event): void => {
        evt.preventDefault()
        evt.stopPropagation()
        new Notice(`🔜 此功能 Phase ${phase} 推出，敬请期待`, 3000)
      })
    }
    addItem('纯文本', types.plainText, null)
    addItem('富文本 HTML', types.richTextHtml, 2)
    addItem('图片', types.image, 2)
    addItem('文件路径', types.filePath, 2)
  }

  /** ⚡ Section 2 快捷速记面板（UI 规范 §2.2 · settings_API.md §4 Section 2） */
  private renderQuickNoteSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    this.renderSectionHeading(containerEl, '⚡ 快捷速记面板', 'aetherlog-section-quicknote')
    // S7 总开关
    new Setting(containerEl)
      .setName('启用速记面板')
      .setDesc('S7 总开关；关闭后速记命令与快捷键停用（托盘菜单项保留但禁用）')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.quickNoteEnabled).onChange(async (val: boolean): Promise<void> => {
          await this.saveSettingsSafe({ quickNoteEnabled: val })
        })
      )
    // S8 快捷键录制控件（UI 规范 §2.2：按钮录制 + 冲突检测结果 UI）
    const shortcutSetting = new Setting(containerEl)
      .setName('速记面板全局快捷键')
      .setDesc('Electron globalShortcut 标准格式，至少一个修饰键 + 一个普通键（如 Ctrl+Alt+Space）')
    const valueEl = shortcutSetting.controlEl.createSpan({
      cls: 'aetherlog-shortcut-value',
      text: s.quickNoteShortcut,
    })
    shortcutSetting.addButton((btn: ButtonComponent): ButtonComponent => {
      btn.setButtonText('🎙️ 点击录制快捷键').setTooltip('录制新的全局快捷键（Esc 取消）')
      btn.buttonEl.addClass('aetherlog-shortcut-recorder')
      btn.onClick((): void => this.startShortcutRecording(btn, valueEl))
      return btn
    })
    // S9 存储模式（三选一；切换后条件字段重渲染）
    new Setting(containerEl)
      .setName('速记存储模式')
      .setDesc('S9 三选一：默认并入同日剪贴板日文件，仅以 Callout 颜色区分来源')
      .addDropdown((drop: DropdownComponent): DropdownComponent =>
        drop
          .addOption('merge-clipboard', '合并到剪贴板日文件（推荐）')
          .addOption('separate', '独立文件夹存储')
          .addOption('daily-notes', '写入 Daily Notes 对应章节')
          .setValue(s.quickNoteStorageMode)
          .onChange(async (val: string): Promise<void> => {
            await this.saveSettingsSafe({ quickNoteStorageMode: val as QuickNoteStorageMode })
            this.display() // 条件显示字段重渲染
          })
      )
    if (s.quickNoteStorageMode === 'separate') {
      const separateSetting = new Setting(containerEl)
        .setName('速记独立存储路径')
        .setDesc('quickNoteStorageMode = 独立文件夹存储时的根路径（默认 aetherlog/quick-notes）')
      this.addPathTextInput(
        separateSetting,
        s.quickNoteSeparatePath,
        '速记独立存储路径',
        async (value: string): Promise<void> => {
          await this.saveSettingsSafe({ quickNoteSeparatePath: value })
        },
        true
      )
    }
    if (s.quickNoteStorageMode === 'daily-notes') {
      new Setting(containerEl)
        .setName('Daily Notes 段落标题')
        .setDesc('写入 Daily Notes 时追加的章节标题（默认 ## 💡 AetherLog 速记）')
        .addText((text: TextComponent): TextComponent => {
          text.setValue(s.quickNoteDailyNotesHeading)
          text.inputEl.addEventListener('change', async (): Promise<void> => {
            const value = text.getValue().trim()
            if (value.length === 0) {
              text.inputEl.addClass('aetherlog-input-error')
              new Notice('⚠️ Daily Notes 段落标题不能为空', 3000)
              return
            }
            text.inputEl.removeClass('aetherlog-input-error')
            await this.saveSettingsSafe({ quickNoteDailyNotesHeading: value })
          })
          return text
        })
    }
    // S10 分类预设列表（可编辑/拖拽排序/增删）
    this.renderCategoryEditor(containerEl)
  }

  /** 开始录制：按钮变红提示，监听下一次 keydown（capture 阶段拦截，Esc 取消） */
  private startShortcutRecording(button: ButtonComponent, valueEl: HTMLElement): void {
    this.stopShortcutRecorder()
    const original = valueEl.getText()
    button.setButtonText('⏺ 请按下新快捷键...')
    button.buttonEl.addClass('recording')
    const handler = (evt: KeyboardEvent): void => {
      evt.preventDefault()
      evt.stopPropagation()
      if (evt.key === 'Escape' && !evt.ctrlKey && !evt.altKey && !evt.metaKey) {
        void this.finishShortcutRecording(button, valueEl, original, null)
        return
      }
      const shortcut = this.shortcutFromEvent(evt)
      if (shortcut === null) return // 仅修饰键，继续等待
      void this.finishShortcutRecording(button, valueEl, original, shortcut)
    }
    document.addEventListener('keydown', handler, { capture: true })
    this.recorderCleanup = (): void => {
      document.removeEventListener('keydown', handler, { capture: true })
      button.buttonEl.removeClass('recording')
      button.setButtonText('🎙️ 点击录制快捷键')
    }
  }

  /** 录制结束：格式校验 + 占用探测；失败标红保留旧值，成功保存并绿显（UI 规范 §2.2） */
  private async finishShortcutRecording(
    button: ButtonComponent,
    valueEl: HTMLElement,
    original: string,
    shortcut: string | null
  ): Promise<void> {
    this.stopShortcutRecorder() // 恢复按钮文案与样式
    if (shortcut === null) {
      valueEl.setText(original) // Esc 取消
      return
    }
    if (!SHORTCUT_RE.test(shortcut)) {
      valueEl.setText(original)
      new Notice(`⚠️ 快捷键格式非法：${shortcut}（至少一个修饰键 + 一个普通键），已保留原快捷键`, 4000)
      return
    }
    if (this.probeShortcutAvailability(shortcut) === true) {
      valueEl.setText(original)
      new Notice(`⚠️ 已被其他程序占用，请更换（原快捷键 ${original} 保留）`, 4000)
      return
    }
    valueEl.setText(shortcut)
    valueEl.addClass('aetherlog-shortcut-value-ok')
    window.setTimeout((): void => valueEl.removeClass('aetherlog-shortcut-value-ok'), 1500)
    await this.saveSettingsSafe({ quickNoteShortcut: shortcut })
    const bridge = (this.app as unknown as { aetherlog?: { reloadGlobalShortcut?: () => void } }).aetherlog
    if (bridge?.reloadGlobalShortcut) bridge.reloadGlobalShortcut()
    else new Notice('快捷键已保存，重启插件后生效', 4000)
    new Notice(`✅ 全局快捷键已更新：${shortcut}`, 2000)
  }

  /** 从 KeyboardEvent 构造 globalShortcut 格式字符串；无法构成合法组合（如仅修饰键）返回 null */
  private shortcutFromEvent(evt: KeyboardEvent): string | null {
    const parts: string[] = []
    if (evt.ctrlKey) parts.push('Ctrl')
    if (evt.altKey) parts.push('Alt')
    if (evt.shiftKey) parts.push('Shift')
    if (evt.metaKey) parts.push('Super')
    if (parts.length === 0) return null
    const key = evt.key
    let main: string | null = null
    if (key.length === 1) main = key.toUpperCase()
    else if (key === ' ') main = 'Space'
    else if (/^F\d{1,2}$/.test(key)) main = key
    else if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Esc', 'Tab', 'PrintScreen', 'Insert', 'Delete', 'Backspace'].includes(key)
    ) {
      main = key
    }
    if (main === null) return null
    return [...parts, main].join('+')
  }

  /** 探测快捷键是否被占用：register 成功后立即 unregister（false=空闲）；无法探测返回 null */
  private probeShortcutAvailability(shortcut: string): boolean | null {
    try {
      const requireFn = (window as Window & { require?: (id: string) => unknown }).require
      if (typeof requireFn !== 'function') return null
      const electron = requireFn('electron')
      if (typeof electron !== 'object' || electron === null) return null
      const globalShortcut = (
        electron as {
          globalShortcut?: {
            register?: (accelerator: string) => boolean
            unregister?: (accelerator: string) => void
          }
        }
      ).globalShortcut
      if (
        globalShortcut === undefined ||
        typeof globalShortcut.register !== 'function' ||
        typeof globalShortcut.unregister !== 'function'
      ) {
        return null
      }
      if (!globalShortcut.register(shortcut)) return true
      globalShortcut.unregister(shortcut)
      return false
    } catch {
      return null
    }
  }

  /** S10 分类预设列表：每行可编辑/删除、底部新增、HTML5 拖拽排序；重复或非法名称拒绝保存 */
  private renderCategoryEditor(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('速记分类预设')
      .setDesc('每个分类 ≤20 字符，不允许 # : [ ] / \\ 等字符；可拖动排序、编辑、删除、新增')
    const listEl = containerEl.createDiv({ cls: 'aetherlog-category-list' })
    this.renderCategoryRows(listEl)
  }

  /** 渲染分类行（结构变化后整体重绘；文本编辑实时校验、失败回退显示） */
  private renderCategoryRows(listEl: HTMLElement): void {
    listEl.empty()
    const categories = [...this.plugin.settings.quickNoteCategories]
    let dragIndex: number | null = null
    categories.forEach((category: string, index: number): void => {
      const row = listEl.createDiv({ cls: 'aetherlog-category-row' })
      row.setAttr('draggable', 'true')
      row.createSpan({ cls: 'aetherlog-category-drag-handle', text: '≡' })
      const input = row.createEl('input', { type: 'text', cls: 'aetherlog-category-input' })
      input.value = category
      input.placeholder = '输入分类名'
      const commit = async (): Promise<void> => {
        const next = [...this.plugin.settings.quickNoteCategories]
        next[index] = input.value.trim()
        const error = this.validateCategories(next)
        if (error !== null) {
          input.addClass('aetherlog-input-error')
          new Notice(`⚠️ ${error}`, 3000)
          input.value = category
          return
        }
        input.removeClass('aetherlog-input-error')
        await this.saveSettingsSafe({ quickNoteCategories: next })
      }
      input.addEventListener('change', (): void => void commit())
      row
        .createEl('button', { text: '✏️', cls: 'aetherlog-category-save' })
        .addEventListener('click', (): void => void commit())
      row.createEl('button', { text: '🗑️', cls: 'aetherlog-category-delete' }).addEventListener(
        'click',
        (): void => {
          void (async (): Promise<void> => {
            const next = this.plugin.settings.quickNoteCategories.filter(
              (_item: string, i: number): boolean => i !== index
            )
            await this.saveSettingsSafe({ quickNoteCategories: next })
            this.renderCategoryRows(listEl)
          })()
        }
      )
      row.addEventListener('dragstart', (): void => {
        dragIndex = index
      })
      row.addEventListener('dragover', (evt: DragEvent): void => {
        evt.preventDefault()
        row.addClass('aetherlog-drag-over')
      })
      row.addEventListener('dragleave', (): void => row.removeClass('aetherlog-drag-over'))
      row.addEventListener('drop', (evt: DragEvent): void => {
        evt.preventDefault()
        row.removeClass('aetherlog-drag-over')
        if (dragIndex === null || dragIndex === index) return
        const next = [...this.plugin.settings.quickNoteCategories]
        const moved = next.splice(dragIndex, 1)[0]
        next.splice(index, 0, moved)
        dragIndex = null
        void this.saveSettingsSafe({ quickNoteCategories: next }).then((): void => this.renderCategoryRows(listEl))
      })
    })
    const addBtn = listEl.createEl('button', { text: '➕ 新增分类', cls: 'aetherlog-category-add' })
    addBtn.addEventListener('click', (): void => {
      const existing = this.plugin.settings.quickNoteCategories
      let name = '新分类'
      let suffix = 1
      while (existing.includes(name)) {
        suffix += 1
        name = `新分类${suffix}`
      }
      void this.saveSettingsSafe({ quickNoteCategories: [...existing, name] }).then((): void => {
        this.renderCategoryRows(listEl)
        const inputs = listEl.querySelectorAll<HTMLInputElement>('.aetherlog-category-input')
        inputs[inputs.length - 1]?.focus()
      })
    })
  }

  /** 校验分类列表（复用 validateSettings 规则 + UI 规范 §2.2 重复名拒绝），返回首条错误或 null */
  private validateCategories(categories: readonly string[]): string | null {
    if (categories.some((item: string, i: number): boolean => categories.indexOf(item) !== i)) {
      return '存在重复的分类名，不允许保存'
    }
    const candidate: AetherLogSettings = {
      ...this.plugin.settings,
      quickNoteCategories: [...categories],
    }
    const result = validateSettings(candidate)
    if (result.valid) return null
    return result.errors.find((msg: string): boolean => msg.includes('分类')) ?? null
  }

  /** 🎙️ Section 3 语音识别（UI 规范 §2.2：Phase 2 占位，全 Section Coming Soon 置灰） */
  private renderVoiceSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    this.renderSectionHeading(containerEl, '🎙️ 语音识别', 'aetherlog-section-voice')
    const backend = new Setting(containerEl)
      .setName('语音识别后端')
      .setDesc('Phase 2 推出：本地 CapsWriter-Offline（推荐）或浏览器原生 Web Speech API')
    backend.addDropdown((drop: DropdownComponent): DropdownComponent =>
      drop
        .addOption('disabled', '禁用（Coming Soon）')
        .addOption('capswriter', 'CapsWriter-Offline（推荐本地）')
        .addOption('webspeech', 'Web Speech API（浏览器原生）')
        .setValue(s.voiceBackend)
    )
    this.markComingSoon(backend, 2)
    const urlSetting = new Setting(containerEl)
      .setName('CapsWriter 服务地址')
      .setDesc('CapsWriter-Offline HTTP 服务 Base URL（默认 http://127.0.0.1:19102，含协议与端口）')
    urlSetting.addText((text: TextComponent): TextComponent =>
      text.setPlaceholder('http://127.0.0.1:19102').setValue(s.capswriterBaseUrl)
    )
    this.markComingSoon(urlSetting, 2)
    const tokenSetting = new Setting(containerEl)
      .setName('CapsWriter 鉴权 Token')
      .setDesc('若 CapsWriter 启用 API Key 鉴权时填写；保存时自动 base64 混淆')
    tokenSetting.addText((text: TextComponent): TextComponent => {
      text.inputEl.type = 'password'
      return text.setValue(s.capswriterAuthToken)
    })
    this.markComingSoon(tokenSetting, 2)
    const langSetting = new Setting(containerEl)
      .setName('Web Speech 语言')
      .setDesc('浏览器原生语音识别语言代码（Phase 2 默认跟随 Obsidian 语言设置）')
    langSetting.addDropdown((drop: DropdownComponent): DropdownComponent =>
      drop.addOption('zh-CN', '简体中文（zh-CN）').addOption('en-US', 'English（en-US）').setValue(s.webSpeechLang)
    )
    this.markComingSoon(langSetting, 2)
    const testSetting = new Setting(containerEl)
      .setName('连接测试')
      .setDesc('测试 CapsWriter /health 接口连通性，结果显示在按钮右侧')
    testSetting.addButton((btn: ButtonComponent): ButtonComponent => btn.setButtonText('🧪 测试连接'))
    this.markComingSoon(testSetting, 2)
  }

  /** 🔔 Section 4 托盘与通知（UI 规范 §2.2 · settings_API.md §4 Section 4） */
  private renderTraySection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    this.renderSectionHeading(containerEl, '🔔 托盘与通知', 'aetherlog-section-tray')
    // S17 托盘开关（环境不支持时置灰提示，文案对齐 UI 规范 §2.2）
    const traySetting = new Setting(containerEl)
      .setName('启用系统托盘')
      .setDesc('S17 当前环境不支持 Electron Tray API 时，您仍可使用命令面板/全局快捷键操作')
    traySetting.addToggle((toggle: ToggleComponent): ToggleComponent =>
      toggle.setValue(s.trayEnabled).onChange(async (val: boolean): Promise<void> => {
        await this.saveSettingsSafe({ trayEnabled: val })
      })
    )
    if (!this.isElectronAvailable()) {
      traySetting.setDisabled(true)
      containerEl.createDiv({
        cls: 'aetherlog-red-hint',
        text: '当前环境不支持 Electron Tray API，您仍可使用命令面板/全局快捷键操作',
      })
    }
    new Setting(containerEl)
      .setName('显示托盘通知')
      .setDesc('捕获成功后弹系统气泡通知；剪贴板每分钟最多通知一次，速记与语音不受此限制')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.showTrayNotification).onChange(async (val: boolean): Promise<void> => {
          await this.saveSettingsSafe({ showTrayNotification: val })
        })
      )
    const throttleSetting = new Setting(containerEl)
      .setName('剪贴板通知节流间隔（秒）')
      .setDesc('默认 60 秒；0 = 关闭剪贴板通知节流（不推荐刷屏）')
    this.addNumberInput(
      throttleSetting,
      s.clipboardNotifyThrottleSecs,
      0,
      3600,
      async (value: number): Promise<void> => {
        await this.saveSettingsSafe({ clipboardNotifyThrottleSecs: value })
      }
    )
    // G3：关闭窗口最小化到托盘（高风险，默认关闭；拦截器动态读取开关，关闭后即时恢复默认关窗行为）
    new Setting(containerEl)
      .setName('关闭窗口时最小化到托盘')
      .setDesc('⚠️ 高风险：开启后点击 Obsidian 关闭按钮不会退出，而是最小化到系统托盘。右键托盘图标选择「退出 AetherLog」才能真退出（需系统托盘已启用）')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.minimizeToTrayOnClose).onChange(async (val: boolean): Promise<void> => {
          await this.saveSettingsSafe({ minimizeToTrayOnClose: val })
          if (val) {
            new Notice('[AetherLog] 已启用「最小化到托盘」，右键托盘图标可退出', 5000)
          }
        })
      )
    // G3：开机自启动（Windows shell:Startup 快捷方式；仅设置成功后才持久化开关）
    new Setting(containerEl)
      .setName('开机自启动')
      .setDesc('开启后 Windows 登录时自动启动 Obsidian（在 shell:Startup 创建快捷方式，关闭时删除；需系统托盘已启用）')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.autoStartOnBoot).onChange(async (val: boolean): Promise<void> => {
          const ok = await setAutoStartOnBoot(val)
          if (ok) {
            await this.saveSettingsSafe({ autoStartOnBoot: val })
            new Notice(`[AetherLog] 开机自启已${val ? '启用' : '禁用'}`, 3000)
          } else {
            new Notice('[AetherLog] 开机自启设置失败，请检查权限', 5000)
          }
        })
      )
    containerEl.createDiv({
      cls: 'aetherlog-info-text',
      text: 'ℹ️ 已注册命令：打开速记面板（可在命令面板绑定快捷键）· 托盘菜单项与全局快捷键信息将在 M7 托盘模块接入后显示',
    })
  }

  /** 📝 写入行为（settings_API.md §4「写入」组；分割线/日期格式为 Phase 2 Coming Soon） */
  private renderWritingSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    this.renderSectionHeading(containerEl, '📝 写入行为', 'aetherlog-section-writing')
    const foldSetting = new Setting(containerEl)
      .setName('长文自动折叠阈值（字数）')
      .setDesc('超过此字数的正文自动包 details 折叠；0 = 永不折叠（不推荐长文刷屏）')
    this.addNumberInput(
      foldSetting,
      s.foldContentThresholdChars,
      0,
      50000,
      async (value: number): Promise<void> => {
        await this.saveSettingsSafe({ foldContentThresholdChars: value })
      }
    )
    new Setting(containerEl)
      .setName('写入日统计头')
      .setDesc('是否在日文件顶部写入统计信息头；关闭后仅写 YAML frontmatter，减少回写次数')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle.setValue(s.includeDailyStatsHeader).onChange(async (val: boolean): Promise<void> => {
          await this.saveSettingsSafe({ includeDailyStatsHeader: val })
        })
      )
    const separatorSetting = new Setting(containerEl)
      .setName('记录分割线')
      .setDesc('记录之间的分割线字符串（默认 50 个 ─ 字符）；Phase 2 开放自定义，避免误改导致记录边界无法区分')
    separatorSetting.addText((text: TextComponent): TextComponent => text.setValue(s.recordSeparatorLine))
    this.markComingSoon(separatorSetting, 2)
    const formatSetting = new Setting(containerEl)
      .setName('日文件名日期格式')
      .setDesc('moment() 格式字符串，默认 YYYY-MM-DD；Phase 2 开放自定义（不允许路径分隔符）')
    formatSetting.addText((text: TextComponent): TextComponent => text.setValue(s.dailyFileNameDateFormat))
    this.markComingSoon(formatSetting, 2)
  }

  /** 🔀 去重与过滤（settings_API.md §4「过滤」组：S13~S16 整组 Coming Soon，Phase 2 解禁） */
  private renderDedupSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings
    this.renderSectionHeading(containerEl, '🔀 去重与过滤', 'aetherlog-section-dedup')
    containerEl.createDiv({ cls: 'aetherlog-red-hint', text: '以下功能将在 Phase 2 推出，敬请期待' })
    const dedupeSetting = new Setting(containerEl)
      .setName('启用哈希去重')
      .setDesc('S13 开启后最近 N 条重复内容不再写入；关闭 = 全量存储')
    dedupeSetting.addToggle((toggle: ToggleComponent): ToggleComponent => toggle.setValue(s.dedupeEnabled))
    this.markComingSoon(dedupeSetting, 2)
    const windowSetting = new Setting(containerEl)
      .setName('去重回看窗口（条）')
      .setDesc('S14 只与最近 N 条记录比对哈希；0 = 与当天全量对比（性能差）')
    windowSetting.addText((text: TextComponent): TextComponent => {
      text.inputEl.type = 'number'
      return text.setValue(String(s.dedupeLookbackWindow))
    })
    this.markComingSoon(windowSetting, 2)
    const appBlacklistSetting = new Setting(containerEl)
      .setName('来源应用黑名单')
      .setDesc('S15 每行一个进程名（如 Bitwarden.exe，大小写不敏感，精确匹配）')
    appBlacklistSetting.addTextArea((area: TextAreaComponent): TextAreaComponent => {
      area.inputEl.addClass('aetherlog-tag-patterns-input')
      return area.setValue(s.sourceAppBlacklist.join('\n'))
    })
    this.markComingSoon(appBlacklistSetting, 2)
    const keywordSetting = new Setting(containerEl)
      .setName('内容关键字黑名单')
      .setDesc('每行一条正则表达式，命中则不记录（重启插件后生效）')
    keywordSetting.addTextArea((area: TextAreaComponent): TextAreaComponent => {
      area.inputEl.addClass('aetherlog-tag-patterns-input')
      return area.setValue(s.keywordBlacklist.join('\n')).onChange(async (value: string): Promise<void> => {
        const lines = value.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line !== '')
        for (const [index, line] of lines.entries()) {
          try {
            new RegExp(line)
          } catch {
            new Notice(`⚠️ 第 ${index + 1} 行正则非法，未保存`, 4000)
            return
          }
        }
        await this.saveSettingsSafe({ keywordBlacklist: lines })
      })
    })
    const modeSetting = new Setting(containerEl)
      .setName('关键字匹配模式')
      .setDesc('substring 子串包含 / word 完整词边界 / regex 正则表达式')
    modeSetting.addDropdown((drop: DropdownComponent): DropdownComponent =>
      drop
        .addOption('substring', '子串包含（默认，性能好，易误伤）')
        .addOption('word', '完整词边界（准确率高）')
        .addOption('regex', '正则表达式（高级用户，注意 ReDoS）')
        .setValue(s.keywordBlacklistMode)
    )
    this.markComingSoon(modeSetting, 2)
  }

  /** 🧹 数据管理（UI 规范 §2.2 危险区边框 + 任务书 M6：3 个 Coming Soon + 立即整理按钮） */
  private renderDataSection(containerEl: HTMLElement): void {
    this.renderSectionHeading(containerEl, '🧹 数据管理', 'aetherlog-section-data')
    const danger = containerEl.createDiv({ cls: 'aetherlog-danger-section' })
    danger.createDiv({ cls: 'aetherlog-danger-hint', text: '以下三个功能将在 Phase 2/3 推出，敬请期待' })
    const openSetting = new Setting(danger)
      .setName('📂 打开 AetherLog 数据文件夹')
      .setDesc('在系统文件管理器中打开捕获数据目录（aetherlog/clipboard）')
    openSetting.addButton((btn: ButtonComponent): ButtonComponent => btn.setButtonText('📂 打开'))
    this.markComingSoon(openSetting, 2)
    const statSetting = new Setting(danger)
      .setName('📊 捕获数据统计')
      .setDesc('共捕获条数 / 日文件数 / 合计占用空间（打开设置时刷新 + 手动刷新按钮）')
    statSetting.addButton((btn: ButtonComponent): ButtonComponent => btn.setButtonText('📊 刷新统计'))
    this.markComingSoon(statSetting, 2)
    const clearSetting = new Setting(danger)
      .setName('⚠️ 清空所有 AetherLog 捕获数据')
      .setDesc('不可逆操作；删除前自动创建回收站备份文件夹（保留 30 天）')
    clearSetting.addButton((btn: ButtonComponent): ButtonComponent => {
      btn.setButtonText('清空全部数据')
      btn.buttonEl.addClass('mod-warning')
      return btn
    })
    this.markComingSoon(clearSetting, 3)
    const tidySetting = new Setting(danger)
      .setName('立即整理')
      .setDesc('合并去重当日捕获记录并重算日文件统计头')
    tidySetting.addButton((btn: ButtonComponent): ButtonComponent =>
      btn.setButtonText('🧹 立即整理（Phase 2 推出）')
    )
    this.markComingSoon(tidySetting, 2)
  }

  /** ℹ️ 关于（UI 规范 §2.2 Section 6：版本信息 / 链接区 / 已知约束提示） */
  private renderAboutSection(containerEl: HTMLElement): void {
    this.renderSectionHeading(containerEl, 'ℹ️ 关于', 'aetherlog-section-about')
    const versionSetting = new Setting(containerEl)
      .setName('版本信息')
      .setDesc(`AetherLog v${this.plugin.manifest.version} MVP`)
    versionSetting.addExtraButton((btn) =>
      btn
        .setIcon('info')
        .setTooltip('查看项目文档')
        .onClick((): void => {
          window.open('https://github.com/FancyLin/AetherLog', '_blank', 'noopener')
        })
    )
    const links = containerEl.createDiv({ cls: 'aetherlog-about-links' })
    const addLink = (label: string, url: string): void => {
      const anchor = links.createEl('a', { text: label, href: url })
      anchor.setAttr('target', '_blank')
      anchor.setAttr('rel', 'noopener')
    }
    addLink('📖 文档', 'https://github.com/FancyLin/AetherLog')
    addLink('🐙 GitHub', 'https://github.com/FancyLin/AetherLog')
    addLink('💡 反馈', 'https://github.com/FancyLin/AetherLog/issues')
    addLink('❤️ 赞助', 'https://github.com/FancyLin/AetherLog')
    containerEl.createDiv({
      cls: 'aetherlog-known-issue',
      text: '⚠️ 由于 Obsidian 插件沙箱限制，200ms 内连续复制可能丢失中间项，对捕获完整性有极高要求的用户请等待 Phase 3 原生 Windows 辅助服务版本。',
    })
  }

  // == M6 分区渲染方法追加区（Edit 追加锚点，勿删）==
}

/** 文件夹选择弹窗（Obsidian 原生 FuzzySuggestModal，用于输出路径「📁 选择文件夹」按钮） */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private readonly onPick: (folderPath: string) => void

  public constructor(app: App, onPick: (folderPath: string) => void) {
    super(app)
    this.onPick = onPick
    this.setPlaceholder('输入文件夹名称筛选...')
  }

  public override getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && file.path !== '/')
  }

  public override getItemText(item: TFolder): string {
    return item.path
  }

  public override onChooseItem(item: TFolder): void {
    this.onPick(item.path)
  }
}
