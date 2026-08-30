/**
 * AetherLog 插件主入口（M4 生命周期编排）
 *
 * 核心链路：ClipboardListener（capture 事件）→ CaptureRepository（日文件写入）
 * 附加：状态条 AL:Idle/Working、打开速记命令 + Ribbon、app.aetherlog 桥接桩（B 窗口 M5 解耦用）
 */
import { Notice, Plugin } from 'obsidian'
import { DEFAULT_SETTINGS, MIGRATIONS } from './types/settings.types'
import type { AetherLogSettings } from './types/settings.types'
import type { CaptureRecord } from './types/capture.types'
import type { InsertResult } from './types/repository.types'
import type { ClipboardListenerConfig } from './types/clipboard.types'
import { CaptureRepository } from './services/capture-repository'
import { ClipboardListener } from './services/clipboard-listener'
import { migrateSettings } from './utils/settings-migrator'
import { mountQuickNoteModal } from './ui/quick-note-modal'
import { mountTrayManager } from './services/tray-manager'
import { unregisterWindowCloseHandler } from './services/window-minimizer'
import { mountGlobalShortcut, unmountGlobalShortcut, reloadGlobalShortcut } from './services/global-shortcut'

import AetherLogSettingsTab from './settings'

export default class AetherLogPlugin extends Plugin {
  /** 插件设置（B/C 窗口可读取；基类声明为 unknown，此处 declare 收窄为具体类型，不产生运行时字段） */
  public declare settings: AetherLogSettings
  private repository!: CaptureRepository
  private clipboard!: ClipboardListener
  private statusBarItem: HTMLElement | null = null
  private statusFlashTimer: ReturnType<typeof setTimeout> | null = null

