/**
 * AetherLog 语音捕获接口与配置定义（Phase 2 占位）
 * 对齐 docs/design/v1.0_AetherLog架构设计.md ADR-003（本地 HTTP 服务 + fetch 请求）
 *
 * MVP 阶段仅定义接口签名，速记面板语音按钮置灰 Coming Soon。
 * Phase 2 提供 CapsWriterAdapter / WebSpeechAdapter 两个实现。
 */
import type { CaptureRecord } from './capture.types'

/** 语音后端错误码（对齐架构文档 6 类错误矩阵） */
export type VoiceErrorCode =
  | 'MIC_NOT_ALLOWED'
  | 'MIC_NOT_FOUND'
  | 'SECURITY_CONTEXT'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_ERROR'
  | 'RECORDING_INTERRUPTED'

/** 语音转写结果 */
export interface VoiceTranscriptResult {
  /** 最终转写文本 */
  text: string
  /** 录音时长（毫秒） */
  durationMs: number
  /** 置信度 0~1，后端给不出就缺省 */
  confidence?: number
  /** 后端名称：'capswriter' | 'webspeech' */
  backendName: string
}

/**
 * 语音捕获策略接口（替换点①：语音后端策略）
 * 事件契约：
 * - 'segment'：一段转写完成（MVP 占位，Promise resolve = 拿到完整 text 的语义由实现保证）
 * - 'error'：录音/转写错误（携带错误码与原始消息）
 */
export interface IVoiceCapture {
  /** 麦克风 + 后端是否可用（初始化时检查，UI 据此灰按钮） */
  isAvailable(): Promise<{ ok: boolean; reason?: VoiceErrorCode }>
  /** 开始录音：Promise resolve = 录音已启动（不是等录完！） */
  startRecording(): Promise<void>
  /** 停止录音并等待转写结果 */
  stopRecording(): Promise<VoiceTranscriptResult>
  /** 取消录音（不触发转写，丢弃数据） */
  cancelRecording(): void
  /** 当前是否正在录音 */
  isRecording(): boolean
  /** 注册转写段落回调 */
  on(event: 'segment', listener: (record: CaptureRecord) => void): void
  /** 注册错误回调 */
  on(event: 'error', listener: (code: VoiceErrorCode, rawMsg: string) => void): void
}

/** 语音捕获配置（Phase 2 使用，MVP 仅占位） */
export interface VoiceCaptureConfig {
  /** CapsWriter 本地 HTTP 服务 Base URL（默认 http://127.0.0.1:19102） */
  baseUrl: string
  /** 识别语言代码，如 'zh-CN' */
  lang: string
}
