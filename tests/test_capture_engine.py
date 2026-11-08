"""LL3c on the real engine with a fake model endpoint: with the flag on the engine offers capture_task / capture_example; when the model
tries to call capture_task on its own (no /task-save from the person) the tool answers "Refused" and nothing is written; with the flag off
the tools do not exist. Skipped when no engine is installed."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = Path(os.environ.get("SHURACODE_ENGINE", Path.home() / ".local/share/shuracode/libexec/shuracode"))


def run_engine(flag):
    requests = []

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(req)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            names = [t["function"]["name"] for t in req.get("tools", []) if t.get("type") == "function"]
            has_result = any(m.get("role") == "tool" for m in req.get("messages", []))
            if "capture_task" in names and not has_result:
                deltas = [{"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                                                  "function": {"name": "capture_task", "arguments": "{}"}}]}, {}]
                finish = "tool_calls"
            else:
                deltas, finish = [{"role": "assistant", "content": "ok"}, {}], "stop"
            for i, delta in enumerate(deltas):
                last = i == len(deltas) - 1
                chunk = {"id": "t", "object": "chat.completion.chunk", "created": 0, "model": "t",
                         "choices": [{"index": 0, "delta": delta, "finish_reason": finish if last else None}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="capture-engine-") as tmp:
            tmp_path = Path(tmp)
            template = (ROOT / "config" / "shuracode.json.in").read_text(encoding="utf-8")
            template = template.replace("@REPO_DIR@", str(ROOT)).replace("@BASE_URL@", f"http://127.0.0.1:{server.server_port}/v1")
            config = json.loads(template)
            for entry in config.get("mcp", {}).values():
                entry["enabled"] = False
            for entry in config["plugin"]:
                if isinstance(entry, list) and entry[0].endswith("/plugin/lifelong-capture.ts"):
                    entry[1] = {"lifelongCapture": flag, "captureDir": str(tmp_path / "tasks"), "exampleDir": str(tmp_path / "examples")}
            config_dir = tmp_path / "config"
            config_dir.mkdir()
            config_path = config_dir / "shuracode.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            env = {**os.environ, "HOME": str(tmp_path), "PWD": str(tmp_path), "XDG_CONFIG_HOME": str(tmp_path / "xdg-config"),
                   "XDG_DATA_HOME": str(tmp_path / "data"), "XDG_CACHE_HOME": str(tmp_path / "xdg-cache"), "OPENCODE_CONFIG": str(config_path),
                   "OPENCODE_CONFIG_DIR": str(config_dir), "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_SHARE": "1",
                   "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1", "NO_COLOR": "1"}
            try:
                subprocess.run([str(ENGINE), "run", "save the task"], cwd=tmp, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=90)
            except subprocess.TimeoutExpired:
                pass
            written = [str(p.relative_to(tmp_path)) for d in ("tasks", "examples") for p in (tmp_path / d).rglob("*") if p.is_file()]
            return requests, written
    finally:
        server.shutdown()
        server.server_close()


@unittest.skipUnless(ENGINE.exists(), "no engine installed")
class CaptureOnEngine(unittest.TestCase):
    def test_flag_on_the_model_cannot_save_on_its_own(self):
        requests, written = run_engine(True)
        tool_requests = [r for r in requests if r.get("tools")]
        names = {t["function"]["name"] for r in tool_requests for t in r["tools"] if t.get("type") == "function"}
        self.assertIn("capture_task", names)
        self.assertIn("capture_example", names)
        results = [m.get("content", "") for r in requests for m in r.get("messages", []) if m.get("role") == "tool"]
        self.assertTrue(any(str(c).startswith("Refused") for c in results), results)
        self.assertEqual(written, [])

    def test_flag_off_the_tools_do_not_exist(self):
        requests, written = run_engine(False)
        names = {t["function"]["name"] for r in requests for t in r.get("tools", []) if t.get("type") == "function"}
        self.assertNotIn("capture_task", names)
        self.assertNotIn("capture_example", names)
        self.assertEqual(written, [])


if __name__ == "__main__":
    unittest.main()
