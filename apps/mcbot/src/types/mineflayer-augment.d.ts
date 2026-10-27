import 'mineflayer'
import type { Pathfinder } from 'mineflayer-pathfinder'

declare module 'mineflayer' {
  interface Bot {
    pathfinder: Pathfinder
  }
}
