// Bot 出站网络卡片：展示外网与 QQ 平台 API 连通性，并提供手动复检。
// Pi 直连 QQ 平台，不再依赖 PC 代理隧道；不读取或渲染任何 Bot 凭据。

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Wifi } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BotConnectivityProbe, BotConnectivitySnapshot, BotPlatform } from '../../api/types'
import { usePolling } from '../../hooks/usePolling'
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

const PLATFORM_ORDER: readonly BotPlatform[] = ['qq']

/** 出站网络状态卡片；每 60 秒自动读取服务端探测快照，不在浏览器发起外部探测。 */
export function BotConnectivityCard() {
  const [data, setData] = useState<BotConnectivitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const requestSeqRef = useRef(0)

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const seq = requestSeqRef.current + 1
    requestSeqRef.current = seq
    try {
      const snapshot = await api.bots.connectivity(signal)
      if (seq !== requestSeqRef.current) return
      setData(snapshot)
      setError(null)
    } catch (loadError) {
      if (signal?.aborted || seq !== requestSeqRef.current) return
      setError(toErrorMessage(loadError))
    } finally {
      if (!signal?.aborted && seq === requestSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  // 与其它轮询一致：页面隐藏时暂停，重新可见时补一次，避免后台空跑。
  usePolling(() => load(), 60_000)

  const handleCheck = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setError(null)
    const seq = requestSeqRef.current + 1
    requestSeqRef.current = seq
    try {
      const next = await api.bots.checkConnectivity()
      if (seq === requestSeqRef.current) setData(next)
    } catch (checkError) {
      if (seq === requestSeqRef.current) setError(toErrorMessage(checkError))
    } finally {
      if (seq === requestSeqRef.current) setChecking(false)
    }
  }

  const platforms = PLATFORM_ORDER.filter((platform) => data?.platforms[platform] !== undefined)
  const checkedAt = data?.checkedAt ?? null
  const busy = loading || checking || data?.checking === true
  const online = data?.internet.reachable === true

  return (
    <Card
      title="出站网络"
      description="Pi 直连 QQ 平台 API（不依赖 PC 代理隧道）；这里展示外网与 QQ 平台的最近一次探测结果。"
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
              <span className="bot-status-label">出站网络</span>
              <span className="bot-connectivity-value">{online ? '在线' : '离线'}</span>
              <Badge tone={online ? 'success' : 'warning'} dot>
                {online ? '可直连' : '需检查网络'}
              </Badge>
            </div>
            <div className="bot-connectivity-item">
              <span className="bot-status-label">外网</span>
              <span className="bot-connectivity-value">{data.internet.reachable ? '可达' : '不可达'}</span>
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
            <p className="field-hint">暂无启用的 QQ Bot；启用 Bot 后会自动探测 QQ 平台。</p>
          )}
        </>
      ) : (
        <p className="field-hint">
          <Wifi size={14} aria-hidden="true" /> 暂未读取到连通性状态。
        </p>
      )}
    </Card>
  )
}
