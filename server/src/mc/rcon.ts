/**
 * 最小 RCON 客户端：只实现认证 + 单条命令，供只读状态与白名单增删使用。
 * 支持多包响应（Minecraft 会把 >4096B 的响应拆成多个包），并有总长度上限与
 * 空闲超时，任何异常都不会挂起调用方。
 */
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'

const TYPE_RESPONSE = 0
const TYPE_COMMAND = 2
const TYPE_AUTH = 3
/** Minecraft 单包最大约 4096B；等待下一包的空闲窗口。 */
const IDLE_READ_TIMEOUT_MS = 150
/** 单条命令累计响应上限，防止恶意/异常服务器撑爆内存。 */
const MAX_TOTAL_BYTES = 1024 * 1024

export class RconError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RconError'
  }
}

class RconTimeoutError extends RconError {
  constructor(message = 'RCON 读取超时') {
    super(message)
    this.name = 'RconTimeoutError'
  }
}

interface RconPacket {
  id: number
  type: number
  body: string
}

class PacketReader {
  private buffer = Buffer.alloc(0)
  private waiter: (() => void) | null = null
  private failure: Error | null = null

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.waiter?.()
      this.waiter = null
    })
    socket.on('error', (error) => {
      this.failure = error
      this.waiter?.()
      this.waiter = null
    })
    socket.on('close', () => {
      if (!this.failure) this.failure = new RconError('RCON 连接已关闭')
      this.waiter?.()
      this.waiter = null
    })
  }

  private waitForData(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new RconTimeoutError())
      }, Math.max(1, timeoutMs))
      this.waiter = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private async ensure(size: number, deadline: number): Promise<void> {
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new RconTimeoutError()
      await this.waitForData(remaining)
    }
  }

  async readExact(size: number, deadline: number): Promise<Buffer> {
    await this.ensure(size, deadline)
    const out = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return out
  }
}

function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuffer = Buffer.from(body, 'utf8')
  const payload = Buffer.alloc(4 + 4 + bodyBuffer.length + 2)
  payload.writeInt32LE(id, 0)
  payload.writeInt32LE(type, 4)
  bodyBuffer.copy(payload, 8)
  const frame = Buffer.alloc(4 + payload.length)
  frame.writeInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

async function readPacket(reader: PacketReader, deadline: number): Promise<RconPacket> {
  const lengthBuffer = await reader.readExact(4, deadline)
  const length = lengthBuffer.readInt32LE(0)
  if (length < 10 || length > 16 * 1024 * 1024) throw new RconError('RCON 包长度非法')
  const payload = await reader.readExact(length, deadline)
  const id = payload.readInt32LE(0)
  const type = payload.readInt32LE(4)
  const body = payload.subarray(8, payload.length - 2).toString('utf8')
  return { id, type, body }
}

export interface RconOptions {
  host: string
  port: number
  password: string
  timeoutMs?: number
}

export async function rconCommand(options: RconOptions, command: string): Promise<string> {
  if (!options.password) throw new RconError('未配置 RCON 密码')
  const timeoutMs = options.timeoutMs ?? 4000
  const deadline = Date.now() + timeoutMs
  const socket = createConnection({ host: options.host, port: options.port })
  socket.setNoDelay(true)
  const reader = new PacketReader(socket)
  const timer = setTimeout(() => socket.destroy(new RconError('RCON 超时')), timeoutMs)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    socket.write(encodePacket(1, TYPE_AUTH, options.password))
    const auth = await readPacket(reader, deadline)
    if (auth.id === -1) throw new RconError('RCON 认证失败')

    socket.write(encodePacket(2, TYPE_COMMAND, command))
    const chunks: string[] = []
    let totalBytes = 0
    let first = true
    while (true) {
      let packet: RconPacket
      try {
        const readDeadline = first ? deadline : Math.min(deadline, Date.now() + IDLE_READ_TIMEOUT_MS)
        packet = await readPacket(reader, readDeadline)
      } catch (error) {
        // 已收到至少一个包时，后续空闲超时/连接关闭视为响应结束。
        if (!first && chunks.length > 0) break
        if (error instanceof RconTimeoutError) throw new RconError('RCON 响应超时')
        throw error
      }
      first = false
      totalBytes += packet.body.length
      if (totalBytes > MAX_TOTAL_BYTES) throw new RconError('RCON 响应过大')
      if (packet.type === TYPE_RESPONSE || packet.type === TYPE_COMMAND) {
        chunks.push(packet.body)
      } else {
        throw new RconError(`RCON 响应类型异常：${packet.type}`)
      }
    }
    if (chunks.length === 0) throw new RconError('RCON 未返回响应')
    return chunks.join('')
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
}
