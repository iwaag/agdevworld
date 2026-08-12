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

test('mission topics open in the project channel with the mission- prefix', async () => {
  const { openMissionTopic, projectChannelName } = await import('../zulip.mjs')
  const calls = []
  const sender = {
    sendToChannel: async (channel, topic, content) => {
      calls.push([channel, topic, content])
      return 77
    },
  }
  const opened = await openMissionTopic(sender, 'whack-a-mole-2', 'the briefing')
  assert.equal(projectChannelName('whack-a-mole-2'), 'pj-whack-a-mole-2')
  assert.equal(calls[0][0], 'pj-whack-a-mole-2')
  assert.match(opened.topic, /^mission-\d{8}-\d{6}-[0-9a-f]+$/)
  assert.deepEqual(opened, { channel: 'pj-whack-a-mole-2', topic: opened.topic, message_id: 77 })
})
