import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { loadConfig, pruneArchives, runBackup, sha256File } from '../backup-world.mjs'

/**
 * backup-world.mjs 测试：进程内假 RCON 服务器（127.0.0.1 随机端口）+ 临时世界目录，
 * 不连接真实 Minecraft、不写生产路径。覆盖：
 * - save-off → save-all flush → tar → save-on 的顺序与 finally 保证；
 * - 归档/SHA 旁文件/状态 JSON/保留策略；
 * - tar 退出码 1 容忍 + gzip 完整性校验（OP-02）；
 * - tar 失败、save-all flush 失败、RCON 认证失败时的 save-on 与 ASCII 错误码。
 */

/** 假 RCON 服务器：按命令返回可控响应，并记录收到的命令顺序。 */
function startFakeRcon({ password = 'test-rcon-password', failFlush = false } = {}) {
  const commands = []
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0)
        if (buffer.length < 4 + size) return
        const packet = buffer.subarray(4, 4 + size)
        buffer = buffer.subarray(4 + size)
        const id = packet.readInt32LE(0)
        const type = packet.readInt32LE(4)
        const body = packet.subarray(8, packet.length - 2).toString('utf8')
        if (type === 3) {
          const ok = body === password
          socket.write(encodePacket(ok ? id : -1, 2, ok ? '' : 'auth failed'))
          continue
        }
        if (type === 2) {
          commands.push(body)
          let response = ''
          if (body === 'save-off') response = 'Saving is disabled'
          else if (body === 'save-all flush') response = failFlush ? 'Unknown command' : '§aSaved the game'
          else if (body === 'save-on') response = 'Saving is enabled'
          socket.write(encodePacket(id, 0, response))
        }
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: address.port,
        commands,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

/** 构造 RCON 协议包（与生产实现独立，避免测试复用被测代码掩盖协议错误）。 */
function encodePacket(id, type, body) {
  const bodyBuffer = Buffer.from(body, 'utf8')
  const size = 4 + 4 + bodyBuffer.length + 2
  const packet = Buffer.alloc(4 + size)
  packet.writeInt32LE(size, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  bodyBuffer.copy(packet, 12)
  return packet
}

/** 建一个最小世界目录：level.dat + region 文件 + 必须被排除的 session.lock。 */
function makeWorld(root) {
  const worldDir = join(root, 'minecraft-server', 'world')
  mkdirSync(join(worldDir, 'region'), { recursive: true })
  writeFileSync(join(worldDir, 'level.dat'), 'level-data-'.repeat(200))
  writeFileSync(join(worldDir, 'region', 'r.0.0.mca'), 'region-data-'.repeat(200))
  writeFileSync(join(worldDir, 'session.lock'), 'session-lock')
  return worldDir
}

/** 生成测试配置：绕过 /etc 与真实 env 文件，但仍走 loadConfig 的解析路径。 */
function testConfig({ serverRoot, backupRoot, port, password = 'test-rcon-password' }) {
  return loadConfig({
    envFile: join(serverRoot, 'no-such-env'),
    env: {
      RCON_HOST: '127.0.0.1',
      RCON_PORT: String(port),
      RCON_PASSWORD: password,
      MC_SERVER_DIR: join(serverRoot, 'minecraft-server'),
      WORLD_BACKUP_DIR: backupRoot,
      WORLD_BACKUP_STATUS_FILE: join(serverRoot, 'status', 'world-backup-status.json'),
      WORLD_BACKUP_KEEP: '4',
    },
  })
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'afc-backup-world-'))
}

