/**
 * M7 托盘集成（TrayManager implements ITrayManager）
 * 契约对齐 docs/design/v1.0_AetherLog架构设计.md §3.2 / ADR-004：
 * Electron Tray + 失败降级（环境不支持时 init 返回 false，上层照常运行）
 *
 * Electron 获取方式（参考 dragonwocky/obsidian-tray 插件的调用方式，按本项目
 * ITrayManager 接口适配，未整段抄录）：Tray/Menu 属于主进程 GUI 模块，渲染进程
 * 无法经静态 import('electron') 拿到；Electron 14+ 须经 @electron/remote 桥接。
 * 本实现全部在 init() 内运行时 window.require 获取模块——零静态/动态 ESM import，
 * esbuild 对 Electron 完全无感知（比动态 import 更稳，不存在打包 external 问题），
 * 与 A 窗口 app-name-resolver 的 Electron 获取模式保持一致。
 */
import { normalizePath, TFile } from 'obsidian'
import type { ITrayManager, TrayMenuAction } from '../types/tray.types'
import type AetherLogPlugin from '../main'
import { getDayFilePath } from '../utils/date-utils'
import { forceQuitObsidian, registerWindowCloseHandler, showMainWindow } from './window-minimizer'

// ============================================================
// Electron 最小结构类型（仅声明本文件用到的成员，避免 any）
// ============================================================

/** window.require 的最小类型（Obsidian 桌面端渲染进程提供） */
type WindowRequire = (id: string) => unknown

/** Electron NativeImage（不透明句柄：仅在 Tray 与 nativeImage 间传递） */
interface NativeImageLike {
  readonly __nativeImageBrand?: undefined
}

/** Electron Menu 对象（不透明句柄：仅回传给 setContextMenu） */
interface MenuLike {
  readonly __menuBrand?: undefined
}

/** Electron Tray 实例的最小结构 */
interface TrayLike {
  setToolTip(tip: string): void
  setContextMenu(menu: MenuLike): void
  setImage(image: NativeImageLike): void
  destroy(): void
}

/** 菜单项模板（click 回调在主进程触发，经 IPC 回到本注册的闭包） */
interface MenuItemTemplateLike {
  label: string
  click: () => void
}

/** @electron/remote 暴露的主进程模块最小结构 */
interface ElectronRemoteLike {
  Tray: new (image: NativeImageLike) => TrayLike
  Menu: { buildFromTemplate(template: MenuItemTemplateLike[]): MenuLike }
  nativeImage: { createFromDataURL(url: string): NativeImageLike }
}

/** 托盘动作：tray.types.ts 契约动作之外追加 G3「退出」项（契约文件不在本轮白名单，局部扩展） */
type TrayAction = TrayMenuAction | 'quit'

// ============================================================
// 托盘图标（16×16 RGBA PNG，base64 内嵌，对齐 UI 规范 §4.1 资源方案）
// ============================================================

/** 默认图标：蓝色圆底 + 白色 A 字（羽毛图标的 MVP 简化版，不引入 iconfont） */
const TRAY_ICON_DEFAULT_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA40lEQVR42mNQTX7NQAnGJsiimvw6XzX59S7V5NcPoXgXVIyFkAHeUA3/ceCHUDVYDfBG1zB35zcwxmKQN7oBLOg2a6a9/v/p2z8wBrGxuIQF2YB8dFvqFn/+f/b2LzAGsbG4Ih/ZgF3oCi4/+P2/Yt5nMAaxsRiwC9kAFOfH9374/+bj3/8G2W/AGMQGiWHxBnYDtpz88R8dgMTwGQD3gkP5O7AGp4p3cBeA2CAAksPlBXggTt389f+20xi2gcVAcrgCER6NN5/8+Z/Yh+FfsBhIDlc0Yk1IeLA3TZIyVTITyRgAKKYrXSeEPCEAAAAASUVORK5CYII='

