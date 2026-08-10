import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { AgentConfigError, loadConfig, resolveRole } from '../agent-config.mjs'

const CONTRACT = resolve('../../devpolicy/contracts/agent/examples')
const VALID = join(CONTRACT, 'valid', 'agdevworld', 'agents.toml')

async function errorCode(fn) {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof AgentConfigError)
    return error.code
  }
  assert.fail('expected AgentConfigError')
}

test('valid agdevworld fixture resolves front', async () => {
  const { config, overlay } = await loadConfig(VALID)
  const agent = await resolveRole(config, overlay, 'front', { checkAvailable: false })
  assert.deepEqual(
    { profile: agent.profile, harness: agent.harness, model: agent.model },
    { profile: 'local-front', harness: 'opencode', model: 'ollama/qwen3.6:35b-a3b-coding-nvfp4' },
  )
})

for (const [file, expected] of [
  ['missing-schema.toml', 'E_SCHEMA'],
  ['unknown-harness.toml', 'E_UNKNOWN_HARNESS'],
  ['bad-model-id.toml', 'E_BAD_MODEL_ID'],
  ['unknown-model.toml', 'E_UNKNOWN_MODEL'],
  ['incompatible-model.toml', 'E_INCOMPATIBLE'],
  ['unknown-profile.toml', 'E_UNKNOWN_PROFILE'],
  ['capability-unmet.toml', 'E_CAPABILITY_UNMET'],
]) {
  test(`contract rejection ${file}`, async () => {
    assert.equal(await errorCode(async () => {
      const { config, overlay } = await loadConfig(join(CONTRACT, 'invalid', file))
      await resolveRole(config, overlay, Object.keys(config.roles)[0], { checkAvailable: false })
    }), expected)
  })
}

for (const [file, expected] of [
  ['overlay-out-of-scope.toml', 'E_OVERLAY_SCOPE'],
  ['overlay-secret-value.toml', 'E_SECRET_VALUE'],
]) {
  test(`overlay rejection ${file}`, async () => {
    assert.equal(await errorCode(() => loadConfig(VALID, join(CONTRACT, 'invalid', file))), expected)
  })
}

test('overlay selects profile and resolves executable without fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-config-'))
  const command = join(dir, 'opencode')
  const overlay = join(dir, 'agents.local.toml')
  await writeFile(command, '#!/bin/sh\n')
  await chmod(command, 0o755)
  await writeFile(overlay, `schema = "ag.agent-config.v1"\n[local.harness.opencode]\ncommand = "${command}"\n[local.provider.ollama]\nbase_url = "http://ollama.example/v1"\n`)
  const loaded = await loadConfig(VALID, overlay)
  const agent = await resolveRole(loaded.config, loaded.overlay, 'front')
  assert.equal(agent.command, command)
  assert.equal(agent.providerBaseUrl, 'http://ollama.example/v1')
})

test('unmatched command glob fails without falling back to PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-glob-'))
  const overlay = join(dir, 'agents.local.toml')
  await writeFile(overlay, `schema = "ag.agent-config.v1"\n[local.harness.opencode]\ncommand_glob = "${dir}/absent-*"\n[local.provider.ollama]\nbase_url = "http://ollama.example/v1"\n`)
  assert.equal(await errorCode(async () => {
    const loaded = await loadConfig(VALID, overlay)
    await resolveRole(loaded.config, loaded.overlay, 'front')
  }), 'E_UNAVAILABLE')
})
