"""Exercise production image-preview input/output with a graphics-capable PTY peer.

This checks the protocol/lifecycle, not Ghostty's pixel rendering.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 960, 576))
process = subprocess.Popen(["bun", "run", "scripts/image-preview.ts"], stdin=slave, stdout=slave, stderr=slave,
                           env={**os.environ, "TERM": "xterm-256color"})
os.close(slave)
received = bytearray()


def wait_for(pattern, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        match = re.search(pattern, received)
        if match:
            return match
        if select.select([master], [], [], 0.1)[0]:
            received.extend(os.read(master, 65536))
    raise AssertionError(f"Missing {pattern!r}; tail: {received[-1000:]!r}")


try:
    match = wait_for(rb'a=q,t=d,f=24,s=1,v=1,i=(\d+)')
    image_id = match.group(1)
    os.write(master, b'\x1b_Gi=' + image_id + b';OK\x1b\\\x1b[6;16;8t')
    wait_for(rb'a=t,t=d,f=100')
    wait_for(rb'a=p,i=' + image_id)
    received.clear()
    # Mixed-axis downward momentum must not upload the image again.
    os.write(master, (b'\x1b[<65;110;10M\x1b[<66;110;10M\x1b[<67;110;10M') * 30)
    end = time.monotonic() + 0.3
    while time.monotonic() < end:
        if select.select([master], [], [], 0.05)[0]:
            received.extend(os.read(master, 65536))
    assert b'a=t,t=d,f=100' not in received
    received.clear()
    os.write(master, b'\x1bv')  # Alt+V closes the panel.
    wait_for(rb'a=d,d=I,i=' + image_id)
    received.clear()
    os.write(master, b'\x1bv')
    wait_for(rb'a=p,i=' + image_id)
    received.clear()
    process.send_signal(signal.SIGTERM)
    wait_for(rb'\x1b\[\?1049l')
    assert process.wait(timeout=5) == 0
    print("PASS: capability replies, image upload/placement, mixed-axis momentum, close/reopen, terminal cleanup")
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
