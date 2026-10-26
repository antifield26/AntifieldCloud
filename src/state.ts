export type BotState = 'idle' | 'connecting' | 'connected' | 'backoff' | 'cooldown'

export interface Position {
  x: number
  y: number
  z: number
}

export interface DisconnectInfo {
  at: string
  reason: string
}

export interface MinecraftSnapshot {
  connected: boolean
  username: string
  host: string
  port: number
  version: string
  reconnects: number
  lastDisconnect: DisconnectInfo | null
}

export interface PlayerSnapshot {
  dimension: string | null
  position: Position | null
  health: number | null
  food: number | null
}

export interface ServerSnapshot {
  reachable: boolean
  online: number
  max: number
  versionName: string | null
  motd: string | null
  latencyMs: number | null
  lastPingAt: string | null
}

export interface PresenceSnapshot {
  enabled: boolean
  pollMs: number
  graceMs: number
  checkMs: number
  otherPlayers: number
  lastDecision: string
}

export interface AiSnapshot {
  enabled: boolean
  provider: string
  model: string
  inFlight: number
  queued: number
  failures: number
  lastLatencyMs: number | null
  lastError: string | null
}

export interface MemorySnapshot {
  players: number
  turns: number
}

export type TaskName = 'fishing' | 'farming'
export type TaskState = 'idle' | 'starting' | 'running' | 'depositing' | 'recovering' | 'stopping' | 'pending_resume'

export interface TaskProgress {
  fishCaught: number
  wheatHarvested: number
  planted: number
  deposited: number
}

export interface PendingResume {
  taskId: string
  name: TaskName
  startedAt: string
  elapsedSec: number
  progress: TaskProgress
  expiresAt: string
}

export interface TaskSnapshot {
  enabled: boolean
  active: boolean
  name: TaskName | null
  state: TaskState
  startedAt: string | null
  elapsedSec: number
  progress: TaskProgress
  failures: number
  lastError: string | null
  pendingResume: PendingResume | null
}

export interface StatusSnapshot {
  version: string
  uptimeSec: number
  state: BotState
  minecraft: MinecraftSnapshot
  player: PlayerSnapshot
  server: ServerSnapshot
  presence: PresenceSnapshot
  ai: AiSnapshot
  memory: MemorySnapshot
  task: TaskSnapshot
}

function roundPosition (position: Position | null): Position | null {
  if (!position) return null
  return {
    x: Math.round(position.x * 100) / 100,
    y: Math.round(position.y * 100) / 100,
    z: Math.round(position.z * 100) / 100
  }
}

export class RuntimeState {
  readonly startedAt = Date.now()
  readonly version: string

  state: BotState = 'idle'
  minecraft: MinecraftSnapshot
  player: PlayerSnapshot = { dimension: null, position: null, health: null, food: null }
  server: ServerSnapshot = {
    reachable: false,
    online: 0,
    max: 0,
    versionName: null,
    motd: null,
    latencyMs: null,
    lastPingAt: null
  }

  presence: PresenceSnapshot
  ai: AiSnapshot
  memory: MemorySnapshot = { players: 0, turns: 0 }
  task: TaskSnapshot
  lastDecision = 'startup'

  constructor (options: {
    version: string
    username: string
    host: string
    port: number
    minecraftVersion: string
    presenceEnabled: boolean
    presencePollMs: number
    presenceGraceMs: number
    presenceCheckMs: number
    aiEnabled: boolean
    aiProvider: string
    aiModel: string
    taskEnabled: boolean
  }) {
    this.version = options.version
    this.minecraft = {
      connected: false,
      username: options.username,
      host: options.host,
      port: options.port,
      version: options.minecraftVersion,
      reconnects: 0,
      lastDisconnect: null
    }
    this.presence = {
      enabled: options.presenceEnabled,
      pollMs: options.presencePollMs,
      graceMs: options.presenceGraceMs,
      checkMs: options.presenceCheckMs,
      otherPlayers: 0,
      lastDecision: 'startup'
    }
    this.ai = {
      enabled: options.aiEnabled,
      provider: options.aiProvider,
      model: options.aiModel,
      inFlight: 0,
      queued: 0,
      failures: 0,
      lastLatencyMs: null,
      lastError: null
    }
    this.task = {
      enabled: options.taskEnabled,
      active: false,
      name: null,
      state: 'idle',
      startedAt: null,
      elapsedSec: 0,
      progress: { fishCaught: 0, wheatHarvested: 0, planted: 0, deposited: 0 },
      failures: 0,
      lastError: null,
      pendingResume: null
    }
  }

  setState (state: BotState, decision?: string): void {
    this.state = state
    if (decision) {
      this.lastDecision = decision
      this.presence.lastDecision = decision
    }
    this.minecraft.connected = state === 'connected'
  }

  setMinecraftConnected (connected: boolean, version?: string): void {
    this.minecraft.connected = connected
    if (version) this.minecraft.version = version
  }

  recordDisconnect (reason: string): void {
    this.minecraft.reconnects += 1
    this.minecraft.lastDisconnect = { at: new Date().toISOString(), reason }
  }

  setPlayer (player: PlayerSnapshot): void {
    this.player = player
  }

  clearPlayer (): void {
    this.player = { dimension: null, position: null, health: null, food: null }
  }

  setServer (server: ServerSnapshot): void {
    this.server = server
  }

  setPresence (otherPlayers: number, decision: string): void {
    this.presence.otherPlayers = otherPlayers
    this.presence.lastDecision = decision
    this.lastDecision = decision
  }

  setAi (patch: Partial<AiSnapshot>): void {
    this.ai = { ...this.ai, ...patch }
  }

  recordAiFailure (message: string): void {
    this.ai.failures += 1
    this.ai.lastError = message
  }

  setMemory (memory: MemorySnapshot): void {
    this.memory = memory
  }

  setTask (patch: Partial<TaskSnapshot>): void {
    this.task = {
      ...this.task,
      ...patch,
      progress: patch.progress ? { ...patch.progress } : this.task.progress,
      pendingResume: patch.pendingResume === undefined
        ? this.task.pendingResume
        : (patch.pendingResume ? { ...patch.pendingResume, progress: { ...patch.pendingResume.progress } } : null)
    }
  }

  snapshot (): StatusSnapshot {
    const now = Date.now()
    const task: TaskSnapshot = {
      ...this.task,
      progress: { ...this.task.progress },
      pendingResume: this.task.pendingResume
        ? { ...this.task.pendingResume, progress: { ...this.task.pendingResume.progress } }
        : null
    }
    if (task.startedAt && (task.active || task.state === 'pending_resume')) {
      const startedAt = Date.parse(task.startedAt)
      if (Number.isFinite(startedAt)) {
        task.elapsedSec = Math.max(task.elapsedSec, Math.floor((now - startedAt) / 1000))
        if (task.pendingResume) {
          const pendingStartedAt = Date.parse(task.pendingResume.startedAt)
          if (Number.isFinite(pendingStartedAt)) {
            task.pendingResume.elapsedSec = Math.max(
              task.pendingResume.elapsedSec,
              Math.floor((now - pendingStartedAt) / 1000)
            )
          }
        }
      }
    }
    return {
      version: this.version,
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      state: this.state,
      minecraft: { ...this.minecraft, lastDisconnect: this.minecraft.lastDisconnect ? { ...this.minecraft.lastDisconnect } : null },
      player: { ...this.player, position: roundPosition(this.player.position) },
      server: { ...this.server },
      presence: { ...this.presence },
      ai: { ...this.ai },
      memory: { ...this.memory },
      task
    }
  }
}
