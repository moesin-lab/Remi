#!/bin/sh
set -eu
test "$$" = 1
export PATH=/usr/bin:/bin LD_LIBRARY_PATH=/pg/lib
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t tmpfs -o mode=1777 tmpfs /tmp
/bin/busybox mkdir -p /dev/shm
/bin/busybox mount -t tmpfs -o mode=1777 tmpfs /dev/shm
/bin/busybox mount -t tmpfs -o mode=755 tmpfs /srv
/bin/busybox mount -t tmpfs tmpfs /repo/node_modules/.cache
/bin/busybox ifconfig lo 127.0.0.1 up
python3 - <<'PY'
import os
import subprocess

os.setgroups([])
os.setgid(1104)
os.setuid(1104)
subprocess.run(['/pg/bin/initdb','-D','/tmp/pg','-A','trust','--no-locale','-U','test'],check=True)
subprocess.run(['/pg/bin/pg_ctl','-D','/tmp/pg','-l','/tmp/pg.log','-o','-h 127.0.0.1 -k /tmp -p 5432','-w','start'],check=True)
PY
export MULTIREMI_TEST_POSTGRES_URL=postgres://test@127.0.0.1:5432/postgres MULTIREMI_TEST_LOCK_ORDER_SENTINEL=1
cd /repo
result=0
bun run test ./tests/unit/multiremi/root-daemon-recovery.guest.ts --timeout 180000 || result=$?
echo "A2_GUEST_EXIT=$result"
/bin/busybox poweroff -f
