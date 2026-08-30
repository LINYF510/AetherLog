/**
 * 来源应用名解析器（尽力而为策略，对齐需求文档问题 8 决策）
 *
 * 解析链：
 * 1.【异步 · 主力】Windows 下经 PowerShell 查询剪贴板所有者进程
 *   （Win32 GetClipboardOwner → GetWindowThreadProcessId → Get-Process）：
 *   所有者是最后一次写入剪贴板的窗口，与当前焦点无关，可可靠识别外部来源应用；
 *   纯 PowerShell 子进程方案，无 native addon 依赖（满足打包约束）
 * 2. @electron/remote BrowserWindow.getFocusedWindow().getTitle()（Obsidian 自身窗口聚焦时）
 * 3. document.hasFocus() 时取当前文档标题（即 Obsidian 自身）
 * 4. 均失败 → 返回 'Unknown'
 *
 * 约束：绝不引入 native addon 或 windows-foreground-love 之类原生模块（避免打包灾难）。
 * 限制：PowerShell 查询需启动子进程（约 0.3~1s，异步执行不阻塞 UI），仅在捕获到
 * 新内容时调用一次；非 Windows 环境自动跳过，走 2/3/4 降级链。
 * 返回值为来源进程名（如 chrome / WeChat / Obsidian），不做友好名映射（保持零依赖）。
 */

/** @electron/remote 的 BrowserWindow 静态成员最小结构 */
interface RemoteBrowserWindowLike {
  getFocusedWindow?: () => { getTitle?: () => string } | null
}

/** @electron/remote 模块最小结构（仅声明本文件用到的成员，避免 any） */
interface ElectronRemoteLike {
  BrowserWindow?: RemoteBrowserWindowLike
}

/** Node child_process 最小结构（仅异步 exec 查询剪贴板所有者进程用） */
interface ChildProcessLike {
  exec(
    command: string,
    options: { timeout: number },
    callback: (error: Error | null, stdout: string) => void
  ): unknown
}

/** window.require 的最小类型 */
type WindowRequire = (id: string) => unknown

/**
 * 剪贴板所有者进程查询脚本（PowerShell 5+ 经 Add-Type 编译 P/Invoke 声明；
 * 脚本为纯 ASCII，保证 UTF-16LE 手工编码简单可靠）
 */
const CLIPBOARD_OWNER_PS_SCRIPT =
  'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\' -Name ClipOwner -Namespace AetherLog; ' +
  '$h = [AetherLog.ClipOwner]::GetClipboardOwner(); ' +
  'if ($h -ne [IntPtr]::Zero) { ' +
  '$p = [UInt32]0; ' +
  '[void][AetherLog.ClipOwner]::GetWindowThreadProcessId($h, [ref]$p); ' +
  'if ($p -ne 0) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName } ' +
  '}'

/** PowerShell 查询超时（毫秒）：超时即放弃并走降级链，避免悬挂捕获流程 */
const PS_QUERY_TIMEOUT_MS = 3000

/**
 * 安全获取 @electron/remote 模块（与 tray-manager / window-minimizer 同款模式）
 * @returns remote 模块对象或 null（沙箱 / 移动端 / 模块缺失时）
 */
function getElectronRemote(): ElectronRemoteLike | null {
  try {
    const requireFn = (window as Window & { require?: WindowRequire }).require
    if (typeof requireFn !== 'function') return null
    let candidate: unknown = null
    try {
      // Electron 14+：remote 独立为 @electron/remote（Obsidian 桌面端随应用附带）
      candidate = requireFn('@electron/remote')
    } catch {
      try {
        candidate = (requireFn('electron') as { remote?: unknown }).remote ?? null
      } catch {
        candidate = null
      }
    }
    if (typeof candidate === 'object' && candidate !== null) {
      return candidate as ElectronRemoteLike
    }
    return null
  } catch {
    return null
  }
}

/**
 * 当前是否为 Windows 平台（PowerShell 方案仅 Windows 可用）
 */
function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
}

/**
 * 将 PowerShell 脚本编码为 -EncodedCommand 所需的 Base64（UTF-16LE）
 * 脚本为纯 ASCII，可按 UTF-16LE 逐字符低位 / 高位展开后 btoa，
 * 规避 -Command 的引号嵌套转义问题
 * @param script PowerShell 脚本文本
 * @returns Base64 编码结果；btoa 不可用时返回 null
 */
function encodePowerShellCommand(script: string): string | null {
  try {
    let utf16le = ''
    for (let i = 0; i < script.length; i++) {
      const code = script.charCodeAt(i)
      utf16le += String.fromCharCode(code & 0xff, (code >> 8) & 0xff)
    }
    return btoa(utf16le)
  } catch {
    return null
  }
}

/**
 * 查询剪贴板所有者进程名（Windows 主力方案）
 * @returns 进程名（如 chrome / WeChat / Obsidian）；环境不支持 / 查询失败 / 超时时 null
 */
function queryClipboardOwnerProcess(): Promise<string | null> {
  return new Promise<string | null>((resolve: (value: string | null) => void): void => {
    if (!isWindowsPlatform()) {
      resolve(null)
      return
    }
    try {
      const requireFn = (window as Window & { require?: WindowRequire }).require
      if (typeof requireFn !== 'function') {
        resolve(null)
        return
      }
      const childProcess = requireFn('child_process') as ChildProcessLike | null
      if (
        typeof childProcess !== 'object' ||
        childProcess === null ||
        typeof childProcess.exec !== 'function'
      ) {
        resolve(null)
        return
      }
      const encoded = encodePowerShellCommand(CLIPBOARD_OWNER_PS_SCRIPT)
      if (encoded === null) {
        resolve(null)
        return
      }
      childProcess.exec(
        `powershell -NoProfile -EncodedCommand ${encoded}`,
        { timeout: PS_QUERY_TIMEOUT_MS },
        (error: Error | null, stdout: string): void => {
          if (error !== null) {
            resolve(null)
            return
          }
          const name = stdout.trim()
          resolve(name.length > 0 ? name : null)
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 解析当前剪贴板内容的来源应用名（异步 · 主力入口）
 * 剪贴板捕获场景应使用本函数：外部应用复制时 Obsidian 不聚焦，
 * 只有剪贴板所有者查询能给出真实来源
 * @returns 应用名（拿不到可靠值时为 'Unknown'）
 */
export async function resolveAppNameAsync(): Promise<string> {
  const ownerProcess = await queryClipboardOwnerProcess()
  if (ownerProcess !== null) return ownerProcess
  return resolveAppName()
}

/**
 * 解析当前来源应用名（同步 · 降级链）
 * 速记面板等 Obsidian 自身聚焦的场景可直接使用；剪贴板捕获请用 resolveAppNameAsync
 * @returns 应用名（拿不到可靠值时为 'Unknown'）
 */
export function resolveAppName(): string {
  const remote = getElectronRemote()
  if (remote !== null) {
    try {
      const focusedWindow = remote.BrowserWindow?.getFocusedWindow?.() ?? null
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
