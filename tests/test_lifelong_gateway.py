"""LL6a client commands against the gateway and existing fake llama harness; CPU only."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
GATEWAY = Path(os.environ.get('SHURA_INTEGRATION_ROOT', '/home/alisher/Projects/shura-integration'))
sys.path.insert(0, str(ROOT / 'mcp'))
sys.path.insert(0, str(GATEWAY / 'tests/support'))
from gateway_harness import GatewayHarness
import memory as M
import rules as R
from lifelong_http import GatewayMemory


class MemoryCommands(unittest.TestCase):
    def test_install_memory_transform_removes_node_allow_only_when_enabled(self):
        template_path = ROOT/'config/shuracode.json.in'
        default = json.loads(template_path.read_text())
        expressions = [
            '/"python \\*": "allow",/d',
            '/"python3 \\*": "allow",/d',
            '/"node \\*": "allow",/d',
            '/"curl \\*127.0.0.1\\*": "allow",/d',
            '/"curl \\*localhost\\*": "allow",/d',
            's/"memoryEnabled": false/"memoryEnabled": true/g',
        ]
        args = [part for expression in expressions for part in ('-e', expression)]
        rendered = subprocess.check_output(['sed', *args, str(template_path)], text=True)
        memory = json.loads(rendered)
        self.assertIn('node *', default['permission']['bash'])
        self.assertNotIn('node *', memory['permission']['bash'])
        for command in ('pytest*', 'python -m pytest*', 'python3 -m pytest*', 'npm run*', 'npm test*'):
            self.assertIn(command, memory['permission']['bash'])

    def test_mcp_management_commands_share_gateway_store_and_passports(self):
        with GatewayHarness(guardian={'memoryEnabled': True}) as gw:
            with patch.dict(os.environ, {'SHURACODE_MEMORY_ENABLED': 'true', 'SHURA_LIFELONG_URL': f'http://127.0.0.1:{gw.gw_port}'}):
                store = M.make_store()
                self.assertIsInstance(store, GatewayMemory)
                def call(tool, expected_error=False, **args):
                    result = M.handle(store, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}})['result']
                    self.assertEqual(result['isError'], expected_error, result)
                    return result['content'][0]['text']
                tools = M.handle(store, {'id': 1, 'method': 'tools/list'})['result']['tools']
                self.assertTrue({'fix','forget','stats','restore','export','import_records'} <= {t['name'] for t in tools})
                call('save', name='pytest-pref', description='Prefer pytest', type='user', content='Run pytest -q.')
                self.assertIn('proposed', call('search', query=''))
                self.assertIn('you,', call('read', name='pytest-pref'))
                fixed = json.loads(call('fix', name='pytest-pref', content='Run pytest -x.'))
                self.assertEqual(fixed['record']['passport']['trust'], 'proposed')
                call('delete', name=fixed['record']['key'])
                call('delete', name='pytest-pref')
                self.assertNotIn('pytest-pref', call('search', query='pytest'))
                self.assertIn('http error 403', call('restore', True, name='pytest-pref').lower())
                exported = call('export')
                self.assertIn('"source"', exported)
                call('import_records', text=exported)
                call('import_records', text=json.dumps({'title': 'Foreign note', 'body': 'Use another tool'}), external_source='fixture')
                rows = gw.request('GET', '/guardian/memory/search?q=foreign')[1]['results']
                self.assertEqual(rows[0]['passport']['trust'], 'proposed')
                self.assertTrue(rows[0]['passport']['source'].startswith('external:'))
                self.assertGreater(json.loads(call('stats'))['records'], 0)
                forget_schema = next(t for t in tools if t['name'] == 'forget')['inputSchema']
                self.assertNotIn('purge', forget_schema['properties'])

    def test_flags_off_mcp_tool_payload_equals_existing_tools_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = M.Store(Path(tmp))
            with patch.dict(os.environ, {'SHURACODE_MEMORY_ENABLED': 'false'}):
                actual = M.handle(store, {'id': 7, 'method': 'tools/list'})
                expected = {'jsonrpc': '2.0', 'id': 7, 'result': {'tools': M.TOOLS}}
                self.assertEqual(json.dumps(actual).encode(), json.dumps(expected).encode())

    def test_flags_off_stdio_and_index_match_pre_ll6a_byte_for_byte(self):
        checkout = Path(os.environ.get('SHURACODE_BASELINE', GATEWAY.parent/'shuracode-integration'))
        baseline = subprocess.check_output(['git', 'show', 'HEAD:mcp/memory.py'], cwd=checkout)
        messages = [{'id': 1, 'method': 'initialize'}, {'id': 2, 'method': 'tools/list'},
                    {'id': 3, 'method': 'tools/call', 'params': {'name': 'save', 'arguments': {
                        'name': 'pytest', 'description': 'Prefer pytest', 'type': 'user', 'content': 'Run pytest -q.'}}},
                    {'id': 4, 'method': 'tools/call', 'params': {'name': 'read', 'arguments': {'name': 'pytest'}}},
                    {'id': 5, 'method': 'tools/call', 'params': {'name': 'search', 'arguments': {'query': 'pytest'}}}]
        wire = ''.join(json.dumps(m)+'\n' for m in messages).encode()
        with tempfile.TemporaryDirectory() as tmp:
            old = Path(tmp)/'memory-before.py'; old.write_bytes(baseline)
            results = []
            for n, server in enumerate((old, ROOT/'mcp/memory.py')):
                memory = Path(tmp)/str(n)
                env = {**os.environ, 'SHURACODE_MEMORY_ENABLED': 'false', 'SHURACODE_MEMORY_LEGACY':'1',
                       'SHURACODE_MEMORY_DIR':str(memory)}
                run = subprocess.run([sys.executable, str(server)], input=wire, capture_output=True, env=env, timeout=10)
                self.assertEqual(run.returncode, 0, run.stderr.decode())
                results.append((run.stdout, (memory/'MEMORY.md').read_bytes(), (memory/'pytest.md').read_bytes()))
            self.assertEqual(results[0], results[1])

    def test_permission_paths_override_the_default_allow(self):
        config = json.loads((ROOT/'config/shuracode.json.in').read_text())
        edit = list(config['permission']['edit'].items())
        self.assertEqual(edit[0], ('*','allow'))
        self.assertEqual(edit[-1], ('**/.local/share/shura/**','deny'))
        self.assertEqual(config['permission']['bash']['*/.local/share/shura/*'],'deny')
        entry = next(p for p in config['plugin'] if isinstance(p,list) and p[0].endswith('/plugin/lifelong.ts'))
        self.assertFalse(entry[1]['lifelongCapture'])
        self.assertFalse(entry[1]['memoryEnabled'])

    def test_rules_list_and_show_have_source_date_and_trust_only_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules = R.Rules(Path(tmp)/'m.sqlite', Path(tmp)/'skills', 'test')
            try:
                rules.propose('pytest-rule', 'When running tests', 'Use pytest', 'A user correction', model='tiel')
                with patch.dict(os.environ, {'SHURACODE_MEMORY_ENABLED':'false'}):
                    old_list, old_show = rules.list(), rules.show('pytest-rule', 'tiel')
                    self.assertNotIn('passport:', old_list)
                with patch.dict(os.environ, {'SHURACODE_MEMORY_ENABLED':'true'}):
                    for text in (rules.list(), rules.show('pytest-rule', 'tiel')):
                        self.assertIn('source:', text)
                        self.assertIn('date:', text)
                        self.assertIn('trust: proposed', text)
                with patch.dict(os.environ, {'SHURACODE_MEMORY_ENABLED':'false'}):
                    self.assertEqual((rules.list(), rules.show('pytest-rule', 'tiel')), (old_list, old_show))
            finally:
                rules.db.close()


if __name__ == '__main__': unittest.main()
