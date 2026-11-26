import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys


root = Path(sys.argv[1])
assert os.geteuid() == os.getegid() == 1102 and not os.getgroups()
os.umask(0o077)
keys = root / 'machine' / 'keys'
keys.mkdir()
(keys / 'binding.json').write_bytes((root / 'binding.json').read_bytes())
provision = """
const {generateKeyPairSync} = require('node:crypto');
const {writeFileSync} = require('node:fs');
const binding = {};
for (const [name, type] of [['recipient','rsa'], ['signing','ed25519']]) {
  const pair = generateKeyPairSync(type, type === 'rsa' ? {modulusLength:3072} : {});
  writeFileSync(name+'.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  binding[name] = pair.publicKey.export({type:'spki',format:'pem'});
}
console.log(JSON.stringify(binding));
"""
public = json.loads(subprocess.check_output(['/usr/bin/node', '-e', provision], cwd=keys))
signal.signal(signal.SIGCHLD, signal.SIG_IGN)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
    endpoint = root / 'machine' / 'machine.sock'
    listener.bind(str(endpoint))
    endpoint.chmod(0o666)
    listener.listen()
    print(json.dumps(dict(uid=os.geteuid(), **public)), flush=True)
    while True:
        connection, _ = listener.accept()
        with connection:
            subprocess.Popen(['/bun', '/repo/packages/daemon/src/agent-runtime/root-machine-service.ts', str(keys)],
                             stdin=connection, stdout=subprocess.DEVNULL)
