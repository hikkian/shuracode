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


def run_engine(flag, plugin_name="lifelong-capture.ts", tool_name="capture_task", gateway=None):
    requests = []
    memory_file = None

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
            is_title = any(m.get("role") == "system" and str(m.get("content", "")).lstrip().startswith("You are a title generator.") for m in req.get("messages", []))
            if tool_name in names and not has_result and not is_title:
                if plugin_name == "lifelong.ts" and memory_file:
                    memory_file.write_text("INDEX TWO: a changed memory index")
                deltas = [{"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                                                  "function": {"name": tool_name, "arguments": "{}"}}]}, {}]
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
                if isinstance(entry, list) and entry[0].endswith("/plugin/" + plugin_name):
                    entry[1] = {"lifelongCapture": flag, "captureDir": str(tmp_path / "tasks"), "exampleDir": str(tmp_path / "examples")}
                    if gateway:
                        entry[1]["gateway"] = gateway
                    if plugin_name == "lifelong.ts":
                        entry[1]["memoryEnabled"] = flag
            if plugin_name == "lifelong.ts":
                memory_file = tmp_path / "memory-index.md"
                memory_file.write_text("INDEX ONE: stable initial memory index")
                config["instructions"] = [str(memory_file)]
            config_dir = tmp_path / "config"
            config_dir.mkdir()
            config_path = config_dir / "shuracode.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            env = {**os.environ, "HOME": str(tmp_path), "PWD": str(tmp_path), "XDG_CONFIG_HOME": str(tmp_path / "xdg-config"),
                   "XDG_DATA_HOME": str(tmp_path / "data"), "XDG_CACHE_HOME": str(tmp_path / "xdg-cache"), "OPENCODE_CONFIG": str(config_path),
                   "OPENCODE_CONFIG_DIR": str(config_dir), "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_SHARE": "1",
                   "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1", "NO_COLOR": "1"}
            try:
                subprocess.run([str(ENGINE), "run", "Нет, для этого используй pytest." if plugin_name == "lifelong.ts" else "save the task"], cwd=tmp, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=90)
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


@unittest.skipUnless(ENGINE.exists(), "no engine installed")
class SignalsOnEngine(unittest.TestCase):
    def test_correction_capture_through_real_engine_is_proposed_only(self):
        gateway_root = Path(os.environ.get('SHURA_INTEGRATION_ROOT', '/home/alisher/Projects/shura-integration'))
        sys.path.insert(0, str(gateway_root/'tests/support'))
        from gateway_harness import GatewayHarness
        with GatewayHarness(guardian={'memoryEnabled':True,'lifelongCapture':True}) as gw:
            requests, _ = run_engine(True, 'lifelong.ts', 'capture_correction', f'http://127.0.0.1:{gw.gw_port}')
            self.assertTrue(requests, 'engine must reach the fake model endpoint')
            names = {t['function']['name'] for r in requests for t in r.get('tools', []) if t.get('type') == 'function'}
            self.assertIn('capture_correction', names)
            rows = gw.request('GET','/guardian/memory/list')[1]['results']
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['passport']['trust'],'proposed')
            self.assertEqual(rows[0]['passport']['confirmations'],0)
            self.assertEqual(rows[0]['body'].strip(chr(34)),'Нет, для этого используй pytest.')
            turns = [r for r in requests if r.get('tools') and not any(m.get('role') == 'system' and str(m.get('content','')).lstrip().startswith('You are a title generator.') for m in r.get('messages',[]))]
            self.assertGreaterEqual(len(turns), 2)
            system = lambda r: [m for m in r['messages'] if m.get('role') == 'system']
            self.assertIn('INDEX ONE', str(system(turns[0])))
            self.assertIn('INDEX TWO', str(system(turns[1])), 'dynamic system additions from the other plugin must survive')
            self.assertIn('[shura-lifelong:system-note]', str(system(turns[0])))
            self.assertIn('[shura-lifelong:system-note]', str(system(turns[1])))

    def test_signal_tools_absent_with_flag_off_on_real_engine(self):
        requests, _ = run_engine(False, 'lifelong.ts', 'capture_correction')
        self.assertTrue(requests, 'engine must reach the fake model endpoint')
        names = {t['function']['name'] for r in requests for t in r.get('tools', []) if t.get('type') == 'function'}
        self.assertNotIn('capture_correction', names)

if __name__ == "__main__":
    unittest.main()
