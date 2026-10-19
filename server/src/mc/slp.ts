/** Minecraft Server List Ping（协议 775）：只读状态，不引入第三方依赖。 */
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'

export interface SlpStatus {
  version: string
  protocol: number
  motd: string
  playersOnline: number
  playersMax: number
  samplePlayers: string[]
}

interface SlpRaw {
  version?: { name?: string; protocol?: number }
  players?: { online?: number; max?: number; sample?: { name?: string }[] }
  description?: string | { text?: string; extra?: unknown[] } | unknown
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let current = value >>> 0
  do {
    let byte = current & 0x7f
    current >>>= 7
    if (current !== 0) byte |= 0x80
    bytes.push(byte)
  } while (current !== 0)
  return Buffer.from(bytes)
}

function writeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

class SocketReader {
  private buffer = Buffer.alloc(0)
  private waiter: { resolve: () => void; reject: (error: Error) => void } | null = null
  private failure: Error | null = null
  private ended = false

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.waiter?.resolve()
      this.waiter = null
    })
    socket.on('error', (error) => {
      this.failure = error
      this.waiter?.reject(error)
      this.waiter = null
    })
    socket.on('close', () => {
      this.ended = true
      this.failure = new Error('连接已关闭')
      this.waiter?.reject(this.failure)
      this.waiter = null
    })
  }

  private async ensure(size: number): Promise<void> {
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure
      if (this.ended) throw new Error('连接已关闭')
      await new Promise<void>((resolve, reject) => {
        this.waiter = { resolve, reject }
      })
    }
  }

  async readVarInt(): Promise<number> {
    let value = 0
    for (let shift = 0; shift < 35; shift += 7) {
      await this.ensure(1)
      const byte = this.buffer[0]!
      this.buffer = this.buffer.subarray(1)
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value >>> 0
    }
    throw new Error('VarInt 过长')
  }

  async readBytes(size: number): Promise<Buffer> {
    await this.ensure(size)
    const out = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return out
  }

  async readString(maxBytes = 2 * 1024 * 1024): Promise<string> {
    const length = await this.readVarInt()
    if (length < 0 || length > maxBytes) throw new Error('字符串长度非法')
    const body = await this.readBytes(length)
    return body.toString('utf8')
  }
}

function collectMotd(value: unknown, parts: string[]): void {
  if (typeof value === 'string') {
    parts.push(value)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as { text?: unknown; extra?: unknown }
  if (typeof record.text === 'string') parts.push(record.text)
  if (Array.isArray(record.extra)) {
    for (const item of record.extra) collectMotd(item, parts)
  }
}

export function flattenMotd(value: unknown): string {
  const parts: string[] = []
  collectMotd(value, parts)
  return stripColors(parts.join('')).trimEnd()
}

export function stripColors(value: string): string {
  return value.replace(/\u00a7./g, '').replace(/§./g, '')
}

export async function pingStatus(host: string, port: number, timeoutMs = 2500): Promise<SlpStatus> {
  const socket = createConnection({ host, port })
  socket.setNoDelay(true)
  const reader = new SocketReader(socket)
  const timer = setTimeout(() => socket.destroy(new Error('SLP 超时')), timeoutMs)
  try {
    const handshakeBody = Buffer.concat([
      writeVarInt(775),
      writeString(host),
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      writeVarInt(1),
    ])
    const handshake = Buffer.concat([writeVarInt(handshakeBody.length + 1), writeVarInt(0), handshakeBody])
    socket.write(handshake)
    socket.write(Buffer.from([0x01, 0x00]))
    const packetLength = await reader.readVarInt()
    if (packetLength <= 0 || packetLength > 4 * 1024 * 1024) throw new Error('SLP 响应长度非法')
    const payload = await reader.readBytes(packetLength)
    // 解析 packet id + JSON string（不依赖 reader 的 buffer，直接读 payload）。
    let offset = 0
    const readVar = (): number => {
      let value = 0
      for (let shift = 0; shift < 35; shift += 7) {
        const byte = payload[offset++] ?? 0
        value |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) return value >>> 0
      }
      throw new Error('SLP VarInt 过长')
    }
    readVar()
    const jsonLength = readVar()
    if (jsonLength < 0 || offset + jsonLength > payload.length) throw new Error('SLP JSON 长度非法')
    const json = payload.subarray(offset, offset + jsonLength).toString('utf8')
    const raw = JSON.parse(json) as SlpRaw
    return {
      version: raw.version?.name ?? '',
      protocol: raw.version?.protocol ?? 0,
      motd: flattenMotd(raw.description),
      playersOnline: raw.players?.online ?? 0,
      playersMax: raw.players?.max ?? 0,
      samplePlayers: (raw.players?.sample ?? [])
        .map((item) => item?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    }
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
}
