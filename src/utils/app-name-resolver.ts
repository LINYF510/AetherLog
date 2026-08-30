/**
 * 来源应用名解析器（尽力而为策略，对齐需求文档问题 8 决策）
 *
 * 解析链：
 * 1. Electron remote BrowserWindow.getFocusedWindow().getTitle()（桌面端可用时）
 * 2. document.hasFocus() 时取当前文档标题（即 Obsidian 自身）
 * 3. 均失败 → 返回 'Unknown'
 *
 * 约束：绝不引入 native addon 或 windows-foreground-love 之类原生模块（避免打包灾难）。
 * 注意：用户在其他应用中复制时，Obsidian 窗口未聚焦，第 1 步拿不到聚焦窗口，
 * 此时正确返回 'Unknown'——真实来源识别升级留给 Phase 2 P2-8（Windows API 方案）。
 */

/** Electron 模块的最小结构类型（仅声明本文件用到的只读成员，避免 any） */
interface ElectronLike {
  remote?: {
    BrowserWindow?: {
      getFocusedWindow?: () => { getTitle?: () => string } | null
    }
  }
}

/** window.require 的最小类型 */
type WindowRequire = (id: string) => unknown

/**
 * 安全获取 Electron 模块（沙箱/移动端不支持时返回 null）
 * @returns Electron 模块对象或 null
 */
function getElectron(): ElectronLike | null {
  try {
    const requireFn = (window as Window & { require?: WindowRequire }).require
    if (typeof requireFn !== 'function') return null
    const electron = requireFn('electron')
    if (typeof electron === 'object' && electron !== null) return electron as ElectronLike
    return null
  } catch {
    return null
  }
}

/**
 * 解析当前剪贴板内容的来源应用名（尽力而为）
 * @returns 应用名（拿不到可靠值时为 'Unknown'）
 */
export function resolveAppName(): string {
  const electron = getElectron()
  if (electron) {
    try {
      const focusedWindow = electron.remote?.BrowserWindow?.getFocusedWindow?.() ?? null
      const title = focusedWindow?.getTitle?.() ?? null
      if (title !== null && title.length > 0) return title
    } catch {
      // remote API 不可用，走降级链
    }
  }
  if (typeof document !== 'undefined' && document.hasFocus()) {
    return document.title.length > 0 ? document.title : 'Obsidian'
  }
  return 'Unknown'
}
