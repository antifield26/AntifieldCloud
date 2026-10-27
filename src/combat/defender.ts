import type { Bot } from 'mineflayer'
import type { Vec3 as Vec3Type } from 'vec3'
import type { AuditLogger } from '../audit.ts'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import { insideSafeZone } from '../tasks/navigation.ts'
import { withdrawSupplies } from '../tasks/deposit.ts'
import { eatIfNeeded, equipItem, findItem } from '../tasks/inventory.ts'
import type { TaskContext } from '../tasks/types.ts'
import { sleep } from '../tasks/types.ts'
import type { DefenseOutcome, TaskDefender } from './types.ts'

interface DefensibleEntity {
  id: number
  name?: string
  type: string
  position: Vec3Type
  health?: number
}

const FORBIDDEN_NAMES = new Set(['creeper', 'enderman', 'witch', 'player'])
const ARMOR = [
  { name: 'iron_helmet', slot: 'head' as const },
  { name: 'iron_chestplate', slot: 'torso' as const },
  { name: 'iron_leggings', slot: 'legs' as const },
  { name: 'iron_boots', slot: 'feet' as const }
]

export interface DefenderDeps {
  config: Config
  logger: Logger
  movement: MovementManager
  audit: AuditLogger
  getBot: () => Bot | null
}

export class Defender implements TaskDefender {
  private readonly deps: DefenderDeps
  private readonly logger: Logger

  constructor (deps: DefenderDeps) {
    this.deps = deps
    this.logger = deps.logger
  }

  hasThreat (): boolean {
    return this.threats().length > 0
  }

  async prepare (ctx: TaskContext): Promise<void> {
    const bot = this.deps.getBot()
    if (!bot?.entity) return
    const missing = [
      ...(['iron_sword', 'shield', ...ARMOR.map(item => item.name)]
        .filter(name => !findItem(bot, name))
        .map(name => ({ name, count: 1 })))
    ]
    if (missing.length === 0) {
      await this.equipGear(bot)
      return
    }
    try {
      await withdrawSupplies(ctx, missing)
    } catch (error) {
      this.logger.warn('defense: combat gear withdraw failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    await this.equipGear(bot)
  }

  async defend (ctx: TaskContext): Promise<DefenseOutcome> {
    const bot = this.deps.getBot()
    if (!bot?.entity) return 'retreat'
    const startedAt = Date.now()
    let kills = 0
    while (Date.now() - startedAt < 20_000) {
      const threats = this.threats()
      if (threats.length === 0) {
        if (kills > 0) this.logger.info('defense: threats cleared', { kills })
        return kills > 0 ? 'cleared' : 'none'
      }
      if (this.shouldRetreat(bot, threats)) {
        await this.retreat(ctx, '血量/食物偏低或怪太多')
        return 'retreat'
      }
      const sword = findItem(bot, 'iron_sword')
      if (!sword) {
        await this.retreat(ctx, '没有铁剑')
        return 'retreat'
      }
      await equipItem(bot, sword)
      await this.equipShield(bot)
      const target = threats[0]
      if (!target) return 'cleared'
      if (!insideSafeZone(this.deps.config, target.position.x, target.position.z)) {
        await this.retreat(ctx, '怪在安全区外')
        return 'retreat'
      }
      try {
        await this.deps.movement.goNearPoint(target.position.x, target.position.y, target.position.z, 2, 8000, true)
      } catch (error) {
        this.logger.warn('defense: approach failed', {
          target: target.name,
          error: error instanceof Error ? error.message : String(error)
        })
        await this.retreat(ctx, '走不到怪那里')
        return 'retreat'
      }
      const until = Date.now() + 5000
      while (Date.now() < until) {
        const live = bot.entities[target.id] as DefensibleEntity | undefined
        if (!live || (live.health !== undefined && live.health <= 0)) {
          kills += 1
          ctx.updateProgress({ mobsKilled: ctx.progress.mobsKilled + 1 })
          this.deps.audit.append({
            event: 'combat.kill',
            source: 'combat',
            actor: 'lofii',
            action: target.name ?? 'hostile',
            result: 'completed',
            details: { kills, radius: this.deps.config.defenseRadius }
          })
          break
        }
        if (bot.entity.position.distanceTo(live.position) > this.deps.config.defenseRadius + 1) break
        if (this.shouldRetreat(bot, this.threats())) {
          await this.retreat(ctx, '战斗中血量/食物偏低')
          return 'retreat'
        }
        try {
          await bot.lookAt(live.position.offset(0, 1.2, 0), true)
          const rawEntity = bot.entities[target.id]
          if (rawEntity) bot.attack(rawEntity)
        } catch (error) {
          this.logger.warn('defense: attack failed', {
            target: target.name,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        await sleep(550, ctx.signal)
      }
    }
    this.logger.warn('defense: timeout', { kills })
    await this.retreat(ctx, '战斗时间太长')
    return 'retreat'
  }

  private threats (): DefensibleEntity[] {
    const bot = this.deps.getBot()
    if (!bot?.entity) return []
    const result: DefensibleEntity[] = []
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity) continue
      if (entity.type === 'player') continue
      const name = (entity as { name?: string }).name
      if (!name || FORBIDDEN_NAMES.has(name)) continue
      if (!this.deps.config.defenseTargets.includes(name)) continue
      if (bot.entity.position.distanceTo(entity.position) > this.deps.config.defenseRadius) continue
      if (!insideSafeZone(this.deps.config, entity.position.x, entity.position.z)) continue
      result.push(entity as unknown as DefensibleEntity)
    }
    return result.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  }

  private shouldRetreat (bot: Bot, threats: DefensibleEntity[]): boolean {
    if (bot.health <= this.deps.config.defenseHealthThreshold) return true
    if (bot.food <= this.deps.config.defenseFoodThreshold) return true
    return threats.length > this.deps.config.defenseMaxHostiles
  }

  private async equipGear (bot: Bot): Promise<void> {
    const sword = findItem(bot, 'iron_sword')
    if (sword) {
      try {
        await equipItem(bot, sword)
      } catch {
        // keep fighting with whatever is held
      }
    }
    for (const armor of ARMOR) {
      if (bot.inventory.slots[this.slotFor(armor.slot)]?.name === armor.name) continue
      const item = findItem(bot, armor.name)
      if (!item) continue
      try {
        await bot.equip(item, armor.slot)
      } catch {
        // best-effort armor
      }
    }
    await this.equipShield(bot)
  }

  private async equipShield (bot: Bot): Promise<void> {
    const shield = findItem(bot, 'shield')
    if (!shield) return
    try {
      await bot.equip(shield, 'off-hand')
    } catch {
      // shield is best-effort across protocol/version combinations
    }
  }

  private slotFor (slot: 'head' | 'torso' | 'legs' | 'feet'): number {
    if (slot === 'head') return 5
    if (slot === 'torso') return 6
    if (slot === 'legs') return 7
    return 8
  }

  private async retreat (ctx: TaskContext, reason: string): Promise<void> {
    this.logger.warn('defense: retreat', { reason })
    this.deps.audit.append({
      event: 'combat.retreat',
      source: 'combat',
      actor: 'lofii',
      action: 'retreat',
      result: 'interrupted',
      details: { reason }
    })
    try {
      await eatIfNeeded(ctx)
    } catch {
      // ignore; movement home is the priority
    }
    try {
      await this.deps.movement.home()
    } catch {
      // ignore; task will stop with the retreat reason
    }
    await ctx.say('有怪，我先回家。')
  }
}
