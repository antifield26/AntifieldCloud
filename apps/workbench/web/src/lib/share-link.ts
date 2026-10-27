// 分享链接展示/关闭保护的纯函数：一次性 URL 关闭前确认，URL 只允许 http(s)。

export function absoluteShareUrl(raw: string, appOrigin: string): string {
  if (/^https?:\/\//i.test(raw)) return raw
  if (!appOrigin) return raw
  return `${appOrigin.replace(/\/$/, '')}${raw.startsWith('/') ? raw : `/${raw}`}`
}

/** 已创建一次性链接且尚未复制/打开时，关闭需要二次确认。 */
export function shouldProtectShareLinkClose(hasCreatedLink: boolean, linkSaved: boolean): boolean {
  return hasCreatedLink && !linkSaved
}
