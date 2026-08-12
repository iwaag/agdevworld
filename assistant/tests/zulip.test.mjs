import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FREEFORGE_CHANNEL,
  RESOLVED_TOPIC_PREFIX,
  openForgeRequest,
  parseEnv,
  requestChannelName,
} from '../zulip.mjs'

test('parseEnv reads KEY=value lines, quotes and comments included', () => {
  const env = parseEnv('# comment\nZULIP_URL=https://z.example\nZULIP_API_KEY="quoted"\nnot a pair\n')
  assert.equal(env.ZULIP_URL, 'https://z.example')
  assert.equal(env.ZULIP_API_KEY, 'quoted')
  assert.equal(Object.keys(env).length, 2)
})

test('request channel names are create-<stamp>-<id>', () => {
  const name = requestChannelName(new Date(2026, 7, 12, 9, 5, 3), 'abc123')
  assert.equal(name, 'create-20260812-090503-abc123')
})

test('openForgeRequest opens, announces, posts, in that order', async () => {
  const calls = []
  const sender = {
    selfId: async () => 10,
    createChannel: async (name, description, principals) => {
      calls.push(['create', name, principals])
    },
    sendToChannel: async (channel, topic, content) => {
      calls.push(['send', channel, topic, content])
      return channel === FREEFORGE_CHANNEL ? 1 : 42
    },
  }
  const opened = await openForgeRequest(sender, 'a red bird')
  assert.match(opened.channel, /^create-\d{8}-\d{6}-[0-9a-f]+$/)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['create', 'send', 'send'],
  )
  assert.deepEqual(calls[0][2], [13, 8, 10])
  assert.equal(calls[1][1], FREEFORGE_CHANNEL)
  assert.ok(calls[1][3].includes(`#**${opened.channel}**`))
  assert.deepEqual(calls[2].slice(1), [opened.channel, 'request', 'a red bird'])
  assert.equal(opened.message_id, 42)
})

test('the resolved-topic prefix matches Zulip’s marker', () => {
  assert.equal(RESOLVED_TOPIC_PREFIX, '✔ ')
})
