/**
 * 窗口最小化到托盘服务（G3 · 三次修复版）
 *
 * 实现对齐社区已验证方案（Synaphi/background-tray，Obsidian 1.12 / Electron 39
 * 实测可用，2026-06 仍在维护）的双层拦截结构：
 * - 主拦截：window beforeunload（渲染进程本地同步事件，preventDefault +
 *   returnValue=false 可靠取消窗口关闭），开关开启即无条件拦截
 * - 兜底：remote BrowserWindow.on('close')（Electron 39 上 @electron/remote
 *   转发事件的 preventDefault 实测被忽略，仅对旧版 Electron 生效，注册无害）
 * - 退出：置 forceQuitRequested 标志让 beforeunload 放行，再 app.quit() 走
 *   Obsidian 正常保存退出流程
 *
 * v1 / v2 失败根因复盘：
 * - v1：仅用 remote close 拦截——转发事件上的 preventDefault 不回传主进程，
 *   close 照常完成 → 点关闭直接全退
 * - v2：beforeunload 拦截被 closeIntent 预检门控，而该标志依赖 remote close
 *   事件转发——此消息在 beforeunload 分发之后才到达（Electron 39 上甚至可能
 *   根本不转发）→ 标志为 false → 拦截被跳过 → 照常全退（托盘残留的短暂
 *   延时即 Obsidian 保存退出耗时）
 *
 * 已知权衡：beforeunload 无法区分「窗口关闭」与「页面 reload」——Obsidian 的
 * vault 切换 / 强制重载走主进程窗口重建路径，不受本拦截影响（对齐 background-tray
 * 的取舍）；若极端场景下 reload 被误拦，关闭本插件设置开关即可即时恢复。
 *
 * 高风险说明：拦截窗口关闭可能导致用户无法退出 Obsidian，因此：
 * - 默认关闭（settings.minimizeToTrayOnClose = false），用户主动开启
 * - 拦截器动态读取设置开关：关闭开关后无需重启即恢复默认关窗行为
 * - 托盘菜单保留「退出 AetherLog」项作为逃生通道（forceQuitObsidian）
 *
 * Electron 获取方式与 tray-manager 一致：运行时 window.require，零静态 import，
 * esbuild 对 Electron / Node 模块完全无感知。
 */
import { Notice } from 'obsidian'

/** window.require 的最小类型（Obsidian 桌面端渲染进程提供） */
type WindowRequire = (id: string) => unknown

/** Electron BrowserWindow 最小结构（仅声明本文件用到的成员，避免 any） */
interface BrowserWindowLike {
  on(event: 'close', handler: (event: { preventDefault: () => void }) => void): void
  removeListener(event: 'close', handler: (event: { preventDefault: () => void }) => void): void
  hide(): void
  show(): void
}

/** Electron app 最小结构 */
interface AppLike {
  quit(): void
  getPath(name: 'exe'): string
}

/** @electron/remote 暴露的主进程模块最小结构 */
interface ElectronRemoteLike {
  app: AppLike
  getCurrentWindow(): BrowserWindowLike
}

/** Node fs 最小结构（仅开机自启删除快捷方式用） */
interface FsLike {
  existsSync(path: string): boolean
  unlinkSync(path: string): void
}

/** Node path 最小结构 */
interface PathLike {
  join(...paths: string[]): string
}

/** Node child_process 最小结构 */
interface ChildProcessLike {
  execSync(command: string, options?: { encoding?: string }): string
}

/** 插件实例最小结构（仅读取设置开关；settings.ts 的 AetherLogPluginLike 结构兼容） */
interface PluginSettingsLike {
  settings: { minimizeToTrayOnClose: boolean }
}

/** Windows shell:Startup 下本插件快捷方式文件名 */
const AUTOSTART_SHORTCUT_NAME = 'AetherLog.lnk'

