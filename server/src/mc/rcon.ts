/** 最小 RCON 客户端：只实现认证 + 单条命令，供只读状态与白名单增删使用。 */
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'

const TYPE_RESPONSE = 0
const TYPE_COMMAND = 2
const TYPE_AUTH = 3

export class RconError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RconError'
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

  private async ensure(size: number): Promise<void> {
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }

  async readExact(size: number): Promise<Buffer> {
    await this.ensure(size)
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

async function readPacket(reader: PacketReader): Promise<RconPacket> {
  const lengthBuffer = await reader.readExact(4)
  const length = lengthBuffer.readInt32LE(0)
  if (length < 10 || length > 16 * 1024 * 1024) throw new RconError('RCON 包长度非法')
  const payload = await reader.readExact(length)
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
    const auth = await readPacket(reader)
    if (auth.id === -1) throw new RconError('RCON 认证失败')
    socket.write(encodePacket(2, TYPE_COMMAND, command))
    const response = await readPacket(reader)
    if (response.type !== TYPE_RESPONSE && response.type !== TYPE_COMMAND) {
      throw new RconError(`RCON 响应类型异常：${response.type}`)
    }
    return response.body
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
}
