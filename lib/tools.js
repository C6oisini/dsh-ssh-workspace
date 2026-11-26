// Agent tools for a bound SSH workspace. Every tool resolves its host from the
// SESSION cwd (the sentinel directory), never from a global "active machine":
// two sessions on two hosts must not leak into each other.

import { bindingForCwd } from './binding.js'
import { unifiedDiff } from './diff.js'
import {
  globRemote, grepRemote, listRemoteDir, readRemoteFile,
  resolveRemotePath, runRemoteCommand, statRemotePath, writeRemoteFile,
} from './ssh.js'

// Local equivalent of `defineTool` from @deepseek-ai/dsh-tools. A linked
// bundle lives outside the profile and cannot resolve @deepseek-ai/* bare
// specifiers, so the parameter DSL is compiled here: ctx.tools.register sends
// `parameters` straight to the model API, which requires JSON Schema with the
// requiredness on the OBJECT (required: ['path']), not on each property.
function compileValueSchema(spec) {
  if (!spec || typeof spec !== 'object') return spec
  const out = { ...spec }
  delete out.required
  if (out.type === 'object') {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(out.properties || {})) {
      const { required: isRequired, ...rest } = value
      properties[key] = compileValueSchema(rest)
      if (isRequired) required.push(key)
    }
    out.properties = properties
    if (required.length > 0) out.required = required
    if (typeof out.additionalProperties !== 'boolean') out.additionalProperties = true
  } else if (out.type === 'array' && out.items) {
    out.items = compileValueSchema(out.items)
  } else if (out.type === 'json') {
    delete out.type
  } else if (Array.isArray(out.oneOf)) {
    out.oneOf = out.oneOf.map(compileValueSchema)
  }
  return out
}

function compileParameters(parameters) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(parameters || {})) {
    const { required: isRequired, ...rest } = value
    properties[key] = compileValueSchema(rest)
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

const defineTool = (tool) => ({ ...tool, parameters: compileParameters(tool.parameters) })


function requireBinding(exec, tool) {
  const cwd = exec?.agent?.session?.header?.cwd
  const binding = bindingForCwd(cwd)
  if (!binding) {
    throw new Error(
      `${tool}: this session is not an SSH remote workspace. `
      + 'Open a remote workspace from the "SSH 远程工作区" panel first; its sessions use a sentinel cwd that carries the host binding.',
    )
  }
  return binding
}

const textOut = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const diffOut = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      diff: { type: 'string' },
      added: { type: 'integer' },
      removed: { type: 'integer' },
    },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => ({
    kind: 'ssh-workspace.diff',
    version: 1,
    diff: value.diff || '',
    added: value.added || 0,
    removed: value.removed || 0,
  }),
}

const execOut = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      execution: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host: { type: 'string' },
          cwd: { type: 'string' },
          code: { type: 'integer' },
          durationMs: { type: 'integer' },
          timedOut: { type: 'boolean' },
        },
        required: ['host', 'cwd', 'code', 'durationMs'],
      },
    },
    required: ['text', 'execution'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.execution,
}

// Every tool result is fed to the model, so cap what leaves the Host. Shell
// output can reach 8MB per stream; sending that verbatim either overflows the
// context or costs a fortune. The notice tells the model how to narrow down.
const MODEL_OUTPUT_MAX = 60_000

function capForModel(text, max = MODEL_OUTPUT_MAX) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const omitted = value.length - max
  return `${value.slice(0, max)}\n... output truncated: ${omitted} chars omitted (narrow the command or page with offset/limit) ...`
}

function withTrailingNewline(text) {
  return text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text
}