/** @electron/remote 模块级缓存（含「已探测」标记，失败也记忆，避免每次重复 try/catch） */
let remote: ElectronRemoteLike | null = null
let remoteResolved = false
/** 已注册的 beforeunload 主拦截（用于 onunload 精确移除） */
let registeredBeforeUnload: ((evt: BeforeUnloadEvent) => void) | null = null
/** 已注册的 remote close 兜底（用于 onunload 精确移除） */
let registeredCloseFallback: ((event: { preventDefault: () => void }) => void) | null = null
let registeredCloseWindow: BrowserWindowLike | null = null
/** 用户主动退出标记：置 true 后 beforeunload 放行，app.quit() 正常退出 */
let forceQuitRequested = false
/** 拦截器持有的设置引用（onunload 时置空） */
let settingsRef: PluginSettingsLike | null = null

/** 结构化校验：app.quit 与 getCurrentWindow 齐备才可用 */
function isElectronRemote(value: unknown): value is ElectronRemoteLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<ElectronRemoteLike>
  return typeof v.app?.quit === 'function' && typeof v.getCurrentWindow === 'function'
}

/**
 * 运行时获取 @electron/remote（与 tray-manager 同款模式）
 * @returns 可用的 remote 模块；沙箱 / 移动端 / 模块缺失时返回 null
 */
function getRemote(): ElectronRemoteLike | null {
  if (remoteResolved) return remote
  remoteResolved = true
  try {
    const requireFn = (window as Window & { require?: WindowRequire }).require
    if (typeof requireFn !== 'function') return null
    let candidate: unknown = null
    try {
      candidate = requireFn('@electron/remote')
    } catch {
      // 旧版 Electron 兜底：electron.remote
      try {
        candidate = (requireFn('electron') as { remote?: unknown }).remote ?? null
      } catch {
        candidate = null
      }
    }
    remote = isElectronRemote(candidate) ? candidate : null
    return remote
  } catch {
    return null
  }
}

/**
 * 注册窗口关闭拦截（最小化到托盘）
 *
 * 双层结构（对齐 background-tray 实测方案）：
 * 1. beforeunload 主拦截——开关开启即无条件拦截（不依赖任何异步 IPC 标志）
 * 2. remote close 兜底——仅旧版 Electron 生效，注册无害
 * 拦截器动态读取 plugin.settings.minimizeToTrayOnClose，
 * 用户在设置页关闭开关后无需重启即恢复默认关窗行为。
 * @param plugin 插件实例（读取当前设置开关）
 * @returns 是否已处于注册状态（含重复调用的幂等情形）
 */
