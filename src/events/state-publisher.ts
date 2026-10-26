import type { RuntimeState } from '../state.ts'
import type { EventBus } from './bus.ts'

export interface StatePublisherDeps {
  state: RuntimeState
  events: EventBus
  intervalMs?: number
}

export class StatePublisher {
  private readonly deps: StatePublisherDeps
  private timer: NodeJS.Timeout | null = null
  private last = ''

  constructor (deps: StatePublisherDeps) {
    this.deps = deps
  }

  start (): void {
    this.stop()
    this.last = this.snapshotKey()
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs ?? 2000)
    this.timer.unref?.()
  }

  stop (): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick (): void {
    const key = this.snapshotKey()
    if (key === this.last) return
    this.last = key
    const { state, events } = this.deps
    events.emit('presence', {
      state: state.state,
      connected: state.minecraft.connected,
      otherPlayers: state.presence.otherPlayers,
      lastDecision: state.presence.lastDecision,
      taskActive: state.task.active,
      taskName: state.task.name,
      taskState: state.task.state
    })
  }

  private snapshotKey (): string {
    const { state } = this.deps
    return JSON.stringify({
      state: state.state,
      connected: state.minecraft.connected,
      otherPlayers: state.presence.otherPlayers,
      lastDecision: state.presence.lastDecision,
      taskActive: state.task.active,
      taskName: state.task.name,
      taskState: state.task.state
    })
  }
}
