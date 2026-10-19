#!/usr/bin/env node
// 包装器：保持 `node scripts/backup.mjs` 的稳定入口，实际逻辑在服务端 TypeScript 中。
// 两阶段协议：--prepare [--full] / --pending / --ack <name> --sha256 <hex> / --snapshot-db。
// 无参数运行等价于 v0.1 的“生成并立即确认”，仅用于兼容旧脚本与测试。
import '../server/src/cli/backup.ts'
