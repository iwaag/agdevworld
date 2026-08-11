function tomlString(value) {
  return JSON.stringify(String(value))
}

export function renderOverlay(env = process.env) {
  const opencode = env.AGENT_HARNESS_OPENCODE_COMMAND || '/usr/local/bin/opencode'
  const claude = env.AGENT_HARNESS_CLAUDE_CODE_COMMAND || '/usr/local/bin/claude'
  const ollama = env.AGENT_PROVIDER_OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1'
  const secretEnv = env.AGENT_ANTHROPIC_API_KEY_ENV || 'ANTHROPIC_API_KEY'
  const profile = env.AGENT_FRONT_PROFILE || ''
  const lines = [
    'schema = "ag.agent-config.v1"',
    '',
    '[local.harness.opencode]',
    `command = ${tomlString(opencode)}`,
    '',
    '[local.harness.claude_code]',
    `command = ${tomlString(claude)}`,
    '',
    '[local.provider.ollama]',
    `base_url = ${tomlString(ollama)}`,
    '',
    '[local.secrets]',
    `anthropic_api_key_env = ${tomlString(secretEnv)}`,
  ]
  if (profile) lines.push('', '[roles.front]', `profile = ${tomlString(profile)}`)
  return `${lines.join('\n')}\n`
}
