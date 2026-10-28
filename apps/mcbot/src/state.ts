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

export type AutonomyState = 'idle' | 'starting' | 'running' | 'stopping' | 'finished' | 'failed'

/** AI 自主会话的只读快照；不包含 run_id、Token 或提示词正文。 */
export interface AutonomySnapshot {
  enabled: boolean
  active: boolean
  state: AutonomyState
  goal: string | null
  startedAt: string | null
  elapsedSec: number
  remainingSec: number
  toolCalls: number
  maxToolCalls: number
  lastAction: string | null
  lastReason: string | null
  lastError: string | null
  lastDecisionAt: string | null
  decisionCycles: number
  lastEvent: string | null
  lastObservedAt: string | null
  blockers: string[]
}

export type TaskName =
  | 'fishing'
  | 'farming'
  | 'woodcutting'
  | 'mining'
  | 'forest'
  | 'sleep'
  | 'patrol'
  | 'guard'
  | 'escort'
  | 'explore'
export type TaskState = 'idle' | 'starting' | 'running' | 'depositing' | 'recovering' | 'stopping' | 'defending' | 'pending_resume'

export interface TaskProgress {
  fishCaught: number
  wheatHarvested: number
  planted: number
  deposited: number
  treesChopped: number
  logsChopped: number
  saplingsPlanted: number
  mobsKilled: number
  oresMined: number
  coalMined: number
  ironMined: number
  copperMined: number
  forestTreesChopped: number
  naturalLogsChopped: number
  naturalSaplingsPlanted: number
  sleepVotes: number
  nightSkipped: number
  patrolWaypoints: number
  patrolDistance: number
  guardKills: number
  escortDistance: number
  exploreWaypoints: number
}

export interface AdminSnapshot {
  enabled: boolean
  rcon: boolean
  updatedAt: string | null
  lastError: string | null
  tps: { one: number | null, five: number | null, fifteen: number | null }
  online: { count: number | null, max: number | null, players: string[] }
  whitelist: { count: number | null, names: string[] }
  time: { ticks: number | null, label: string | null }
  backup: { status: 'unknown' }
}

export interface QueuedTask {
  taskId: string
  name: TaskName
  requestedBy: string
  requestedAt: string
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
  queue: QueuedTask[]
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
  autonomy: AutonomySnapshot
  admin: AdminSnapshot
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
  autonomy: AutonomySnapshot
  admin: AdminSnapshot
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
    autonomyEnabled?: boolean
    autonomyMaxToolCalls?: number
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
      progress: {
        fishCaught: 0,
        wheatHarvested: 0,
        planted: 0,
        deposited: 0,
        treesChopped: 0,
        logsChopped: 0,
        saplingsPlanted: 0,
        mobsKilled: 0,
        oresMined: 0,
        coalMined: 0,
        ironMined: 0,
        copperMined: 0,
        forestTreesChopped: 0,
        naturalLogsChopped: 0,
        naturalSaplingsPlanted: 0,
        sleepVotes: 0,
        nightSkipped: 0,
        patrolWaypoints: 0,
        patrolDistance: 0,
        guardKills: 0,
        escortDistance: 0,
        exploreWaypoints: 0
      },
      failures: 0,
      lastError: null,
      pendingResume: null,
      queue: []
    }
    this.autonomy = {
      enabled: options.autonomyEnabled === true,
      active: false,
      state: 'idle',
      goal: null,
      startedAt: null,
      elapsedSec: 0,
      remainingSec: 0,
      toolCalls: 0,
      maxToolCalls: options.autonomyMaxToolCalls ?? 0,
      lastAction: null,
      lastReason: null,
      lastError: null,
      lastDecisionAt: null,
      decisionCycles: 0,
      lastEvent: null,
      lastObservedAt: null,
      blockers: []
    }
    this.admin = {
      enabled: false,
      rcon: false,
      updatedAt: null,
      lastError: null,
      tps: { one: null, five: null, fifteen: null },
      online: { count: null, max: null, players: [] },
      whitelist: { count: null, names: [] },
      time: { ticks: null, label: null },
      backup: { status: 'unknown' }
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

  setAdmin (admin: AdminSnapshot): void {
    this.admin = {
      ...admin,
      tps: { ...admin.tps },
      online: { ...admin.online, players: [...admin.online.players] },
      whitelist: { ...admin.whitelist, names: [...admin.whitelist.names] },
      time: { ...admin.time }
    }
  }

  setAutonomy (patch: Partial<AutonomySnapshot>): void {
    this.autonomy = { ...this.autonomy, ...patch }
  }

  setTask (patch: Partial<TaskSnapshot>): void {
    this.task = {
      ...this.task,
      ...patch,
      progress: patch.progress ? { ...patch.progress } : this.task.progress,
      pendingResume: patch.pendingResume === undefined
        ? this.task.pendingResume
        : (patch.pendingResume ? { ...patch.pendingResume, progress: { ...patch.pendingResume.progress } } : null),
      queue: patch.queue ? patch.queue.map(item => ({ ...item })) : this.task.queue
    }
  }

  snapshot (): StatusSnapshot {
    const now = Date.now()
    const task: TaskSnapshot = {
      ...this.task,
      progress: { ...this.task.progress },
      pendingResume: this.task.pendingResume
        ? { ...this.task.pendingResume, progress: { ...this.task.pendingResume.progress } }
        : null,
      queue: this.task.queue.map(item => ({ ...item }))
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
      task,
      autonomy: { ...this.autonomy },
      admin: {
        ...this.admin,
        tps: { ...this.admin.tps },
        online: { ...this.admin.online, players: [...this.admin.online.players] },
        whitelist: { ...this.admin.whitelist, names: [...this.admin.whitelist.names] },
        time: { ...this.admin.time }
      }
    }
  }
}
