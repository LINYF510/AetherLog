/**
 * AetherLog 构建产物安装脚本（postbuild 钩子）
 * 将 dist/main.js、dist/styles.css、manifest.json 复制到测试 Vault 的插件目录：
 * D:\学习笔记\Obsidian\FancyLin-Notes-Work\.obsidian\plugins\aetherlog\
 *
 * 用法：npm run build（npm 会自动执行 postbuild）或手动 npm run postbuild
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 目标 Vault 的插件目录 */
const VAULT_PLUGIN_DIR = 'D:/学习笔记/Obsidian/FancyLin-Notes-Work/.obsidian/plugins/aetherlog'

/** 待复制的构建三件套：[源路径, 目标文件名] */
const FILES = [
  ['dist/main.js', 'main.js'],
  ['dist/styles.css', 'styles.css'],
  ['manifest.json', 'manifest.json'],
]

// 目标 Vault 不存在时跳过（CI 环境 / 其他机器），不报错
const vaultBase = VAULT_PLUGIN_DIR.split('/.obsidian/')[0]
if (!existsSync(vaultBase)) {
  console.log(`[aetherlog] 跳过安装：目标 Vault 不存在 (${vaultBase})，CI 环境无需复制`)
  process.exit(0)
}

mkdirSync(VAULT_PLUGIN_DIR, { recursive: true })

for (const [source, destination] of FILES) {
  if (!existsSync(source)) {
    console.error(`[aetherlog] 缺少构建产物: ${source}，请先执行 npm run build`)
    process.exit(1)
  }
  const target = join(VAULT_PLUGIN_DIR, destination)
  copyFileSync(source, target)
  const sizeKb = (statSync(source).size / 1024).toFixed(1)
  console.log(`[aetherlog] 已复制 ${source} (${sizeKb}KB) → ${target}`)
}

console.log('[aetherlog] 安装完成：请在 Obsidian 中「禁用再启用」AetherLog 插件以加载最新构建')
