"""Run inside a disposable Linux guest with Bun, Python 3.9+, procfs and UID/GID 1001..1003 mapped."""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile


OWNER, DAEMON, EXECUTION = 1001, 1002, 1003
SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[2]


def serve(bun, scratch, ready):
    directory = scratch / 'service'
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    with listener:
        listener.bind(str(directory / 'machine.sock'))
        os.chmod(directory / 'machine.sock', 0o666)
        listener.listen()
        listener.settimeout(15)
        os.write(ready, b'1')
        os.close(ready)
        failures = 0
        for _ in range(7):
            connection, _ = listener.accept()
            with connection:
                result = subprocess.run([bun, scratch / 'service.js', directory / 'keys'],
                                        stdin=connection, timeout=10)
                if result.returncode:
                    print(f'Machine service exited with {result.returncode}', file=sys.stderr, flush=True)
                    failures += 1
        if failures:
            raise RuntimeError(f'{failures} machine service processes failed')


def control(directory):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(10)
        client.connect(str(directory / 'machine.sock'))
        client.sendall(b'{"method":"publicBinding"}')
        client.shutdown(socket.SHUT_WR)
        with client.makefile('rb') as stream:
            reply = json.load(stream)
    if reply != {'ok': True, 'result': json.loads((directory / 'public.json').read_text())}:
        raise RuntimeError('Unexpected public binding in transport control')
    print('daemon: independent half-close control passed', flush=True)


def exercise(scratch):
    bun = shutil.which('bun')
    if not bun or sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Run in a disposable Linux guest as guest root with bun on PATH')
    for source, output in [(SOURCE / 'root-machine-ipc-peer.ts', 'peer.js'),
                           (ROOT / 'packages/daemon/src/agent-runtime/root-machine-service.ts', 'service.js')]:
        subprocess.run([bun, 'build', source, '--target=bun', '--outfile', scratch / output], cwd=ROOT, check=True)
    directory = scratch / 'service'
    directory.mkdir(mode=0o755)
    os.chown(directory, OWNER, OWNER)
    scratch.chmod(0o755)

    def peer(role, uid):
        subprocess.run([bun, scratch / 'peer.js', role, directory, str(OWNER), str(DAEMON), str(EXECUTION)],
                       cwd=scratch, user=uid, group=uid, extra_groups=[], check=True, timeout=30)

    peer('service', OWNER)
    reader, writer = os.pipe()
    with os.fdopen(reader, 'rb') as signal:
        server = subprocess.Popen([sys.executable, __file__, 'serve', bun, scratch, str(writer)],
                                  cwd=scratch, user=OWNER, group=OWNER, extra_groups=[], pass_fds=(writer,))
        os.close(writer)
        try:
            if signal.read(1) != b'1':
                raise RuntimeError('Machine socket listener failed to start')
            failures = []
            subprocess.run([sys.executable, __file__, 'control', directory], cwd=scratch,
                           user=DAEMON, group=DAEMON, extra_groups=[], check=True, timeout=15)
            for role, uid in [('daemon', DAEMON), ('execution', EXECUTION), ('daemon', DAEMON)]:
                try:
                    peer(role, uid)
                except subprocess.CalledProcessError:
                    failures.append(role)
            if server.wait(timeout=20) != 0:
                failures.append('service')
            if failures:
                raise RuntimeError(f'Failed fixture roles: {failures}')
        finally:
            if server.poll() is None:
                server.kill()
            server.wait()


if __name__ == '__main__':
    if sys.argv[1:2] == ['serve']:
        serve(sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]))
    elif sys.argv[1:2] == ['control']:
        control(Path(sys.argv[2]))
    else:
        os.umask(0o022)
        with tempfile.TemporaryDirectory(prefix='root-machine-ipc-', dir='/tmp') as temporary:
            exercise(Path(temporary))
