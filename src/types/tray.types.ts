/**
 * AetherLog 系统托盘接口与配置定义
 * 对齐 docs/design/v1.0_AetherLog架构设计.md ADR-004（Electron Tray + 失败降级）
 * 实现由 B 窗口（M7 托盘系统）完成，本文件仅提供契约。
 */

/** 托盘菜单动作标识 */
export type TrayMenuAction = 'toggle-capture' | 'open-quick-note' | 'open-today-file' | 'open-settings'

/**
 * 托盘管理策略接口（可选模块，环境不支持时用 Noop 实现降级，保证上层不崩）
 */
export interface ITrayManager {
  /** 初始化托盘与全局快捷键；返回是否成功（false = 降级运行，上层不报错） */
  init(): Promise<boolean>
  /** 资源释放：unregisterAll + tray.destroy（必须幂等，多次调用不崩） */
  destroy(): void
  /** 显示未读徽标（捕获到新记录时通知托盘闪烁提醒） */
  showUnreadBadge(): void
  /** 清除未读徽标 */
  clearUnreadBadge(): void
  /**
   * 注册菜单动作回调（托盘菜单项 → 业务逻辑的桥梁）
   * @param action 菜单动作标识
   * @param handler 回调函数
   */
  registerMenuAction(action: TrayMenuAction, handler: () => void): void
}

/** 托盘配置 */
export interface TrayConfig {
  /** 是否随插件启动自动初始化托盘 */
  autoStartTray: boolean
  /** 是否启用未读徽标闪烁提醒 */
  enableTooltipBlink: boolean
}