/** 未读徽标图标：默认图标 + 右下角红点（带白色描边） */
const TRAY_ICON_BADGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA7klEQVR42mNQTX7NQAnGJsiimvw6XzX59S7V5NcPoXgXVIyFkAHeUA3/ceCHUDVYDfBG1zB35zcwxmKQN7oBLOg2a6a9/v/p2z8wBrGxuIQF2YB8dFvqFn/+f/b2LzAGsbG4Ih/ZgF3oCi4/+P2/Yt5nMAaxsRiwC9kAFOfH9374/+bj3/8G2W/AGMQGiWHxBnYDtpz88R8dIIthMwDuBYfyd2BFThXv4C4AsUHgvYsLGCMZhBmIUzd//b/t9A8U5yJrRsYggBGNN5/8+Z/Y94GgZnQDsCYkUg3AmZSJ8QLezITNABggOtv+xwJA4gDbT1wVuPQOHAAAAABJRU5ErkJggg=='

/** 未读徽标闪烁周期：每 1.5s 在「亮 / 暗」两态间切换一次（对齐任务书 M7.1） */
const BADGE_BLINK_INTERVAL_MS = 1500

/** 未读轮询间隔：A 未暴露 repository 插入事件，按任务书用 200ms 轮询兜底 */
const UNREAD_POLL_INTERVAL_MS = 200

/** 设置面板 tab id（需与 C 窗口 M6 PluginSettingTab 注册 id 一致） */
const SETTINGS_TAB_ID = 'aetherlog'

/**
 * 单次 require 容错（模块缺失时抛异常而非返回 null）
 * @param requireFn 渲染进程 require 函数
 * @param id 模块标识
 * @returns 模块对象或 null
 */
function tryRequire(requireFn: WindowRequire, id: string): unknown {
  try {
    return requireFn(id)
  } catch {
    return null
  }
}

/** 结构化校验：候选对象上 Tray/Menu/nativeImage 三成员齐备才可用 */
function isElectronRemote(value: unknown): value is ElectronRemoteLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<ElectronRemoteLike>
  // @electron/remote 代理对象的 Menu/nativeImage 可能是 class（typeof 为 'function'），
  // 对 remote 代理永远用「方法存在性探测」，不能对模块成员做 'object' 断言（C5 根因）
  return (
    typeof v.Tray === 'function' &&
    typeof v.Menu?.buildFromTemplate === 'function' &&
    typeof v.nativeImage?.createFromDataURL === 'function'
  )
}

/**
 * 运行时获取 Electron remote 模块：@electron/remote 优先（Electron 14+，Obsidian
 桌面端随应用附带），旧版 electron.remote 兜底
 * @returns 可用的 remote 模块；沙箱 / 移动端 / 模块缺失时返回 null（降级）
 */
function getElectronRemote(): ElectronRemoteLike | null {
  try {
    const requireFn = (window as Window & { require?: WindowRequire }).require
    if (typeof requireFn !== 'function') return null
    const remoteModule = tryRequire(requireFn, '@electron/remote')
    if (isElectronRemote(remoteModule)) return remoteModule
    const electronModule = tryRequire(requireFn, 'electron') as { remote?: unknown } | null
    if (isElectronRemote(electronModule?.remote)) return electronModule.remote
    return null
  } catch {
    return null
  }
}

/**
 * 系统托盘管理器（M7）
 *
 * @example
 * const manager = new TrayManager()
 * manager.registerMenuAction('open-quick-note', () => openModal())
 * const ok = await manager.init() // false = 环境降级，上层不报错
 */
export class TrayManager implements ITrayManager {
  private tray: TrayLike | null = null
  private defaultIcon: NativeImageLike | null = null
  private badgeIcon: NativeImageLike | null = null
  private blinkTimer: ReturnType<typeof setInterval> | null = null
  private blinkVisible = false
  /** 菜单动作 → 业务回调（托盘菜单与插件逻辑的桥梁） */
  private readonly handlers = new Map<TrayAction, () => void>()

