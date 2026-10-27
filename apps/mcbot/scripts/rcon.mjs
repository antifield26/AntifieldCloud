#!/usr/bin/env node
// Minimal RCON client for Lofii operations. Reads server.properties, never prints the password.
import net from 'node:net'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function resolveProperties () {
  const candidates = []
  if (process.env.MC_SERVER_PROPERTIES) candidates.push(process.env.MC_SERVER_PROPERTIES)
  if (process.env.MC_SERVER_DIR) candidates.push(path.join(process.env.MC_SERVER_DIR, 'server.properties'))
  candidates.push('/home/antifield/minecraft-server/server.properties')
  candidates.push(path.join(os.homedir(), 'minecraft-server', 'server.properties'))
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8')
      return candidate
    } catch {
      // try next
    }
  }
  throw new Error(`server.properties not found (tried: ${candidates.join(', ')})`)
}

function readProperties (file) {
  const result = new Map()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    result.set(line.slice(0, index).trim(), line.slice(index + 1))
  }
  return result
}

function packet (id, type, body) {
  const payload = Buffer.concat([Buffer.from(body, 'utf8'), Buffer.alloc(2)])
  const header = Buffer.alloc(12)
  header.writeInt32LE(payload.length + 8, 0)
  header.writeInt32LE(id, 4)
  header.writeInt32LE(type, 8)
  return Buffer.concat([header, payload])
}

function readPacket (socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const length = buffer.readInt32LE(0)
      if (buffer.length < 4 + length) return
      socket.removeListener('data', onData)
      const id = buffer.readInt32LE(4)
      const type = buffer.readInt32LE(8)
      let payload = buffer.subarray(12, 4 + length).toString('utf8')
      while (payload.endsWith('\u0000')) payload = payload.slice(0, -1)
      resolve({ id, type, payload })
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.once('close', () => reject(new Error('connection closed')))
  })
}

const propertiesFile = resolveProperties()
const properties = readProperties(propertiesFile)
const host = process.env.RCON_HOST ?? '127.0.0.1'
const port = Number(process.env.RCON_PORT ?? properties.get('rcon.port') ?? 25575)
const password = process.env.RCON_PASSWORD ?? properties.get('rcon.password') ?? ''
if (!password) {
  console.error('rcon.password is empty in server.properties')
  process.exit(1)
}

const commands = process.argv.slice(2)
if (commands.length === 0) {
  console.error('usage: node scripts/rcon.mjs "command" ["command"...]')
  process.exit(2)
}

const socket = net.createConnection({ host, port })
socket.setTimeout(5000)
socket.once('timeout', () => {
  console.error('RCON timeout')
  socket.destroy()
  process.exit(1)
})
await new Promise((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})

const login = readPacket(socket)
socket.write(packet(1, 3, password))
const loginResponse = await login
if (loginResponse.type !== 2 || loginResponse.id !== 1) {
  console.error('RCON authentication failed')
  socket.destroy()
  process.exit(1)
}

let id = 2
for (const command of commands) {
  const pending = readPacket(socket)
  socket.write(packet(id, 2, command))
  const response = await pending
  console.log(`[${command}]`)
  console.log(response.payload)
  id += 1
}
socket.end()
