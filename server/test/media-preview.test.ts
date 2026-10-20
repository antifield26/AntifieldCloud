/** 音视频预览类型与 inline 白名单：只允许浏览器原生可控容器，禁止转码/扩展名绕过。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canInline, detectMime, previewKindFor } from '../src/files/mime.ts'

test('音视频 MIME 与预览类型', () => {
  assert.equal(detectMime('clip.mp4'), 'video/mp4')
  assert.equal(detectMime('clip.webm'), 'video/webm')
  assert.equal(detectMime('song.mp3'), 'audio/mpeg')
  assert.equal(detectMime('song.ogg'), 'audio/ogg')
  assert.equal(detectMime('song.flac'), 'audio/flac')
  assert.equal(detectMime('song.wav'), 'audio/wav')

  assert.equal(previewKindFor('clip.mp4', 'video/mp4'), 'video')
  assert.equal(previewKindFor('clip.webm', 'video/webm'), 'video')
  assert.equal(previewKindFor('song.mp3', 'audio/mpeg'), 'audio')
  assert.equal(previewKindFor('song.ogg', 'audio/ogg'), 'audio')
  assert.equal(canInline('video'), true)
  assert.equal(canInline('audio'), true)
})

test('未列入白名单的容器不内联', () => {
  assert.equal(previewKindFor('movie.mkv', 'video/x-matroska'), 'none')
  assert.equal(previewKindFor('movie.avi', 'video/x-msvideo'), 'none')
  assert.equal(previewKindFor('evil.svg', 'image/svg+xml'), 'none')
  assert.equal(canInline('none'), false)
})
