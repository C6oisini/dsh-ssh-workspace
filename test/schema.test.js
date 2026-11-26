import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTools } from '../lib/tools.js'

test('all ssh tools compile parameters to object-level JSON Schema', () => {
  const tools = buildTools()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ssh_read', 'ssh_write', 'ssh_edit', 'ssh_ls', 'ssh_stat', 'ssh_glob', 'ssh_grep', 'ssh_bash'],
  )
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object schema`)
    assert.equal(typeof tool.parameters.properties, 'object')
    for (const [name, property] of Object.entries(tool.parameters.properties)) {
      assert.equal('required' in property, false, `${tool.name}.${name} must not carry property-level required`)
      assert.equal(typeof property.type, 'string')
    }
    if (tool.parameters.required) {
      assert.ok(Array.isArray(tool.parameters.required))
      for (const name of tool.parameters.required) assert.ok(tool.parameters.properties[name], `${tool.name} requires unknown ${name}`)
    }
  }
})