export function registerWindowCloseHandler(plugin: PluginSettingsLike): boolean {
  if (registeredBeforeUnload !== null) return true
  const r = getRemote()
  if (r === null) return false

  try {
    const win = r.getCurrentWindow()
    settingsRef = plugin

    /** 是否应拦截当前关闭（动态读取设置 + 退出放行） */
    const shouldIntercept = (): boolean =>
      settingsRef !== null && settingsRef.settings.minimizeToTrayOnClose && !forceQuitRequested

    // 兜底层：旧版 Electron 上 remote 转发的 close 事件 preventDefault 有效；
    // Electron 39 上被忽略（实测），此时由 beforeunload 主拦截兜底
    const closeFallback = (event: { preventDefault: () => void }): void => {
      if (!shouldIntercept()) return
      event.preventDefault()
      try {
        win.hide()
      } catch {
        // 窗口已销毁：幂等要求下忽略
      }
    }
    win.on('close', closeFallback)
    registeredCloseWindow = win
    registeredCloseFallback = closeFallback

    // 主拦截层：渲染进程本地同步事件，preventDefault + returnValue=false 取消关闭。
    // 注意：hide() 同步调用（对齐 background-tray 实测方案，无 IPC 死锁问题）
    const onBeforeUnload = (evt: BeforeUnloadEvent): void => {
      if (!shouldIntercept()) return
      evt.preventDefault()
      evt.returnValue = false
      try {
        win.hide()
        console.log('[AetherLog][WindowMinimizer] 已最小化到托盘（右键托盘图标可恢复或退出）')
      } catch {
        // 窗口已销毁：幂等要求下忽略
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    registeredBeforeUnload = onBeforeUnload
    return true
  } catch (err) {
    console.warn('[AetherLog][WindowMinimizer] 注册窗口关闭拦截失败:', err)
    return false
  }
}

/**
 * 注销窗口关闭拦截（插件 onunload 时调用，幂等）
 * beforeunload 监听与 remote close 兜底一一对应移除，防止插件卸载后仍拦截关窗
 */
export function unregisterWindowCloseHandler(): void {
  if (registeredBeforeUnload !== null) {
    window.removeEventListener('beforeunload', registeredBeforeUnload)
  }
  if (registeredCloseWindow !== null && registeredCloseFallback !== null) {
    try {
      registeredCloseWindow.removeListener('close', registeredCloseFallback)
    } catch {
      // 窗口已销毁：幂等要求下忽略
    }
  }
  registeredBeforeUnload = null
  registeredCloseFallback = null
  registeredCloseWindow = null
  settingsRef = null
}

/**
 * 恢复主窗口（窗口最小化到托盘后，托盘菜单各动作须先调用，否则界面不可见）
 * 窗口未隐藏时调用无副作用（仅可能置前获得焦点，与托盘点击意图一致）
 */
export function showMainWindow(): void {
  const r = getRemote()
  if (r === null) return
  try {
    r.getCurrentWindow().show()
  } catch {
    // 窗口已销毁 / 环境异常：幂等忽略
  }
}

/**
 * 强制退出 Obsidian（托盘菜单「退出 AetherLog」项调用）
 * 先置退出标记让 beforeunload 放行，再调用主进程 app.quit()，
 * 走 Obsidian 正常保存退出流程
 */
export function forceQuitObsidian(): void {
  forceQuitRequested = true
  const r = getRemote()
  if (r === null) {
    new Notice('[AetherLog] 无法退出：当前环境不支持 Electron', 5000)
    return
  }
  r.app.quit()
}

/**
 * 开机自启快捷方式管理（Windows shell:Startup）
 * @param enable true = 创建指向 Obsidian 主程序的快捷方式，false = 删除
 * @returns 是否成功（环境不支持 / 权限不足时 false，由调用方提示用户）
 */
export async function setAutoStartOnBoot(enable: boolean): Promise<boolean> {
  const r = getRemote()
  if (r === null) return false
  try {
    const requireFn = (window as Window & { require?: WindowRequire }).require
    if (typeof requireFn !== 'function') return false
    const fs = requireFn('fs') as FsLike
    const path = requireFn('path') as PathLike
    const childProcess = requireFn('child_process') as ChildProcessLike
    if (
      typeof fs?.existsSync !== 'function' ||
      typeof path?.join !== 'function' ||
      typeof childProcess?.execSync !== 'function'
    ) {
      return false
    }
    // shell:Startup 绝对路径（echo 展开环境变量，trim 去掉尾部换行）
    const startupPath = childProcess
      .execSync('echo %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', {
        encoding: 'utf8',
      })
      .trim()
    const shortcutPath = path.join(startupPath, AUTOSTART_SHORTCUT_NAME)

    if (enable) {
      const obsidianExe = r.app.getPath('exe')
      // PowerShell 内部统一用单引号包裹路径，避免与外层 cmd 双引号嵌套冲突
      const psCommand =
        '$WshShell = New-Object -ComObject WScript.Shell; ' +
        `$Shortcut = $WshShell.CreateShortcut('${shortcutPath}'); ` +
        `$Shortcut.TargetPath = '${obsidianExe}'; $Shortcut.Save()`
      childProcess.execSync(`powershell -NoProfile -Command "${psCommand}"`, { encoding: 'utf8' })
      return true
    }
    if (fs.existsSync(shortcutPath)) {
      fs.unlinkSync(shortcutPath)
    }
    return true
  } catch (err) {
    console.warn('[AetherLog][WindowMinimizer] 开机自启设置失败:', err)
    return false
  }
}
