/**
 * 管理员初始化 / 重置 CLI。
 *
 * 用法（在 Pi 上以服务账号运行）：
 *   sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs
 *   ... --reset-password
 *   ... --reset-totp
 *
 * 秘密只打印到当前 TTY，不写日志、不进仓库。
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import qrcode from 'qrcode-terminal'
import { ensureRuntimeDirs, loadConfig } from '../config.ts'
import { openDatabase } from '../db.ts'
import { audit } from '../auth/audit.ts'
import { hashPassword, validatePassword } from '../auth/password.ts'
import { deleteAllSessions } from '../auth/sessions.ts'
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.ts'
import { countUsers, createUser, findUserByUsername, updatePassword, updateRecoveryCodes, updateTotpSecret } from '../auth/users.ts'
import { generateRecoveryCode, recoveryCodeHash } from '../util/ids.ts'

interface Options {
  username: string | null
  resetPassword: boolean
  resetTotp: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { username: null, resetPassword: false, resetTotp: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--reset-password') options.resetPassword = true
    else if (arg === '--reset-totp') options.resetTotp = true
    else if (arg === '--username') {
      options.username = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function printHelp(): void {
  console.log(`AntifieldCloud provisioning

用法：
  node scripts/provision.mjs [--username <name>]
  node scripts/provision.mjs --reset-password
  node scripts/provision.mjs --reset-totp

说明：
  - 首次运行创建单管理员，设置密码、TOTP 与恢复码。
  - 秘密只打印到当前终端，请立即保存。
  - 需要可读的 /etc/antifieldcloud/env（或通过 ENV_FILE 指定）。`)
}

function printQr(uri: string): void {
  qrcode.generate(uri, { small: true }, (text) => {
    console.log(text)
  })
}

async function readVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

/** TTY 下隐藏输入并显示 *；非 TTY 下退回按行读取（自动化/测试用）。 */
async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    console.warn('（非 TTY 输入，密码将按行读取）')
    return readVisible(prompt)
  }
  return new Promise<string>((resolve, reject) => {
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
    }
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new Error('已取消'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        if (char >= ' ') {
          value += char
          stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

async function askPassword(confirm: boolean): Promise<string> {
  const first = await readHidden('设置密码（至少 12 位）：')
  try {
    validatePassword(first)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '密码不合法', { cause: error })
  }
  if (!confirm) return first
  const second = await readHidden('再次输入密码：')
  if (first !== second) throw new Error('两次输入不一致')
  return first
}

async function setupTotp(username: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const secret = generateTotpSecret()
  const uri = otpauthUri(secret, username)
  console.log('\n请用验证器（Google Authenticator / 1Password 等）扫描二维码：')
  printQr(uri)
  console.log(`\n无法扫码时手动输入：\n  密钥：${secret}\n  URI：${uri}\n`)
  const code = (await readVisible('输入验证器当前 6 位验证码以确认：')).trim()
  if (verifyTotp(secret, code, 0) === null) throw new Error('验证码不正确，未做任何修改')
  const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode())
  return { secret, recoveryCodes }
}

function printRecoveryCodes(codes: string[]): void {
  console.log('\n恢复码（每行仅可使用一次，请离线保存，不要截图发到网上）：')
  for (const code of codes) console.log(`  ${code}`)
  console.log('')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  ensureRuntimeDirs(config)
  const db = openDatabase({ path: `${config.dataDir}/db.sqlite` })

  try {
    if (options.resetPassword) {
      const username = options.username ?? (await readVisible('用户名：')).trim()
      const user = findUserByUsername(db, username)
      if (!user) throw new Error(`用户 ${username} 不存在`)
      const password = await askPassword(true)
      const hashed = await hashPassword(password)
      updatePassword(db, user.id, hashed.hash, hashed.salt)
      deleteAllSessions(db, user.id)
      audit(db, 'cli', 'password_reset', user.username, null, null)
      console.log('密码已重置，所有会话已失效。')
      return
    }

    if (options.resetTotp) {
      const username = options.username ?? (await readVisible('用户名：')).trim()
      const user = findUserByUsername(db, username)
      if (!user) throw new Error(`用户 ${username} 不存在`)
      const { secret, recoveryCodes } = await setupTotp(user.username)
      updateTotpSecret(db, user.id, secret)
      updateRecoveryCodes(db, user.id, recoveryCodes.map((code) => recoveryCodeHash(code)))
      deleteAllSessions(db, user.id)
      audit(db, 'cli', 'totp_reset', user.username, null, null)
      printRecoveryCodes(recoveryCodes)
      console.log('TOTP 已重置，所有会话已失效。')
      return
    }

    if (countUsers(db) > 0) {
      throw new Error('已存在管理员。重置请使用 --reset-password / --reset-totp')
    }
    const username = (options.username ?? (await readVisible(`用户名（默认 ${config.adminUsername}）：`))).trim() || config.adminUsername
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error('用户名不合法')
    const password = await askPassword(true)
    const hashed = await hashPassword(password)
    const { secret, recoveryCodes } = await setupTotp(username)
    createUser(db, {
      username,
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt,
      totpSecret: secret,
      recoveryCodeHashes: recoveryCodes.map((code) => recoveryCodeHash(code)),
    })
    audit(db, 'cli', 'provision', username, null, null)
    printRecoveryCodes(recoveryCodes)
    console.log(`管理员 ${username} 创建完成。现在可以启动 antifieldcloud.service 并登录 https://${new URL(config.appOrigin).host}`)
  } finally {
    db.close()
  }
}

main().catch((error: unknown) => {
  console.error('失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
