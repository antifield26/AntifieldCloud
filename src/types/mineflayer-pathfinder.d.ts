declare module 'mineflayer-pathfinder' {
  import type { Bot } from 'mineflayer'
  import type { Entity } from 'prismarine-entity'

  export interface Pathfinder {
    thinkTimeout: number
    tickTimeout: number
    searchRadius: number
    setMovements: (movements: Movements) => void
    setGoal: (goal: unknown, dynamic?: boolean) => void
    goto: (goal: unknown) => Promise<void>
    stop: () => void
    isMoving: () => boolean
    isMining: () => boolean
    isBuilding: () => boolean
  }

  export class Movements {
    constructor (bot: Bot, mcData?: unknown)
    canDig: boolean
    digCost: number
    placeCost: number
    liquidCost: number
    entityCost: number
    dontCreateFlow: boolean
    dontMineUnderFallingBlock: boolean
    allowFreeMotion: boolean
    allowParkour: boolean
    allowSprinting: boolean
    allowEntityDetection: boolean
    canOpenDoors: boolean
    maxDropDown: number
    infiniteLiquidDropdownDistance: boolean
    scafoldingBlocks: number[]
    blocksToAvoid: Set<number>
    blocksCantBreak: Set<number>
    exclusionAreasStep: unknown[]
    exclusionAreasBreak: unknown[]
    exclusionAreasPlace: unknown[]
  }

  export const goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown
    GoalFollow: new (entity: Entity, range: number) => unknown
    GoalBlock: new (x: number, y: number, z: number) => unknown
    GoalXZ: new (x: number, z: number) => unknown
    GoalNearXZ: new (x: number, z: number, range: number) => unknown
    [key: string]: unknown
  }

  export function pathfinder (bot: Bot): void

  const defaultExport: {
    pathfinder: (bot: Bot) => void
    Movements: typeof Movements
    goals: typeof goals
  }
  export default defaultExport
}
