/**
 * CSRF：双提交 Cookie + 会话内 hash；同时校验 Origin（若存在）。
 *
 * 受信 Origin 只有 app 主机本身（+ loopback 开发例外）；ai 主机不再被信任调用 app API——
 * AI 工作区通过一次性 SSO ticket 获得自己的会话，不借用 app 的 Cookie/CSRF。
 */
import type { FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import type { SessionRow } from '../types.ts'
import { requestMeta } from '../http/request-meta.ts'
import { sha256Hex, safeEqualHex } from '../util/ids.ts'

export function allowedOrigins(config: Config, request: FastifyRequest): string[] {
  const origins = [config.appOrigin]
  const meta = requestMeta(request)
  if (config.allowInsecureLoopback && meta.loopback) {
    origins.push(`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`)
  }
  return origins
}

export function verifyCsrf(request: FastifyRequest, config: Config, session: SessionRow): boolean {
  const header = request.headers['x-csrf-token']
  const token = Array.isArray(header) ? header[0] : header
  if (!token || !safeEqualHex(sha256Hex(token), session.csrf_hash)) return false
  const origin = request.headers.origin
  if (origin && !allowedOrigins(config, request).includes(origin)) return false
  return true
}