test('世界备份顺序正确：save-off → save-all flush → save-on，并写归档/SHA/状态', async () => {
  const root = tempRoot()
  const fake = await startFakeRcon()
  try {
    makeWorld(root)
    const backupRoot = join(root, 'world-backups')
    const config = testConfig({ serverRoot: root, backupRoot, port: fake.port })
    const now = new Date('2026-10-20T04:00:00.000Z')
    const result = await runBackup({ config, now, allowNonRoot: true, skipOwnership: true })
    assert.equal(result.ok, true, result.message ?? '')
    assert.deepEqual(fake.commands, ['save-off', 'save-all flush', 'save-on'])
    assert.equal(result.archiveName, 'world-20261020T040000Z.tar.gz')
    assert.equal(result.saveOnOk, true)
    assert.ok(result.sizeBytes > 0)
    const archivePath = join(backupRoot, result.archiveName)
    assert.ok(statSync(archivePath).isFile())
    assert.equal(await sha256File(archivePath), result.sha256)
    const sidecar = readFileSync(`${archivePath}.sha256`, 'utf8')
    assert.match(sidecar, new RegExp(`^${result.sha256}  world-20261020T040000Z\\.tar\\.gz\\n$`))
    // 状态 JSON 字段与面板/告警契约一致，error/warnings 为 ASCII。
    const status = JSON.parse(readFileSync(config.statusFile, 'utf8'))
    assert.equal(status.ok, true)
    assert.equal(status.archiveName, result.archiveName)
    assert.equal(status.sha256, result.sha256)
    assert.equal(status.keptCount, 1)
    assert.deepEqual(status.kept, [result.archiveName])
    assert.equal(status.saveOnOk, true)
    assert.equal(status.error, null)
    assert.equal(status.message, null)
    assert.deepEqual(status.errors, [])
    assert.ok([...readFileSync(config.statusFile, 'utf8')].every((char) => char.charCodeAt(0) < 128))
    // session.lock 必须被排除，level.dat 必须在归档内。
    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    assert.ok(listing.includes('world/level.dat'))
    assert.ok(!listing.includes('session.lock'))
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('tar 退出码 1 可容忍：gzip 校验通过则归档成功并记 warning', async () => {
  const root = tempRoot()
  const fake = await startFakeRcon()
  try {
    makeWorld(root)
    const backupRoot = join(root, 'world-backups')
    const config = testConfig({ serverRoot: root, backupRoot, port: fake.port })
    const result = await runBackup({
      config,
      now: new Date('2026-10-20T04:00:00.000Z'),
      allowNonRoot: true,
      skipOwnership: true,
      tarRunner: async ({ tarBin, args }) => {
        execFileSync(tarBin, args)
        return { exitCode: 1 }
      },
    })
    assert.equal(result.ok, true, result.message ?? '')
    assert.equal(result.tarExitCode, 1)
    assert.ok(result.warnings.includes('tar_exit_1_warn'))
    assert.ok(statSync(join(backupRoot, 'world-20261020T040000Z.tar.gz')).isFile())
    const status = JSON.parse(readFileSync(config.statusFile, 'utf8'))
    assert.equal(status.ok, true)
    assert.deepEqual(status.warnings, ['tar_exit_1_warn'])
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('gzip 校验失败时不移动 .part、不产出归档并清理半成品', async () => {
  const root = tempRoot()
  const fake = await startFakeRcon()
  try {
    makeWorld(root)
    const backupRoot = join(root, 'world-backups')
    const config = testConfig({ serverRoot: root, backupRoot, port: fake.port })
    const result = await runBackup({
      config,
      now: new Date('2026-10-20T04:00:00.000Z'),
      allowNonRoot: true,
      skipOwnership: true,
      tarRunner: async ({ args }) => {
        writeFileSync(args[1], 'not a gzip stream')
        return { exitCode: 0 }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'gzip_check_failed')
    assert.match(result.message, /gzip integrity check failed/)
    assert.deepEqual(readdirSync(backupRoot), [])
    assert.equal(result.archiveName, null)
    const status = JSON.parse(readFileSync(config.statusFile, 'utf8'))
    assert.equal(status.error, 'gzip_check_failed')
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('tar 失败时仍执行 save-on，状态为失败且不留半成品', async () => {
  const root = tempRoot()
  const fake = await startFakeRcon()
  try {
    makeWorld(root)
    const backupRoot = join(root, 'world-backups')
    const config = testConfig({ serverRoot: root, backupRoot, port: fake.port })
    const result = await runBackup({
      config,
      now: new Date('2026-10-20T04:00:00.000Z'),
      allowNonRoot: true,
      skipOwnership: true,
      tarRunner: async () => {
        throw new Error('simulated tar failure')
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'tar_failed')
    assert.match(result.message, /simulated tar failure/)
    assert.equal(fake.commands[0], 'save-off')
    assert.equal(fake.commands[fake.commands.length - 1], 'save-on')
    assert.equal(result.saveOnOk, true)
    assert.deepEqual(readdirSync(backupRoot), [])
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('save-all flush 返回未知命令时重试一次并失败，但仍发 save-on', async () => {
  const root = tempRoot()
  const fake = await startFakeRcon({ failFlush: true })
  try {
    makeWorld(root)
    const backupRoot = join(root, 'world-backups')
    const config = testConfig({ serverRoot: root, backupRoot, port: fake.port })
    const result = await runBackup({ config, now: new Date('2026-10-20T04:00:00.000Z'), allowNonRoot: true, skipOwnership: true })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'save_all_flush_failed')
    assert.deepEqual(
      fake.commands.filter((command) => command === 'save-all flush'),
      ['save-all flush', 'save-all flush'],
    )
    assert.equal(fake.commands[fake.commands.length - 1], 'save-on')
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('RCON 认证失败时不执行 save-off，也不需要 save-on', async () => {
  const root = tempRoot()
  const fake = await startFakeRcon({ password: 'correct-password' })
  try {
    makeWorld(root)
    const backupRoot = join(root, 'world-backups')
    const config = testConfig({ serverRoot: root, backupRoot, port: fake.port, password: 'wrong-password' })
    const result = await runBackup({ config, now: new Date('2026-10-20T04:00:00.000Z'), allowNonRoot: true, skipOwnership: true })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'rcon_auth_failed')
    assert.match(result.message, /authentication failed/)
    assert.deepEqual(fake.commands, [])
    assert.equal(result.saveOnOk, null)
    assert.equal(result.saveOnSkipped, true)
    const status = JSON.parse(readFileSync(config.statusFile, 'utf8'))
    assert.equal(status.ok, false)
    assert.equal(status.error, 'rcon_auth_failed')
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('保留最新 4 份：只删除匹配命名的归档/旁文件，旧 legacy 与其它文件不动', async () => {
  const root = tempRoot()
  makeWorld(root)
  const backupRoot = join(root, 'world-backups')
  mkdirSync(backupRoot, { recursive: true })
  const oldNames = [
    'world-20261015T040000Z.tar.gz',
    'world-20261016T040000Z.tar.gz',
    'world-20261017T040000Z.tar.gz',
    'world-20261018T040000Z.tar.gz',
    'world-20261019T040000Z.tar.gz',
  ]
  for (const name of oldNames) {
    writeFileSync(join(backupRoot, name), 'old-archive')
    writeFileSync(join(backupRoot, `${name}.sha256`), 'old-sidecar')
  }
  writeFileSync(join(backupRoot, 'notes.txt'), 'do-not-delete')
  writeFileSync(join(backupRoot, 'world-20261020.tar.gz'), 'legacy-cron-archive')
  try {
    // 纯函数级校验：不依赖 RCON。
    const keepResult = pruneArchives(backupRoot, 4)
    assert.deepEqual(keepResult.kept, [
      'world-20261019T040000Z.tar.gz',
      'world-20261018T040000Z.tar.gz',
      'world-20261017T040000Z.tar.gz',
      'world-20261016T040000Z.tar.gz',
    ])
    const remaining = readdirSync(backupRoot).sort()
    assert.ok(!remaining.includes('world-20261015T040000Z.tar.gz'))
    assert.ok(!remaining.includes('world-20261015T040000Z.tar.gz.sha256'))
    assert.ok(remaining.includes('notes.txt'))
    // 旧 cron 的 world-YYYYMMDD.tar.gz 不匹配新命名，保留不动。
    assert.ok(remaining.includes('world-20261020.tar.gz'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadConfig：RCON 密码回退 server.properties，环境变量优先', () => {
  const root = tempRoot()
  try {
    const serverDir = join(root, 'minecraft-server')
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(
      join(serverDir, 'server.properties'),
      ['enable-rcon=true', 'rcon.port=25599', 'rcon.password=properties-secret', 'level-name=world'].join('\n'),
    )
    const fromProperties = loadConfig({
      envFile: join(root, 'no-such-env'),
      env: { MC_SERVER_DIR: serverDir, WORLD_BACKUP_DIR: join(root, 'backups') },
    })
    assert.equal(fromProperties.rconPassword, 'properties-secret')
    assert.equal(fromProperties.rconPort, 25599)
    assert.equal(fromProperties.levelName, 'world')

    const fromEnv = loadConfig({
      envFile: join(root, 'no-such-env'),
      env: { MC_SERVER_DIR: serverDir, RCON_PASSWORD: 'env-secret', RCON_PORT: '25600' },
    })
    assert.equal(fromEnv.rconPassword, 'env-secret')
    assert.equal(fromEnv.rconPort, 25600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
