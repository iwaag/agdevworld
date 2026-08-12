import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FREEFORGE_CHANNEL,
  RESOLVED_TOPIC_PREFIX,
  openForgeRequest,
  parseEnv,
  requestTopicName,
} from '../zulip.mjs'

test('parseEnv reads KEY=value lines, quotes and comments included', () => {
  const env = parseEnv('# comment\nZULIP_URL=https://z.example\nZULIP_API_KEY="quoted"\nnot a pair\n')
  assert.equal(env.ZULIP_URL, 'https://z.example')
  assert.equal(env.ZULIP_API_KEY, 'quoted')
  assert.equal(Object.keys(env).length, 2)
})

test('request topic names are create-<stamp>-<id>', () => {
  const name = requestTopicName(new Date(2026, 7, 12, 9, 5, 3), 'abc123')
  assert.equal(name, 'create-20260812-090503-abc123')
})

test('openForgeRequest posts the desire as one fresh FreeForge topic', async () => {
  const calls = []
  const sender = {
    sendToChannel: async (channel, topic, content) => {
      calls.push([channel, topic, content])
      return 42
    },
  }
  const opened = await openForgeRequest(sender, 'a red bird')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], FREEFORGE_CHANNEL)
  assert.match(opened.topic, /^create-\d{8}-\d{6}-[0-9a-f]+$/)
  assert.deepEqual(calls[0].slice(1), [opened.topic, 'a red bird'])
  assert.deepEqual(opened, { channel: FREEFORGE_CHANNEL, topic: opened.topic, message_id: 42 })
})

test('the resolved-topic prefix matches Zulip’s marker', () => {
  assert.equal(RESOLVED_TOPIC_PREFIX, '✔ ')
})
