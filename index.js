// Host half of dsh-ssh-workspace.
//
// A remote workspace is a local sentinel directory whose `.dsh-ssh.json`
// records { alias, remotePath }. Sessions opened in that directory get:
//   • ssh_* tools that act on the remote host through the system ssh client;
//   • the native file/bash tools hidden (they would only see the empty
//     sentinel directory);
//   • a system-prompt section naming the real remote root and project files.

import { bindingForCwd } from './lib/binding.js'
import { registerHttpTransports } from './lib/http.js'
import { createRoutes } from './lib/routes.js'
import { remoteInstructions } from './lib/ssh.js'
import { buildTools } from './lib/tools.js'

export const name = 'dsh-ssh-workspace'
export const inject = ['tools', 'systemPrompt']

// Native tools that operate on the LOCAL filesystem / shell. In a remote
// session they would silently read and write the empty sentinel directory, so
// they are denied and replaced by the ssh_* equivalents.
const LOCAL_ONLY_TOOLS = ['read', 'write', 'edit', 'apply_patch', 'read_image', 'bash', 'glob', 'grep']

function instructionBlock(binding) {
  const entry = remoteInstructions(binding.alias, binding.remotePath)
  if (!entry || !entry.files || entry.files.length === 0) return ''
  const parts = []
  for (const file of entry.files) {
    const text = file.text.length > 12000 ? `${file.text.slice(0, 12000)}\n... (truncated) ...` : file.text
    parts.push(`### ${file.name} (remote)\n\n${text}`)
  }
  return `\n\nProject instructions from the remote workspace root:\n\n${parts.join('\n\n')}`
}

function promptText(promptContext) {
  const cwd = promptContext?.agent?.session?.header?.cwd
  const binding = bindingForCwd(cwd)
  if (!binding) return ''
  const host = binding.user ? `${binding.user}@${binding.hostname || binding.alias}` : (binding.hostname || binding.alias)
  return [
    '## SSH remote workspace',
    `Current remote workspace: ${host}:${binding.remotePath} (ssh alias \`${binding.alias}\`).`,
    `The session cwd ${binding.localPath} is a LOCAL placeholder directory and contains no project files: the real project root is the remote path above. Relative paths are resolved against the remote root by the ssh_* tools.`,
    'Use ssh_read / ssh_write / ssh_edit / ssh_ls / ssh_glob / ssh_grep / ssh_bash for all file and command work. The built-in read / write / edit / bash / glob / grep tools are disabled in this session and would only act on the local placeholder.',
    'ssh_bash runs bash on the remote host with the remote workspace root as cwd; it is not sandboxed beyond the SSH account permissions. Do not claim a file is saved until the ssh_* call returned successfully.',
  ].join('\n') + instructionBlock(binding)
}

export function apply(ctx) {
  const tools = buildTools()
  const sshToolNames = tools.map((tool) => tool.name)
  for (const tool of tools) ctx.tools.register(tool)

  ctx.systemPrompt.section({
    name: 'dsh-ssh-workspace',
    order: 88,
    text: promptText,
  })

  // Per-agent tool visibility. The restriction is scoped to the agent so the
  // same visible set reaches native schemas, the PTC SDK, run_code bindings and
  // dispatch; the assemble waterfall below is the fallback for old hosts.
  const restrictions = new Map()
  const modeOf = (cwd) => (bindingForCwd(cwd) ? 'remote' : 'local')
  const install = (agent) => {
    if (!agent || restrictions.has(agent)) return
    const cwd = agent.session?.header?.cwd
    const agentCtx = agent.ctx
    const agentTools = agentCtx && (typeof agentCtx.get === 'function' ? agentCtx.get('tools') : agentCtx.tools)
    if (!agentTools || typeof agentTools.restrict !== 'function') return
    const mode = modeOf(cwd)
    // The prompt section is synchronous: start fetching the remote project
    // instructions now so they are cached before the first model request.
    if (mode === 'remote') {
      const binding = bindingForCwd(cwd)
      if (binding) remoteInstructions(binding.alias, binding.remotePath)
    }
    const deny = mode === 'remote' ? LOCAL_ONLY_TOOLS : sshToolNames
    // Deny one name at a time: a name this deployment does not register makes
    // the whole restrict() call throw, and losing the restriction is worse than
    // losing one name (the assemble waterfall below is name-based anyway).
    const disposers = []
    for (const name of deny) {
      try {
        const dispose = agentTools.restrict({ deny: [name] })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch {
        // Not registered in this deployment (e.g. apply_patch on an older core).
      }
    }
    if (disposers.length > 0) {
      restrictions.set(agent, { dispose: () => { for (const dispose of disposers) dispose() }, mode })
    }
  }
  const release = (agent) => {
    const entry = restrictions.get(agent)
    if (!entry) return
    restrictions.delete(agent)
    try {
      entry.dispose()
    } catch {
      // Already disposed with the agent's scope.
    }
  }
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents && typeof agents.list === 'function') {
    for (const agent of agents.list()) install(agent)
  }
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => install(agent))
    ctx.on('agent/disposed', ({ agent }) => release(agent))
    ctx.on('system-prompt/assemble', async (_assembly, assembleContext, next) => {
      const assembled = await next()
      const cwd = assembleContext?.agent?.session?.header?.cwd
      if (!cwd) return assembled
      const deny = new Set(modeOf(cwd) === 'remote' ? LOCAL_ONLY_TOOLS : sshToolNames)
      const visible = (assembled.tools || []).filter((tool) => !tool?.name || !deny.has(tool.name))
      return { ...assembled, tools: visible }
    })
  }
  ctx.effect(() => () => { for (const agent of [...restrictions.keys()]) release(agent) }, 'dsh-ssh-workspace.tool-visibility')

  registerHttpTransports(ctx, createRoutes())
}
