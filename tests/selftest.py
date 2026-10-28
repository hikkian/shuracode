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

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "bin" / "shuracode"
ENGINE = Path(os.environ.get("SHURACODE_ENGINE", Path.home() / ".local/share/shuracode/libexec/shuracode"))
CHECKS = {
    "plugin logo": re.compile(r"your local coding council"),
    "footer brand": re.compile(r"ShuraCode|Shura\s*Code"),
}
GUIDE = re.compile(r"This reference: every command|Этот справочник: все команды|Осы анықтамалық: барлық командалар")
TITLE = re.compile(rb"\x1b\][02];ShuraCode")
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\")


def identity_check():
    """Check local plugin identity and model-harness selection without reading live user config."""
    seen = []

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if req.get("tools"):
                system = "\n".join(str(message.get("content", "")) for message in req.get("messages", [])
                                     if message.get("role") == "system")
                seen.append(system)
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
    cases = (
        ("tiel-local/tiel-coder", "tiel-coder", "tiel"),
        ("tiel-local/sage", "sage", "sage"),
        ("gemma-local/gemma", "gemma", "gemma"),
    )
    passed = True
    try:
        with tempfile.TemporaryDirectory(prefix="shuracode-selftest-") as tmp:
            tmp_path = Path(tmp)
            harness_dir = tmp_path / "harness"
            for _, _, key in cases:
                folder = harness_dir / key
                folder.mkdir(parents=True, exist_ok=True)
                (folder / "harness.md").write_text(f"SELFTEST_HARNESS_{key.upper()}", encoding="utf-8")

            # Exercise the already-branded introduction too: server.ts should enrich it with the selected model.
            already_branded = tmp_path / "already-branded.md"
            already_branded.write_text("You are ShuraCode, an interactive CLI tool.", encoding="utf-8")

            template = (ROOT / "config" / "shuracode.json.in").read_text(encoding="utf-8")
            template = template.replace("@REPO_DIR@", str(ROOT))
            template = template.replace("@BASE_URL@", f"http://127.0.0.1:{server.server_port}/v1")
            config = json.loads(template)
            config["instructions"] = [str(already_branded)]
            for entry in config.get("mcp", {}).values():
                entry["enabled"] = False
            for entry in config.get("plugin", []):
                if isinstance(entry, list) and entry[0].endswith("/plugin/model-harness.ts"):
                    entry[1]["harnessDir"] = str(harness_dir)

            config_dir = tmp_path / "config"
            config_dir.mkdir()
            config_path = config_dir / "shuracode.json"
            data_dir = tmp_path / "data"
            env = {
                **os.environ,
                "HOME": str(tmp_path),
                "PWD": str(tmp_path),
                "XDG_CONFIG_HOME": str(tmp_path / "xdg-config"),
                "XDG_DATA_HOME": str(data_dir),
                "XDG_CACHE_HOME": str(tmp_path / "xdg-cache"),
                "OPENCODE_CONFIG": str(config_path),
                "OPENCODE_CONFIG_DIR": str(config_dir),
                "OPENCODE_DISABLE_AUTOUPDATE": "1",
                "OPENCODE_DISABLE_SHARE": "1",
                "OPENCODE_DISABLE_MODELS_FETCH": "1",
                "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
                "NO_COLOR": "1",
            }
            for qualified_model, model_id, key in cases:
                seen.clear()
                config["model"] = qualified_model
                config["small_model"] = qualified_model
                config_path.write_text(json.dumps(config), encoding="utf-8")
                try:
                    subprocess.run([str(ENGINE), "run", "self-test"], cwd=tmp, env=env,
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=90)
                except subprocess.TimeoutExpired:
                    pass
                system = seen[-1] if seen else ""
                intro = re.search(r"You are ShuraCode, running fully locally on the ([^,]+) model,", system)
                has_name = bool(intro and any(label.casefold() in intro.group(1).casefold()
                                               for label in (model_id, re.split(r"\s+[(—]", config["provider"][qualified_model.split("/", 1)[0]]["models"][model_id]["name"])[0])))
                has_harness = f"SELFTEST_HARNESS_{key.upper()}" in system
                has_already_branded = bool(intro and f"You are ShuraCode, running fully locally on the {intro.group(1)} model, an interactive CLI tool." in system)
                no_engine_name = bool(system) and not re.search(r"You are opencode\b", system)
                for label, ok in (
                    (f"system prompt reached the model ({qualified_model})", bool(system)),
                    (f"names the selected model ({qualified_model})", has_name),
                    (f"model harness survives ({qualified_model})", has_harness),
                    (f"already-branded intro names the model ({qualified_model})", has_already_branded),
                    (f"no 'You are opencode' ({qualified_model})", no_engine_name),
                ):
                    print(f"  {'ok  ' if ok else 'FAIL'} {label}")
                    passed = passed and ok
    finally:
        server.shutdown()
        server.server_close()
    return passed


def launcher_output_limit_check():
    """Verify engine_env passes the intended output ceiling without an installed engine."""
    with tempfile.TemporaryDirectory(prefix="shuracode-env-selftest-") as tmp:
        root=Path(tmp)
        fake=root/"fake-engine"
        fake.write_text("#!/usr/bin/env python3\nimport os\nprint(os.environ.get('OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX', 'missing'))\n",encoding="utf-8")
        fake.chmod(0o755)
        env={**os.environ,"SHURACODE_ENGINE":str(fake),"SHURACODE_HOME":str(root/"home"),
             "SHURACODE_CONFIG_DIR":str(root/"config")}
        try:
            result=subprocess.run([str(LAUNCHER),"env-probe"],env=env,text=True,capture_output=True,timeout=5)
        except (OSError,subprocess.TimeoutExpired):
            passed=False
        else:
            passed=result.returncode==0 and result.stdout.strip()=="32768"
        print(f"  {'ok  ' if passed else 'FAIL'} launcher exports 32768 output-token ceiling")
        return passed


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
    guide_ok = False
    if passed:
        # the command reference: /guide + Enter opens the dialog, a second Enter opens the card of the highlighted command (/guide itself)
        mark = len(raw)
        os.write(fd, b"/guide")
        time.sleep(1.0)
        os.write(fd, b"\r")
        time.sleep(2.5)
        os.write(fd, b"\r")
        end2 = time.time() + 10
        while time.time() < end2 and not guide_ok:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                raw += chunk
                if b"\x1b[6n" in chunk:
                    os.write(fd, b"\x1b[1;1R")
            guide_ok = bool(GUIDE.search(ANSI.sub("", raw[mark:].decode("utf8", "replace"))))
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
    print(f"  {'ok  ' if guide_ok else 'FAIL'} /guide opens the command reference")
    identity = identity_check()
    output_limit = launcher_output_limit_check()
    sys.exit(0 if passed and guide_ok and identity and output_limit else 1)


if __name__ == "__main__":
    main()
