import type { TaskContext } from '../tasks/types.ts'

export type DefenseOutcome = 'none' | 'cleared' | 'retreat'

export interface TaskDefender {
  hasThreat: () => boolean
  prepare: (ctx: TaskContext) => Promise<void>
  defend: (ctx: TaskContext) => Promise<DefenseOutcome>
}