  /**
   * 初始化托盘与右键菜单；幂等（重复调用直接返回）
   * @returns 是否成功（false = 环境不支持，降级运行，上层不报错）
   */
  public async init(): Promise<boolean> {
    if (this.tray !== null) return true
    const remote = getElectronRemote()
    if (remote === null) {
      console.warn(
        '[AetherLog][TrayManager] 当前环境不支持 Electron Tray，托盘降级运行（命令面板 / 快捷键不受影响）'
      )
      return false
    }
    try {
      this.defaultIcon = remote.nativeImage.createFromDataURL(TRAY_ICON_DEFAULT_URL)
      this.badgeIcon = remote.nativeImage.createFromDataURL(TRAY_ICON_BADGE_URL)
      const tray = new remote.Tray(this.defaultIcon)
      tray.setToolTip('AetherLog · 剪贴板日志')
      tray.setContextMenu(remote.Menu.buildFromTemplate(this.buildMenuTemplate()))
      this.tray = tray
      return true
    } catch (err) {
      console.warn('[AetherLog][TrayManager] 托盘初始化失败（降级运行）:', err)
      this.tray = null
      return false
    }
  }

  /** 资源释放：停闪烁 + 清回调 + 销毁托盘（幂等，多次调用不崩） */
  public destroy(): void {
    this.clearUnreadBadge()
    this.handlers.clear()
    if (this.tray !== null) {
      try {
        this.tray.destroy()
      } catch {
        // 已销毁 / 主进程对象失效：幂等要求下忽略
      }
      this.tray = null
    }
  }

  /** 显示未读徽标：默认图标 ↔ 红点图标每 1.5s 切换一次（等效 CSS opacity 0.3↔1 闪烁） */
  public showUnreadBadge(): void {
    if (this.tray === null || this.blinkTimer !== null) return
    this.blinkVisible = true
    if (this.badgeIcon !== null) this.tray.setImage(this.badgeIcon)
    this.blinkTimer = setInterval(() => {
      this.blinkVisible = !this.blinkVisible
      const icon = this.blinkVisible ? this.badgeIcon : this.defaultIcon
      if (this.tray !== null && icon !== null) this.tray.setImage(icon)
    }, BADGE_BLINK_INTERVAL_MS)
  }

  /** 清除未读徽标：停止闪烁并恢复默认图标 */
  public clearUnreadBadge(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer)
      this.blinkTimer = null
    }
    this.blinkVisible = false
    if (this.tray !== null && this.defaultIcon !== null) {
      try {
        this.tray.setImage(this.defaultIcon)
      } catch {
        // 托盘已销毁：幂等忽略
      }
    }
  }

  /**
   * 注册菜单动作回调（托盘菜单项 → 业务逻辑的桥梁）
   * @param action 菜单动作标识
   * @param handler 回调函数
   */
  public registerMenuAction(action: TrayAction, handler: () => void): void {
    this.handlers.set(action, handler)
  }

  /**
   * 右键菜单模板：4 项，顺序固定（对齐任务书 M7.1 / UI 规范 §4.2 + G3 逃生通道）
   * 1. 📝 打开速记面板  2. 📂 打开今日日志  3. ⚙️ 设置  4. 🚪 退出 AetherLog
   */
  private buildMenuTemplate(): MenuItemTemplateLike[] {
    return [
      { label: '📝 打开速记面板', click: (): void => this.dispatch('open-quick-note') },
      { label: '📂 打开今日日志', click: (): void => this.dispatch('open-today-file') },
      { label: '⚙️ 设置', click: (): void => this.dispatch('open-settings') },
      { label: '🚪 退出 AetherLog', click: (): void => this.dispatch('quit') },
    ]
  }

  /** 分发菜单点击到已注册的业务回调 */
  private dispatch(action: TrayAction): void {
    const handler = this.handlers.get(action)
    if (handler !== undefined) {
      handler()
    } else {
      console.warn(`[AetherLog][TrayManager] 菜单动作 ${action} 未注册处理器`)
    }
  }
}

