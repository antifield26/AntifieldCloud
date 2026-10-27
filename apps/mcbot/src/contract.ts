/**
 * mcbot（游戏内人格名 Lofii）对外只读契约版本。
 * AntifieldComplexx 等消费者通过 `/healthz` 与 `/events/recent` 的 `contractVersion`
 * 判断字段兼容性：新增可选字段不升版本，破坏性变更才递增。
 */
export const CONTRACT_VERSION = 1