  public override async onload(): Promise<void> {
    // a) 设置加载：深合并补默认值 + 版本迁移框架
    await this.loadSettings()

    // b) 存储仓储
    this.repository = new CaptureRepository(this.app.vault, this.settings)

    // c) 剪贴板监听
    this.clipboard = new ClipboardListener(this.app, this.buildClipboardConfig())

    // d) 主链路闭环：剪贴板捕获 → 仓储写入 → 状态条闪 Working
    this.clipboard.on('capture', async (record: CaptureRecord): Promise<void> => {
      try {
        await this.repository.insertCaptureRecord(record)
        this.flashStatusBarWorking()
      } catch (err) {
        new Notice(`[AetherLog] 捕获记录写入失败: ${err instanceof Error ? err.message : String(err)}`, 10000)
      }
    })

    // e) 剪贴板错误通知（错误矩阵 C01：连续失败 10 次自动停止时触发）
    this.clipboard.on('error', (error: Error): void => {
      new Notice(`[AetherLog] 剪贴板错误: ${error.message}`, 10000)
    })

    // f) 状态条：初始 AL:Idle，捕获时闪 AL:Working 3 秒后回落
    this.statusBarItem = this.addStatusBarItem()
    this.statusBarItem.setText('AL:Idle')

    // 启动监听（S18 + S1 双开关）
    if (this.settings.autoStartCaptureOnLoad && this.settings.clipboardEnabled) {
      await this.clipboard.start()
    }

    // g) 快捷键命令：打开速记面板（真正的 Modal 由 B 窗口 M5 通过 app.aetherlog 桥接挂载）
    this.addCommand({
      id: 'open-quick-note',
      name: '打开速记面板',
      hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'q' }],
      callback: (): void => {
        this.app.aetherlog?.openQuickNote()
      },
    })

    // 桥接桩：UI 层（B 窗口速记面板）与业务层解耦的关键挂载点
    // reloadGlobalShortcut 供 C 窗口（M6）设置面板热更新全局快捷键；先落局部
    // 变量再挂载，规避对象字面量 excess property 检查（AetherLogGlobal 接口
    // 暂未收录该可选方法，settings.ts 侧经结构收窄消费）
    const bridge = {
      insertQuickNote: async (record: CaptureRecord): Promise<InsertResult> =>
        this.repository.insertCaptureRecord(record),
      openQuickNote: (): void => {
        // B 窗口（M5）实现 QuickNoteModal 后会覆盖此桩函数
        new Notice('AetherLog: 速记面板模块加载中...', 1500)
      },
      reloadGlobalShortcut: (): void => reloadGlobalShortcut(this),
    }
    this.app.aetherlog = bridge

    // 挂 B 窗口（M5）速记面板：覆盖 app.aetherlog.openQuickNote 桩函数 → 真实 QuickNoteModal.open()
    mountQuickNoteModal(this)

    // 挂全局快捷键（S8）：任意应用中唤起速记面板（Electron globalShortcut；
    // 注册成功后 OS 级拦截，聚焦时 addCommand 同款热键不会重复触发；非桌面端自动降级）
    mountGlobalShortcut(this)

    // 挂 B 窗口（M7）托盘集成：仅当设置开启时生效（init 内部自判 Electron 环境，不支持自动降级为 false）
    if (this.settings.trayEnabled) mountTrayManager(this)

    // h) Ribbon 图标（MVP 用内置 pencil，Phase 2 换 SVG 羽毛图标）
    this.addRibbonIcon('pencil', 'AetherLog 速记', (): void => {
      this.app.aetherlog?.openQuickNote()
    })

    // 挂 C 窗口（M6）设置面板：Tab id='aetherlog'（B 窗口托盘菜单第 3 项通过此 id 打开）
    this.addSettingTab(new AetherLogSettingsTab(this.app, this))

    console.log('[AetherLog] onload 完成：核心链路 + 速记面板 + 托盘 + 设置面板 全部加载')
  }

  public override async onunload(): Promise<void> {
    // a) 停止剪贴板监听（内部清理 interval、workspace EventRef、window focus 监听并移除全部事件回调）
    await this.clipboard.stop()

    // a1) 注销窗口关闭拦截（G3 最小化到托盘；removeListener 精确移除，幂等）
    unregisterWindowCloseHandler()

    // a2) 注销全局快捷键（幂等可重入；仅注销本插件注册的组合键，不影响其他插件）
    unmountGlobalShortcut()

    // b) 设置持久化（有改动则写盘）
    await this.saveSettings()

    // c) 状态条闪烁定时器清理 + 状态条移除
    //    说明：addCommand / addRibbonIcon / addStatusBarItem 注册的资源由 Obsidian
    //    在插件卸载时自动释放；状态条元素额外手动 remove 一次作双保险（幂等操作）
    if (this.statusFlashTimer !== null) {
      clearTimeout(this.statusFlashTimer)
      this.statusFlashTimer = null
    }
    this.statusBarItem?.remove()
    this.statusBarItem = null

    // d) 移除全局桥接挂载点
    delete this.app.aetherlog

    console.log('[AetherLog] onunload 完成，资源已释放')
  }

  /**
   * 加载设置：loadData() 原始数据 → 深合并 DEFAULT_SETTINGS → 版本迁移
   */
  private async loadSettings(): Promise<void> {
    const raw = await this.loadData()
    this.settings = migrateSettings(raw, DEFAULT_SETTINGS, MIGRATIONS)
  }

  /**
   * 保存设置到 data.json
   */
  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /**
   * 由 AetherLogSettings 构造剪贴板监听配置
   * 黑名单取关键字黑名单（Phase 2 功能，MVP 默认空数组不影响行为）
   */
  private buildClipboardConfig(): ClipboardListenerConfig {
    return {
      pollIntervalMs: this.settings.clipboardPollingIntervalMs,
      focusSupplementary: true,
      focusWindowMs: 300,
      blacklistPatterns: this.settings.keywordBlacklist,
      contentHashCacheTtlSec: 1800,
    }
  }

  /**
   * 状态条闪烁：显示 AL:Working，3 秒后回落 AL:Idle（重复捕获时重置计时）
   */
  private flashStatusBarWorking(): void {
    if (this.statusBarItem === null) return
    this.statusBarItem.setText('AL:Working')
    if (this.statusFlashTimer !== null) {
      clearTimeout(this.statusFlashTimer)
    }
    this.statusFlashTimer = setTimeout(() => {
      this.statusBarItem?.setText('AL:Idle')
      this.statusFlashTimer = null
    }, 3000)
  }
}
