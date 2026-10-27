import net from 'node:net'

export interface SlpResult {
  versionName: string | null
  protocol: number | null
  online: number
  max: number
  sampleNames: string[]
  motd: string | null
  latencyMs: number
}

export interface SlpOptions {
  host: string
  port: number
  protocolVersion?: number
  timeoutMs?: number
}

const DEFAULT_PROTOCOL = 775
const DEFAULT_TIMEOUT = 3000

export function encodeVarInt (value: number): Buffer {
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

export function decodeVarInt (buffer: Buffer, offset = 0): { value: number, size: number } | null {
  let value = 0
  let shift = 0
  for (let index = offset; index < buffer.length; index++) {
    const byte = buffer[index]
    if (byte === undefined) return null
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, size: index - offset + 1 }
    }
    shift += 7
    if (shift > 35) return null
  }
  return null
}

function encodeString (value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeVarInt(body.length), body])
}

function flattenDescription (input: unknown): string {
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return input.map(flattenDescription).join('')
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const own = typeof record.text === 'string' ? record.text : ''
    const extra = Array.isArray(record.extra) ? record.extra.map(flattenDescription).join('') : ''
    return own + extra
  }
  return ''
}

function stripFormatting (text: string): string {
  return text.replace(/§./g, '').replace(/\s+/g, ' ').trim()
}

export function parseStatusJson (raw: string): Omit<SlpResult, 'latencyMs'> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid SLP status JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid SLP status payload')
  const record = parsed as Record<string, unknown>
  const version = (record.version ?? {}) as Record<string, unknown>
  const players = (record.players ?? {}) as Record<string, unknown>
  const sample = Array.isArray(players.sample) ? players.sample : []
  const sampleNames = sample
    .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>).name : null))
    .filter((name): name is string => typeof name === 'string')
  const online = typeof players.online === 'number' ? players.online : 0
  const max = typeof players.max === 'number' ? players.max : 0
  const versionName = typeof version.name === 'string' ? version.name : null
  const protocol = typeof version.protocol === 'number' ? version.protocol : null
  const motdRaw = stripFormatting(flattenDescription(record.description))
  return {
    versionName,
    protocol,
    online,
    max,
    sampleNames,
    motd: motdRaw === '' ? null : motdRaw.slice(0, 200)
  }
}

function parseStatusPacket (buffer: Buffer): { consumed: number, json: string } | null {
  const frameLength = decodeVarInt(buffer, 0)
  if (!frameLength) return null
  const frameStart = frameLength.size
  const frameEnd = frameStart + frameLength.value
  if (buffer.length < frameEnd) return null
  const frame = buffer.subarray(frameStart, frameEnd)
  const packetId = decodeVarInt(frame, 0)
  if (!packetId || packetId.value !== 0) throw new Error('unexpected SLP packet id')
  const jsonLength = decodeVarInt(frame, packetId.size)
  if (!jsonLength) throw new Error('invalid SLP string length')
  const jsonStart = packetId.size + jsonLength.size
  const jsonEnd = jsonStart + jsonLength.value
  if (frame.length < jsonEnd) throw new Error('truncated SLP status response')
  return {
    consumed: frameEnd,
    json: frame.subarray(jsonStart, jsonEnd).toString('utf8')
  }
}

export function buildHandshakePacket (host: string, port: number, protocolVersion = DEFAULT_PROTOCOL): Buffer {
  const portBuffer = Buffer.alloc(2)
  portBuffer.writeUInt16BE(port, 0)
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    encodeVarInt(protocolVersion),
    encodeString(host),
    portBuffer,
    Buffer.from([0x01])
  ])
  return Buffer.concat([encodeVarInt(payload.length), payload])
}

export function buildStatusRequest (): Buffer {
  return Buffer.from([0x01, 0x00])
}

export function pingServer (options: SlpOptions): Promise<SlpResult> {
  const host = options.host
  const port = options.port
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

  return new Promise<SlpResult>((resolve, reject) => {
    const startedAt = Date.now()
    const socket = net.createConnection({ host, port })
    const chunks: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (error: Error | null, result?: SlpResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else if (result) resolve(result)
    }

    timer = setTimeout(() => finish(new Error(`SLP timeout after ${timeoutMs}ms`)), timeoutMs)
    socket.setNoDelay(true)
    socket.once('error', error => finish(error))
    socket.once('end', () => {
      if (!settled) finish(new Error('SLP connection ended before status response'))
    })
    socket.once('connect', () => {
      socket.write(buildHandshakePacket(host, port, protocolVersion))
      socket.write(buildStatusRequest())
    })
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      let packet: { consumed: number, json: string } | null = null
      try {
        packet = parseStatusPacket(buffer)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!packet) return
      try {
        const status = parseStatusJson(packet.json)
        finish(null, { ...status, latencyMs: Date.now() - startedAt })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}
