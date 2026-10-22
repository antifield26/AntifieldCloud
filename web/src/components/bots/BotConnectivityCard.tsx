// Bot 出站网络卡片：展示代理端口、外网与平台 API 连通性，并提供手动复检。
// 安全边界：只展示服务端返回的主机/端口/状态，不读取或渲染任何 Bot 凭据。

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert, Wifi } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BotConnectivityProbe, BotConnectivitySnapshot, BotPlatform } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { RelativeTime } from '../RelativeTime'
import { botPlatformLabel } from '../../lib/bots'

function probeTone(probe: BotConnectivityProbe | undefined): 'success' | 'warning' {
  return probe?.reachable ? 'success' : 'warning'
}

function probeLabel(probe: BotConnectivityProbe | undefined): string {
  if (!probe) return '未检测'
  if (probe.reachable) {
    return probe.latencyMs === null ? '可达' : `可达 ${probe.latencyMs}ms`
  }
  return probe.error === 'timeout' ? '超时' : '不可达'
}

const PLATFORM_ORDER: readonly BotPlatform[] = ['discord', 'telegram', 'slack', 'qq']

/** 出站网络状态卡片；每 60 秒自动读取服务端探测快照，不在浏览器发起外部探测。 */
export function BotConnectivityCard() {
  const [data, setData] = useState<BotConnectivitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const snapshot = await api.bots.connectivity(signal)
      setData(snapshot)
      setError(null)
    } catch (loadError) {
      if (signal?.aborted) return
      setError(toErrorMessage(loadError))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load])

  const handleCheck = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setError(null)
    try {
      setData(await api.bots.checkConnectivity())
    } catch (checkError) {
      setError(toErrorMessage(checkError))
    } finally {
      setChecking(false)
    }
  }

  const proxyText = data?.proxy.configured
    ? `${data.proxy.host}:${data.proxy.port}`
    : '未配置代理'
  const platforms = PLATFORM_ORDER.filter((platform) => data?.platforms[platform] !== undefined)
  const checkedAt = data?.checkedAt ?? null
  const busy = loading || checking || data?.checking === true

  return (
    <Card
      title="出站网络"
      description="Bot 依赖本机代理访问平台 API；这里展示代理端口、外网与各平台的最近一次探测结果。"
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={14} aria-hidden="true" />}
          loading={busy}
          onClick={() => void handleCheck()}
        >
          检测
        </Button>
      }
    >
      {error ? (
        <div className="notice notice-danger" role="alert">
          连通性检测失败：{error}
        </div>
      ) : null}

      {!data && loading ? (
        <p className="field-hint">正在读取连通性状态…</p>
      ) : data ? (
        <>
          <div className="bot-connectivity-grid">
            <div className="bot-connectivity-item">
              <span className="bot-status-label">设备在线</span>
              <span className="bot-connectivity-value">{data.deviceOnline ? '在线' : '离线'}</span>
              <Badge tone={data.deviceOnline ? 'success' : 'warning'} dot>
                {data.deviceOnline ? '可出站' : '需检查代理'}
              </Badge>
            </div>
            <div className="bot-connectivity-item">
              <span className="bot-status-label">代理端口</span>
              <span className="bot-connectivity-value">{proxyText}</span>
              <Badge tone={data.proxy.portReachable ? 'success' : 'warning'} dot>
                {data.proxy.portReachable ? '存活' : '不可达'}
              </Badge>
            </div>
            <div className="bot-connectivity-item">
              <span className="bot-status-label">外网</span>
              <span className="bot-connectivity-value">
                {data.internet.reachable ? '可达' : '不可达'}
              </span>
              <Badge tone={probeTone(data.internet)}>
                {data.internet.latencyMs !== null ? `${data.internet.latencyMs}ms` : '—'}
              </Badge>
            </div>
            <div className="bot-connectivity-item">
              <span className="bot-status-label">最近检测</span>
              <span className="bot-connectivity-value">
                {checkedAt ? <RelativeTime ts={checkedAt} /> : '尚未检测'}
              </span>
              {data.checking ? <Badge tone="muted">检测中</Badge> : null}
            </div>
          </div>

          {platforms.length > 0 ? (
            <div className="bot-connectivity-platforms">
              {platforms.map((platform) => {
                const probe = data.platforms[platform]
                return (
                  <div className="bot-connectivity-platform" key={platform}>
                    <span>{botPlatformLabel(platform)}</span>
                    <Badge tone={probeTone(probe)} dot>
                      {probeLabel(probe)}
                    </Badge>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="field-hint">暂无启用的 Bot 平台；启用 Bot 后会自动探测对应平台。</p>
          )}

          {!data.proxy.configured ? (
            <div className="notice notice-warning" role="status">
              <ShieldAlert size={16} aria-hidden="true" /> 未配置 `BOT_PROXY_URL`/`HTTPS_PROXY`；若平台的
              出站网络需要代理，请先修复代理。
            </div>
          ) : null}
        </>
      ) : (
        <p className="field-hint">
          <Wifi size={14} aria-hidden="true" /> 暂未读取到连通性状态。
        </p>
      )}
    </Card>
  )
}
