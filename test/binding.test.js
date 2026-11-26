import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-test-'))
process.env.DSH_HOME = home
const binding = await import('../lib/binding.js')

test('create, resolve, list and forget a binding', async () => {
  const created = await binding.createBinding({ alias: '3090', remotePath: '/srv/project' })
  assert.equal(path.dirname(created.localPath), path.join(binding.WORKSPACES_ROOT, '3090'))
  assert.ok(fs.existsSync(path.join(created.localPath, '.dsh-ssh.json')))

  const resolved = binding.bindingForCwd(created.localPath)
  assert.equal(resolved.alias, '3090')
  assert.equal(resolved.remotePath, '/srv/project')

  const nested = path.join(created.localPath, 'src', 'deep')
  fs.mkdirSync(nested, { recursive: true })
  assert.equal(binding.bindingForCwd(nested).alias, '3090')

  assert.equal(binding.bindingForCwd('/tmp'), null)
  assert.equal(binding.bindingForCwd(path.join(home, 'elsewhere')), null)

  const listed = await binding.listBindings()
  assert.equal(listed.length, 1)

  await binding.forgetBinding(created.localPath)
  assert.equal(binding.readBinding(created.localPath), null)
})

test('refuses to forget paths outside the workspace root', async () => {
  await assert.rejects(() => binding.forgetBinding('/tmp/dsh-ssh-escape'), /outside the ssh workspace root/)
})
