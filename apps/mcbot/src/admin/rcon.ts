import net from 'node:net'

const READONLY_COMMANDS = new Set(['tps', 'list', 'whitelist list', 'time'])

export class RconError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'RconError'
  }
}

export interface RconOptions {
  host: string
  port: number
  password: string
  timeoutMs: number
}

function packet (id: number, type: number, body: string): Buffer {
  const payload = Buffer.concat([Buffer.from(body, 'utf8'), Buffer.alloc(2)])
  const header = Buffer.alloc(12)
  header.writeInt32LE(payload.length + 8, 0)
  header.writeInt32LE(id, 4)
  header.writeInt32LE(type, 8)
  return Buffer.concat([header, payload])
}

function readPacket (socket: net.Socket, timeoutMs: number): Promise<{ id: number, type: number, body: string }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const length = buffer.readInt32LE(0)
      if (length < 8 || length > 1024 * 1024) return fail(new RconError('invalid RCON packet length'))
      if (buffer.length < 4 + length) return
      const id = buffer.readInt32LE(4)
      const type = buffer.readInt32LE(8)
      let body = buffer.subarray(12, 4 + length).toString('utf8')
      while (body.endsWith('\u0000')) body = body.slice(0, -1)
      cleanup()
      resolve({ id, type, body })
    }
    const onError = (error: Error): void => fail(error)
    const onClose = (): void => fail(new RconError('RCON connection closed'))
    timer = setTimeout(() => fail(new RconError('RCON timeout')), timeoutMs)
    timer.unref?.()
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function connect (options: RconOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new RconError('RCON connect timeout'))
    }, options.timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export function isReadOnlyCommand (command: string): boolean {
  return READONLY_COMMANDS.has(command)
}

/**
 * Minimal read-only RCON client. The server has a single password, so the
 * allowlist is enforced here and only the three commands below are ever sent.
 */
export class RconClient {
  private readonly options: RconOptions

  constructor (options: RconOptions) {
    this.options = options
  }

  async command (command: string): Promise<string> {
    if (!isReadOnlyCommand(command)) throw new RconError(`RCON command is not read-only: ${command}`)
    const socket = await connect(this.options)
    try {
      const login = readPacket(socket, this.options.timeoutMs)
      socket.write(packet(1, 3, this.options.password))
      const auth = await login
      if (auth.type !== 2 || auth.id !== 1) throw new RconError('RCON authentication failed')

      const response = readPacket(socket, this.options.timeoutMs)
      socket.write(packet(2, 2, command))
      const reply = await response
      if (reply.id !== 2) throw new RconError('invalid RCON response id')
      return reply.body
    } finally {
      socket.end()
      socket.destroy()
    }
  }
}
