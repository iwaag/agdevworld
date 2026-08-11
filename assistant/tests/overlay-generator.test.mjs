import assert from 'node:assert/strict'
import test from 'node:test'

import { parseToml } from '../agent-config.mjs'
import { renderOverlay } from '../overlay-generator.mjs'

test('generated compose overlay contains only deployment facts and secret references', () => {
  const rendered = renderOverlay({
    AGENT_HARNESS_OPENCODE_COMMAND: '/opt/bin/opencode',
    AGENT_HARNESS_CLAUDE_CODE_COMMAND: '/opt/bin/claude',
    AGENT_PROVIDER_OLLAMA_BASE_URL: 'http://models.example:11434/v1',
    AGENT_ANTHROPIC_API_KEY_ENV: 'DEPLOYED_ANTHROPIC_KEY',
    AGENT_FRONT_PROFILE: 'sonnet-front',
  })
  assert.deepEqual(parseToml(rendered), {
    schema: 'ag.agent-config.v1',
    local: {
      harness: {
        opencode: { command: '/opt/bin/opencode' },
        claude_code: { command: '/opt/bin/claude' },
      },
      provider: { ollama: { base_url: 'http://models.example:11434/v1' } },
      secrets: { anthropic_api_key_env: 'DEPLOYED_ANTHROPIC_KEY' },
    },
    roles: { front: { profile: 'sonnet-front' } },
  })
  assert.equal(rendered.includes('DEPLOYED_ANTHROPIC_KEY ='), false)
})

test('generated compose overlay has clean-checkout defaults', () => {
  const parsed = parseToml(renderOverlay({}))
  assert.equal(parsed.local.provider.ollama.base_url, 'http://host.docker.internal:11434/v1')
  assert.equal(parsed.local.harness.claude_code.command, '/usr/local/bin/claude')
  assert.equal(parsed.roles, undefined)
})
