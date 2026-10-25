import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
    // 覆盖率门禁：只统计业务源码，排除测试、入口与纯类型文件；阈值按当前基线收紧。
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/api/types.ts'],
      thresholds: {
        // v0.7.0 基线：Lines 52.33% / Branches 47.63% / Functions 45.05%（本轮从 35/33/30 提高，
        // 后续按模块补测继续上调；门禁略低于当前实测值，避免环境差异导致误报）。
        lines: 50,
        functions: 42,
        branches: 45,
      },
    },
  },
})
