import assert from 'node:assert/strict'
import test from 'node:test'
import type { OpenCodeClient } from '../../src/ai/opencode.ts'
import { IntentClassifier } from '../../src/ai/intent.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig } from '../helpers.ts'

const logger = createLogger('error')

function classifierWith (text: () => string): IntentClassifier {
  const config = makeConfig({ aiEnabled: true, aiIntentEnabled: true, aiIntentMinConfidence: 0.7 })
  const client = {
    generate: async () => ({ text: text(), latencyMs: 1 })
  } as unknown as OpenCodeClient
  return new IntentClassifier(config, logger, client)
}

test('intent classifier accepts a valid high-confidence task intent', async () => {
  const classifier = classifierWith(() => '{"intent":"fish","confidence":0.92}')
  assert.deepEqual(await classifier.classify('帮我弄点鱼'), { action: 'fish', confidence: 0.92 })
})

test('intent classifier ignores non-task chat without calling the model', async () => {
  const classifier = classifierWith(() => {
    throw new Error('should not be called')
  })
  assert.equal(classifier.shouldClassify('今天天气不错'), false)
  assert.equal(await classifier.classify('今天天气不错'), null)
})

test('intent classifier rejects low confidence and invalid JSON', async () => {
  const low = classifierWith(() => '{"intent":"farm","confidence":0.2}')
  assert.equal(await low.classify('去田里'), null)
  const invalid = classifierWith(() => 'not json')
  assert.equal(await invalid.classify('去钓鱼'), null)
  const badIntent = classifierWith(() => '{"intent":"explode","confidence":1}')
  assert.equal(await badIntent.classify('去钓鱼'), null)
})