/**
 * 挂载托盘到插件主入口（M7）
 *
 * 职责（对齐任务书 M7.1）：
 * - settings.trayEnabled = false 时不初始化托盘（仅返回实例供设置页引用）
 * - 注册 4 个菜单动作：速记面板 / 今日日志（打开后清未读）/ 设置面板 / 退出 AetherLog（G3 逃生通道）
 * - 未读徽标：A 窗口未在 CaptureRepository 上暴露 inserted 事件，
 *   以 200ms 轮询当日日文件 mtime 近似「每次成功插入即提醒」（任务书兜底方案）
 * - unload 时经 plugin.register 自动 destroy（幂等）
 *
 * 使用方式：A 窗口在 main.ts onload 中调用 mountTrayManager(this)
 * @param plugin 插件主实例
 * @returns 托盘管理器实例
 */
export function mountTrayManager(plugin: AetherLogPlugin): TrayManager {
  const app = plugin.app
  const settings = plugin.settings
  const manager = new TrayManager()

  /** 当日日文件路径（与 A 窗口 M3 仓储路径规则完全一致） */
  const dayFilePath = (): string => normalizePath(getDayFilePath(settings.clipboardOutputPath))

  /** 当日日文件 mtime（文件不存在时 null） */
  const dayFileMtime = (): number | null => {
    const file = app.vault.getAbstractFileByPath(dayFilePath())
    return file instanceof TFile ? file.stat.mtime : null
  }

  manager.registerMenuAction('open-quick-note', (): void => {
    // G3：窗口可能已最小化到托盘，先恢复主窗口再打开 Modal，否则速记面板不可见
    showMainWindow()
    app.aetherlog?.openQuickNote()
  })

  manager.registerMenuAction('open-today-file', (): void => {
    // G3：窗口可能已最小化到托盘，先恢复主窗口再打开日志
    showMainWindow()
    void app.workspace
      .openLinkText(dayFilePath(), '')
      .then(() => {
        // 用户已查看今日日志：清除未读徽标并把轮询基线重置为当前 mtime
        manager.clearUnreadBadge()
        baseline = dayFileMtime()
      })
      .catch((err: unknown) => {
        console.warn('[AetherLog][TrayManager] 打开今日日志失败:', err)
      })
  })

  manager.registerMenuAction('open-settings', (): void => {
    // G3：窗口可能已最小化到托盘，先恢复主窗口再打开设置
    showMainWindow()
    // app.setting.openTabById 为 Obsidian 未公开 API（官方 d.ts 未声明），
    // 结构化收窄调用；tab id 与 C 窗口 M6 的 PluginSettingTab 保持一致
    // G1 修复：设置 Modal 未挂载时 openTabById 不生效，须先 open() 再切 Tab
    const appWithSetting = app as unknown as {
      setting?: {
        open?: () => void
        openTabById?: (tabId: string) => void
      }
    }
    appWithSetting.setting?.open?.()
    appWithSetting.setting?.openTabById?.(SETTINGS_TAB_ID)
  })

  // G3 逃生通道：最小化到托盘后唯一的真退出入口（forceQuitObsidian 跳过 close 拦截）
  manager.registerMenuAction('quit', (): void => {
    if (window.confirm('确定要退出 AetherLog 吗？\n（Obsidian 将完全关闭）')) {
      forceQuitObsidian()
    }
  })

  // 生命周期：load 时按开关初始化，unload 时 destroy
  if (settings.trayEnabled) {
    void manager.init()
  }
  plugin.register((): void => {
    manager.destroy()
  })

  // 未读徽标兜底轮询：日文件 mtime 增长 = 有新记录写入（剪贴板 / 速记 / 语音）
  let baseline = dayFileMtime()
  const pollTimer = window.setInterval((): void => {
    const mtime = dayFileMtime()
    if (mtime === null) return
    if (baseline !== null && mtime > baseline) manager.showUnreadBadge()
    baseline = mtime
  }, UNREAD_POLL_INTERVAL_MS)
  plugin.register((): void => {
    window.clearInterval(pollTimer)
  })

  // G3：注册窗口关闭拦截（拦截器动态读取 minimizeToTrayOnClose，设置开关切换即时生效）
  const closeHookOk = registerWindowCloseHandler(plugin)
  if (!closeHookOk && settings.minimizeToTrayOnClose) {
    console.warn('[AetherLog][TrayManager] 窗口最小化到托盘功能注册失败（环境不支持）')
  }

  return manager
}
