/** Fastify/pino 日志配置：对 Cookie、Authorization、密码、TOTP 做脱敏。 */
import type { FastifyServerOptions } from 'fastify'
import type { Config } from './config.ts'

export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.code',
        'req.body.recoveryCode',
        '*.password',
        '*.totpSecret',
      ],
      censor: '[REDACTED]',
    },
  }
}
