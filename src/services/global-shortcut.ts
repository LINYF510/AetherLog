/**
 * 全局快捷键服务（S8：任意应用中唤起速记面板）
 *
 * Electron globalShortcut 经 @electron/remote 在渲染进程注册（获取方式与
 * tray-manager 完全一致：运行时 window.require，零静态/动态 ESM import，
 * esbuild 对 Electron 完全无感知，不存在打包 external 问题）。
 *
 * 关键行为说明：
 * 1. 注册成功后，OS 将该组合键直接派发给 AetherLog 进程——即使 Obsidian 正处于
 *    聚焦状态，addCommand 上注册的同款热键也不会重复触发（OS 级拦截，预期行为
 *    而非 bug）；
 * 2. 注册失败（如组合键被其他程序占用）时弹出 Notice 提示更换，此时 addCommand
 *    热键自动成为 Obsidian 聚焦场景的兜底入口；
 * 3. 移动端 / 沙箱等无 Electron 环境时 console.warn 降级，不影响其余功能。
 */
import { Notice } from 'obsidian'
import type AetherLogPlugin from '../main'

// ============================================================
// Electron 最小结构类型（仅声明本文件用到的成员，避免 any）
// ============================================================

/** window.require 的最小类型（Obsidian 桌面端渲染进程提供） */
type WindowRequire = (id: string) => unknown

/** Electron globalShortcut 模块的最小结构 */
interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** 可聚焦窗口的最小结构（BrowserWindow.getAllWindows() 的元素） */
interface FocusableWindowLike {
  show(): void
  focus(): void
}

/** Electron BrowserWindow 类的最小结构（仅用静态 getAllWindows；运行时为构造函数） */
interface BrowserWindowLike {
  getAllWindows(): FocusableWindowLike[]
}

/** @electron/remote 暴露的主进程模块最小结构 */
interface ElectronRemoteLike {
  globalShortcut: GlobalShortcutLike
  BrowserWindow: BrowserWindowLike
}

/** 当前已注册的快捷键（null = 未注册；unmount 后置回 null） */
let registeredShortcut: string | null = null

/** remote 模块引用缓存（mount 成功后缓存；unmount 优先复用，兜底重新 require） */
let cachedRemote: ElectronRemoteLike | null = null

/**
 * 单次 require 容错（模块缺失时抛异常而非返回 null，与 tray-manager 同模式）
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

/**
 * 结构化校验：候选对象上 globalShortcut 两方法与 BrowserWindow.getAllWindows
 * 齐备才可用。BrowserWindow 运行时是构造函数（typeof 'function'），故校验直接
 * 落到其方法上而不对本体做 typeof 断言——避免复现托盘 C5（按 'object' 断言
 * 构造函数导致永久降级）。
 */
function isElectronRemote(value: unknown): value is ElectronRemoteLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<ElectronRemoteLike>
  if (typeof v.globalShortcut !== 'object' || v.globalShortcut === null) return false
  if (typeof v.globalShortcut.register !== 'function') return false
  if (typeof v.globalShortcut.unregister !== 'function') return false
  const browserWindow: { getAllWindows?: unknown } | null | undefined = v.BrowserWindow
  return typeof browserWindow?.getAllWindows === 'function'
}

/**
 * 运行时获取 Electron remote 模块：@electron/remote 优先（Electron 14+，Obsidian
 * 桌面端随应用附带），旧版 electron.remote 兜底
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
 * 注册核心逻辑（mount / reload 复用）
 *
 * 流程：取 remote → 降级校验 → 读 settings.quickNoteShortcut（非空才注册）→
 * 注册成功记录 registeredShortcut；失败弹 Notice 提示更换。
 * @param plugin 插件主实例
 */
function registerShortcut(plugin: AetherLogPlugin): void {
  const remote = getElectronRemote()
  if (remote === null) {
    console.warn('[AetherLog] globalShortcut 不可用，全局快捷键降级（移动端/沙箱属预期）')
    return
  }
  const shortcut = plugin.settings.quickNoteShortcut.trim()
  if (shortcut === '') return

  const ok = remote.globalShortcut.register(shortcut, (): void => {
    // 1) 先聚焦 Obsidian 主窗口（任意应用中触发时把 Obsidian 带回前台，
    //    参考 dragonwocky/obsidian-tray 的做法；空数组时跳过聚焦）
    const windows = remote.BrowserWindow.getAllWindows()
    const mainWindow: FocusableWindowLike | undefined = windows[0]
    if (mainWindow !== undefined) {
      mainWindow.show()
      mainWindow.focus()
    }
    // 2) 再经 app.aetherlog 桥接打开速记面板（与托盘菜单 / addCommand 同一入口）
    const app = plugin.app as { aetherlog?: { openQuickNote?: () => void } }
    app.aetherlog?.openQuickNote?.()
  })
  if (ok === false) {
    new Notice(`[AetherLog] 全局快捷键 ${shortcut} 注册失败（可能被其他程序占用），请在设置中更换`, 8000)
    return
  }
  registeredShortcut = shortcut
  cachedRemote = remote
}

/**
 * 挂载全局快捷键（M4 onload 调用）
 *
 * 注册成功后由 OS 直接派发（聚焦时 addCommand 同款热键不会重复触发）；
 * 环境不支持 / 快捷键为空 / 注册冲突时各自降级，不阻塞 onload。
 * @param plugin 插件主实例
 */
export function mountGlobalShortcut(plugin: AetherLogPlugin): void {
  registerShortcut(plugin)
}

/**
 * 注销全局快捷键（M4 onunload / reload 前置调用）
 *
 * 幂等可重入：未注册时直接返回；remote 不可用时静默返回（环境已变，无从注销）。
 * 仅注销本插件自己 registeredShortcut，严禁 unregisterAll（会波及其他插件/应用
 * 注册的全局快捷键）。unmount 时优先复用模块级缓存的 remote，缓存为空再重新 require。
 */
export function unmountGlobalShortcut(): void {
  if (registeredShortcut === null) return
  const remote = cachedRemote ?? getElectronRemote()
  if (remote === null) return
  try {
    remote.globalShortcut.unregister(registeredShortcut)
  } catch {
    // 快捷键已注销 / 主进程对象失效：幂等要求下忽略
  }
  registeredShortcut = null
  cachedRemote = null
}

/**
 * 重载全局快捷键（C 窗口 M6 设置面板热更新：quickNoteShortcut 变更后经
 * app.aetherlog.reloadGlobalShortcut 桥接调用）
 *
 * 先注销旧快捷键，再按当前 settings 重新注册；快捷键清空 / 环境不支持时
 * 等效于仅注销（自然完成「关闭全局快捷键」语义）。
 * @param plugin 插件主实例
 */
export function reloadGlobalShortcut(plugin: AetherLogPlugin): void {
  unmountGlobalShortcut()
  registerShortcut(plugin)
}
