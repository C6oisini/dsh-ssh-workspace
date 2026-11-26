import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sshHosts } from '../lib/ssh.js'

test('parses aliases, applies defaults per block and drops wildcards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-config-'))
  const config = path.join(dir, 'config')
  fs.writeFileSync(config, [
    'Host gpu-a',
    '  HostName 192.0.2.10',
    '  User dev',
    '  Port 2222',
    '',
    'Host gpu-b gpu-c',
    '  HostName 192.0.2.11',
    '',
    'Host *',
    '  User nobody',
    '',
  ].join('\n'))

  const hosts = sshHosts(config)
  assert.deepEqual(hosts.map((host) => host.alias), ['gpu-a', 'gpu-b', 'gpu-c'])
  assert.deepEqual(hosts[0], { alias: 'gpu-a', hostname: '192.0.2.10', user: 'dev', port: 2222 })
  assert.equal(hosts[1].hostname, '192.0.2.11')
  assert.equal(hosts[1].port, 22)
})
