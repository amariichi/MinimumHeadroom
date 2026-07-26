#!/usr/bin/env python3
"""Small pseudo-TTY implementation of the Atom RMHCFG protocol for tests."""

import os
import pty
import select
import sys
import time


master_fd, slave_fd = pty.openpty()
print(os.ttyname(slave_fd), flush=True)
os.write(master_fd, b"fake atom booting\r\n")

buffer = b""
query_count = 0
config_count = 0
saved = False
deadline = time.monotonic() + 8

while time.monotonic() < deadline:
    readable, _, _ = select.select([master_fd], [], [], 0.25)
    if not readable:
        continue
    try:
        chunk = os.read(master_fd, 4096)
    except OSError as error:
        print(f"fake atom read error: {error}", file=sys.stderr, flush=True)
        sys.exit(2)
    if not chunk:
        continue
    buffer += chunk
    while b"\n" in buffer:
        raw_line, buffer = buffer.split(b"\n", 1)
        line = raw_line.rstrip(b"\r").decode("utf-8", errors="replace")
        if line == "RMHCFG?":
            query_count += 1
            if not saved and query_count == 1:
                # Reproduce a USB-CDC startup race by dropping the first probe.
                continue
            state = '{"ready":true,"saved":%s}' % ("true" if saved else "false")
            os.write(master_fd, f"RMHCFG STATE {state}\r\n".encode())
            if saved:
                time.sleep(0.1)
                print(
                    f"queries={query_count} configs={config_count}",
                    file=sys.stderr,
                    flush=True,
                )
                sys.exit(0)
            continue
        if line.startswith("RMHCFG "):
            config_count += 1
            if config_count != 1:
                print("configuration command was sent more than once", file=sys.stderr, flush=True)
                sys.exit(3)
            saved = True
            os.write(master_fd, b"RMHCFG OK saved\r\n")

print(
    f"fake atom timed out: queries={query_count} configs={config_count} saved={saved}",
    file=sys.stderr,
    flush=True,
)
sys.exit(4)
