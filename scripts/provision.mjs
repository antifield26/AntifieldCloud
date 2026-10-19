#!/usr/bin/env node
// 包装器：保持 `node scripts/provision.mjs` 的稳定入口，实际逻辑在服务端 TypeScript 中。
import '../server/src/cli/provision.ts'
