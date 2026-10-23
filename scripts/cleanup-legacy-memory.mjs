// 旧滚动摘要清理入口：node scripts/cleanup-legacy-memory.mjs [--confirm]
// 默认 dry-run；--confirm 才删除已迁移用户的旧摘要行与镜像文件。
import '../server/src/cli/cleanup-legacy-memory.ts'
