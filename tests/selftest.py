#!/usr/bin/env python3
"""Self-test of ShuraCode on a given engine. install.sh runs it before switching to a new engine version, so an
engine update that loses ShuraCode's look or name is never activated. Standard library only.

1. UI: start the TUI in a pseudo-terminal; the ShuraCode plugin must draw its logo tagline, footer brand and
   window title.
2. Identity: send one message to a throwaway local endpoint; the system prompt the engine builds must
   introduce the agent as ShuraCode, not by the engine's name.

    SHURACODE_ENGINE=/path/to/engine python3 tests/selftest.py [--timeout 25]
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parent.parent / "bin" / "shuracode"
CHECKS = {
    "plugin logo": re.compile(r"your local coding council"),
    "footer brand": re.compile(r"ShuraCode|Shura\s*Code"),
}
TITLE = re.compile(rb"\x1b\][02];ShuraCode")
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\")


def identity_check():
    """Run `shuracode run` against a local fake endpoint and inspect the system prompt it sends."""
    seen = []

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if req.get("tools"):
                seen.append(req["messages"][0]["content"])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta in ({"role": "assistant", "content": "ok"}, {}):
                chunk = {"id": "t", "object": "chat.completion.chunk", "created": 0, "model": "t",
                         "choices": [{"index": 0, "delta": delta, "finish_reason": None if delta else "stop"}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    workdir = tempfile.mkdtemp(prefix="shuracode-selftest-")
    override = {"provider": {"tiel-local": {"options": {"baseURL": f"http://127.0.0.1:{server.server_port}/v1"}}},
                "mcp": {"playwright": {"enabled": False}, "searxng": {"enabled": False}}}
    env = {**os.environ, "PWD": workdir, "OPENCODE_CONFIG_CONTENT": json.dumps(override)}
    try:
        subprocess.run([str(LAUNCHER), "run", "self-test"], cwd=workdir, env=env, stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=90)
    except subprocess.TimeoutExpired:
        pass
    server.shutdown()
    shutil.rmtree(workdir, ignore_errors=True)
    system = seen[-1] if seen else ""
    results = {
        "system prompt reached the model": bool(system),
        "agent introduces itself as ShuraCode": "You are ShuraCode" in system,
        "and names the model it runs on": bool(re.search(r"You are ShuraCode, running fully locally on the \S", system)),
        "no 'You are opencode'": bool(system) and not re.search(r"You are opencode\b", system),
    }
    for name, ok in results.items():
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    return all(results.values())


def main():
    timeout = float(sys.argv[sys.argv.index("--timeout") + 1]) if "--timeout" in sys.argv else 25.0
    workdir = tempfile.mkdtemp(prefix="shuracode-selftest-")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.environ.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "PWD": workdir})
        os.execv(str(LAUNCHER), [str(LAUNCHER)])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
    raw, end = b"", time.time() + timeout
    passed = False
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        raw += chunk
        # answer capability queries so the TUI does not wait for a real terminal
        if b"\x1b[6n" in chunk:
            os.write(fd, b"\x1b[1;1R")
        if b"\x1b]11;?" in chunk:
            os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        text = ANSI.sub("", raw.decode("utf8", "replace"))
        if all(p.search(text) for p in CHECKS.values()) and TITLE.search(raw):
            passed = True
            break
    for sig in (15, 9):
        try:
            os.kill(pid, sig)
            time.sleep(0.3)
        except ProcessLookupError:
            break
    shutil.rmtree(workdir, ignore_errors=True)
    text = ANSI.sub("", raw.decode("utf8", "replace"))
    for name, pattern in CHECKS.items():
        print(f"  {'ok  ' if pattern.search(text) else 'FAIL'} {name}")
    print(f"  {'ok  ' if TITLE.search(raw) else 'FAIL'} window title")
    identity = identity_check()
    sys.exit(0 if passed and identity else 1)


if __name__ == "__main__":
    main()