export function buildTools() {
  const tools = []

  tools.push(defineTool({
    name: 'ssh_read',
    description:
      'Read a UTF-8 text file on the SSH host bound to this session. Paths are remote: absolute, or relative to the remote workspace root (the session cwd sentinel is local and never used to read files). Supports offset/limit like a normal line reader. Fails on binary files and on files over 512KB unless a small range is requested.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path (absolute or workspace-relative).' },
      offset: { type: 'integer', description: '1-based first line to return.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return.' },
    },
    output: textOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_read')
      const remotePath = resolveRemotePath(binding.remotePath, args.path)
      const file = await readRemoteFile(binding.alias, remotePath)
      const lines = file.text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const offset = Math.max(1, Number(args.offset) || 1)
      const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = capForModel(slice.map((line, index) => `${offset + index}\t${line}`).join('\n'))
      const notes = []
      if (file.truncated) notes.push(`[file is ${file.size} bytes; showing the first 512KB]`)
      if (offset > 1 || offset - 1 + slice.length < lines.length) {
        notes.push(`[lines ${offset}-${offset - 1 + slice.length} of ${lines.length}]`)
      }
      return { text: withTrailingNewline(notes.length ? `${numbered}\n${notes.join('\n')}` : numbered) }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_write',
    description:
      'Create or overwrite a file on the SSH host bound to this session. The previous content is read first so the result carries a unified diff (no remote git required), and parent directories are created. Paths are remote: absolute or workspace-relative.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path.' },
      content: { type: 'string', required: true, description: 'Full new file content (UTF-8).' },
    },
    output: diffOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_write')
      const remotePath = resolveRemotePath(binding.remotePath, args.path)
      let before = ''
      let beforeTruncated = false
      try {
        const existing = await readRemoteFile(binding.alias, remotePath)
        before = existing.text
        beforeTruncated = Boolean(existing.truncated)
      } catch (error) {
        const message = String((error && error.message) || error)
        if (!/not found/.test(message)) throw error
      }
      await writeRemoteFile(binding.alias, remotePath, args.content)
      const change = beforeTruncated ? null : unifiedDiff(before, args.content, remotePath.replace(/^\/+/, ''))
      const summary = `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${binding.alias}:${remotePath}`
      const notes = beforeTruncated
        ? ['[previous content exceeded the 512KB read cap; diff skipped (the write itself is complete)]']
        : []
      if (!change) {
        return {
          text: capForModel([summary, ...notes, '(content unchanged)'].join('\n')),
          diff: '',
          added: 0,
          removed: 0,
        }
      }
      return {
        text: capForModel([summary, ...notes, change.text].join('\n\n')),
        diff: change.text,
        added: change.added,
        removed: change.removed,
      }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_edit',
    description:
      'Replace one exact string in a file on the SSH host bound to this session. old_string must occur exactly once (include surrounding context to disambiguate). Line endings are preserved (CRLF stays CRLF). Returns a unified diff computed from the real before/after content.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path.' },
      old_string: { type: 'string', required: true, description: 'Exact text to replace (must be unique).' },
      new_string: { type: 'string', required: true, description: 'Replacement text.' },
    },
    output: diffOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_edit')
      const remotePath = resolveRemotePath(binding.remotePath, args.path)
      const file = await readRemoteFile(binding.alias, remotePath)
      if (file.truncated) {
        throw new Error(
          `ssh_edit: ${remotePath} is ${file.size} bytes, above the 512KB read cap; `
          + 'editing a truncated copy would drop the tail. Use ssh_bash with sed/perl for this file.',
        )
      }
      const crlf = file.text.includes('\r\n')
      const normalized = crlf ? file.text.replace(/\r\n/g, '\n') : file.text
      const oldString = crlf ? String(args.old_string).replace(/\r\n/g, '\n') : String(args.old_string)
      const newString = crlf ? String(args.new_string).replace(/\r\n/g, '\n') : String(args.new_string)
      let count = 0
      let index = normalized.indexOf(oldString)
      while (index >= 0) {
        count += 1
        index = normalized.indexOf(oldString, index + oldString.length)
      }
      if (count === 0) throw new Error(`ssh_edit: old_string not found in ${remotePath}`)
      if (count > 1) throw new Error(`ssh_edit: old_string occurs ${count} times in ${remotePath}; add more context`)
      const replaced = normalized.slice(0, normalized.indexOf(oldString))
        + newString
        + normalized.slice(normalized.indexOf(oldString) + oldString.length)
      const content = crlf ? replaced.replace(/\n/g, '\r\n') : replaced
      await writeRemoteFile(binding.alias, remotePath, content)
      const change = unifiedDiff(file.text, content, remotePath.replace(/^\/+/, ''))
      return {
        text: `Edited ${binding.alias}:${remotePath}\n\n${change ? change.text : '(content unchanged)'}`,
        diff: change ? change.text : '',
        added: change ? change.added : 0,
        removed: change ? change.removed : 0,
      }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_ls',
    description:
      'List one directory on the SSH host bound to this session (directories first). Paths are remote: absolute or workspace-relative; "." means the remote workspace root.',
    parameters: {
      path: { type: 'string', description: 'Remote directory (defaults to the workspace root).' },
    },
    output: textOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_ls')
      const remotePath = resolveRemotePath(binding.remotePath, args.path || '.')
      const listing = await listRemoteDir(binding.alias, remotePath)
      if (listing.entries.length === 0) return { text: `${remotePath}: (empty)` }
      const rows = listing.entries.map((entry) => {
        const suffix = entry.type === 'directory' ? '/' : ''
        const size = entry.type === 'file' ? ` ${entry.size}` : ''
        return `${entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-'}${size}\t${entry.name}${suffix}`
      })
      return { text: withTrailingNewline(capForModel(`${listing.path}:\n${rows.join('\n')}`)) }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_stat',
    description: 'Show type, size, mtime, permissions and symlink target for a path on the SSH host bound to this session.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote path.' },
    },
    output: textOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_stat')
      const remotePath = resolveRemotePath(binding.remotePath, args.path)
      const info = await statRemotePath(binding.alias, remotePath)
      if (!info.exists) return { text: `not found: ${remotePath}` }
      return {
        text: [
          `path: ${info.path}`,
          `type: ${info.kind}`,
          `size: ${info.size} bytes`,
          `mtime: ${info.mtime || '(unknown)'}`,
          `mode: ${info.mode || '(unknown)'}`,
          info.detail ? `detail: ${info.detail}` : '',
        ].filter(Boolean).join('\n'),
      }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_glob',
    description:
      'Find files by glob on the SSH host bound to this session. The pattern is expanded by bash from the remote workspace root (e.g. "**/*.py", "src/*.ts"). Returns at most 300 matches.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Bash glob pattern relative to the remote workspace root.' },
    },
    output: textOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_glob')
      const entries = await globRemote(binding.alias, binding.remotePath, String(args.pattern))
      if (entries.length === 0) return { text: `no matches for ${args.pattern} under ${binding.remotePath}` }
      return { text: withTrailingNewline(capForModel(entries.map((entry) => `${entry.path}\t${entry.kind}`).join('\n'))) }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_grep',
    description:
      'Search file contents on the SSH host bound to this session. Uses ripgrep when installed, otherwise grep -rn. Returns path:line:text rows (max 200).',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Extended regular expression.' },
      path: { type: 'string', description: 'Remote directory or file to search (defaults to the workspace root).' },
      glob: { type: 'string', description: 'Optional ripgrep --glob filter, e.g. "*.ts".' },
      limit: { type: 'integer', description: 'Maximum rows (default 200).' },
    },
    output: textOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_grep')
      const rows = await grepRemote(binding.alias, binding.remotePath, {
        pattern: String(args.pattern),
        path: args.path || '.',
        glob: args.glob || '',
        limit: Math.max(1, Math.min(500, Number(args.limit) || 200)),
      })
      if (rows.length === 0) return { text: `no matches for /${args.pattern}/` }
      return { text: withTrailingNewline(capForModel(rows.map((row) => (row.path ? `${row.path}:${row.line}:${row.text}` : row.text)).join('\n'))) }
    },
  }))

  tools.push(defineTool({
    name: 'ssh_bash',
    description:
      'Run a bash command on the SSH host bound to this session, with the remote workspace root as the working directory. Returns stdout, stderr and the real exit code. This is the only shell available in a remote session (the local bash tool is hidden).',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command line.' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000).' },
    },
    output: execOut,
    async execute(args, exec) {
      const binding = requireBinding(exec, 'ssh_bash')
      const timeoutMs = Math.max(1000, Math.min(600000, Number(args.timeout_ms) || 120000))
      const startedAt = Date.now()
      const result = await runRemoteCommand(binding.alias, binding.remotePath, String(args.command), { timeoutMs })
      const durationMs = Date.now() - startedAt
      const parts = [result.stdout]
      if (result.stderr) parts.push(result.stderr)
      if (result.timedOut) parts.push(`[timed out after ${timeoutMs}ms]`)
      const output = capForModel(parts.filter(Boolean).join(result.stderr && result.stdout ? '\n' : ''))
      const marker = `[exit code: ${result.code}]`
      return {
        text: `${output}\n${marker}`.trimStart(),
        execution: {
          host: binding.alias,
          cwd: binding.remotePath,
          code: result.code,
          durationMs,
          timedOut: Boolean(result.timedOut),
        },
      }
    },
  }))

  return tools
}
