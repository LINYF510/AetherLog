import { build, context } from 'esbuild'
import { copyFileSync } from 'node:fs'

const isWatch = process.argv.includes('-w') || process.argv.includes('--watch')

/**
 * AetherLog 构建配置（窗口 A · M1）
 *
 * 关键点：源码使用 ESM（import/export，对齐 AGENTS.md 规范），
 * 但 Obsidian 插件运行时要求 main.js 为 CJS 产物，
 * 因此 format 必须为 'cjs'。
 */
const buildOptions = {
  entryPoints: ['src/main.ts'],
  outfile: './dist/main.js',
  bundle: true,
  minify: false,
  platform: 'node',
  target: 'es2022',
  external: ['obsidian', 'electron'],
  format: 'cjs',
  sourcemap: 'external',
  logLevel: 'info',
}

function copyStyles() {
  copyFileSync('styles.css', 'dist/styles.css')
  console.log('[aetherlog] styles.css 已复制到 dist/styles.css')
}

if (isWatch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  copyStyles()
  console.log('[aetherlog] watch 模式已启动，修改源码后自动重新构建')
} else {
  await build(buildOptions)
  copyStyles()
}
