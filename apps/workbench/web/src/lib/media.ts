// 媒体预览的错误映射与格式提示（纯函数，便于测试）。
// 浏览器原生 <video>/<audio> 负责 Range 与解码，本模块只做用户可读的失败说明。

import type { PreviewKind } from '../api/types'

export type MediaKind = 'audio' | 'video'

export interface MediaErrorInfo {
  title: string
  description: string
}

export function mediaKindOf(previewKind: PreviewKind | null | undefined): MediaKind | null {
  if (previewKind === 'video') return 'video'
  if (previewKind === 'audio') return 'audio'
  return null
}

/** MediaError.code: 1=aborted 2=network 3=decode 4=src-not-supported */
export function mediaErrorMessage(
  mediaErrorCode: number | null | undefined,
  httpStatus?: number | null,
): MediaErrorInfo {
  if (httpStatus === 415) {
    return {
      title: '浏览器不支持该媒体格式',
      description: '服务端已确认该类型不可内联播放，请下载后用本地播放器打开。',
    }
  }
  if (httpStatus === 416) {
    return {
      title: '无法定位播放位置',
      description: '媒体 Range 请求失败，请刷新后重试，或下载后播放。',
    }
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      title: '没有播放权限',
      description: '会话可能已过期，请重新登录后再试。',
    }
  }
  switch (mediaErrorCode) {
    case 1:
      return { title: '播放已中止', description: '播放过程被中断，可重试或下载文件。' }
    case 2:
      return {
        title: '媒体加载失败',
        description: '网络中断或文件内容不可读取，请检查网络后重试，或下载文件。',
      }
    case 3:
      return {
        title: '媒体解码失败',
        description: '文件编码或容器不被浏览器支持，请下载后用本地播放器打开。',
      }
    case 4:
      return {
        title: '浏览器不支持该媒体格式',
        description: '当前浏览器无法解码该文件，请下载后用本地播放器打开。',
      }
    default:
      return {
        title: '无法播放该媒体',
        description: '可能是网络、格式或文件损坏导致，请重试或下载文件。',
      }
  }
}

/** 常见格式提示；不承诺支持所有编码。 */
export function mediaMimeHint(mime: string | null | undefined): string {
  if (!mime) return '浏览器原生播放，支持情况取决于容器与编码。'
  if (mime.startsWith('video/')) {
    return '常见可播放：MP4(H.264/AAC)、WebM；其他容器请下载后播放。'
  }
  if (mime.startsWith('audio/')) {
    return '常见可播放：MP3、M4A(AAC)、OGG、WAV；其他格式请下载后播放。'
  }
  return '浏览器原生播放，支持情况取决于容器与编码。'
}

/** 服务端未下发 inlineAllowed 时，媒体默认允许内联（由服务端 content 响应兜底）。 */
export function mediaInlineAllowed(inlineAllowed: boolean | undefined): boolean {
  return inlineAllowed !== false
}
