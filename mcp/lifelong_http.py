"""Opt-in client transport: all writes to Shura's memory are performed by the gateway."""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


def enabled():
    return os.environ.get('SHURACODE_MEMORY_ENABLED', '').lower() in ('1', 'true')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # an opt-in local memory connection must never follow a remote redirect


class GatewayMemory:
    def __init__(self, error_type):
        self.error_type = error_type
        self.base = os.environ.get('SHURA_LIFELONG_URL', 'http://127.0.0.1:8080').rstrip('/')
        u = urllib.parse.urlsplit(self.base)
        if u.scheme != 'http' or u.hostname not in ('localhost', '127.0.0.1', '::1') or u.username or u.password or u.query or u.fragment or u.path:
            raise error_type('SHURA_LIFELONG_URL must be a loopback HTTP origin')
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    @staticmethod
    def key(name):
        return re.sub(r'[^a-z0-9]+', '-', str(name).strip().lower()).strip('-')[:60].strip('-')

    def call(self, op, data=None, query=None):
        url = self.base + '/guardian/memory/' + op
        if query:
            url += '?' + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                     headers={'Content-Type': 'application/json'})
        if os.environ.get('SHURA_GATEWAY_API_KEY'):
            req.add_header('Authorization', 'Bearer ' + os.environ['SHURA_GATEWAY_API_KEY'])
        try:
            with self.http.open(req, timeout=3) as response:
                text = response.read().decode()
                return text if op == 'export' else json.loads(text)
        except (OSError, ValueError) as error:
            raise self.error_type(f'gateway memory/{op} unavailable: {error}') from error

    def save(self, name, description, type, content):
        kinds = {'user': 'preference', 'feedback': 'procedure', 'project': 'fact', 'reference': 'note'}
        if type not in kinds:
            raise self.error_type('unknown memory type')
        key = self.key(name)
        # Exact-key read avoids losing version history when a key is not among the first FTS results.
        try:
            rec = self.call('read', query={'key': key})
        except self.error_type as error:
            cause = error.__cause__
            if not isinstance(cause, urllib.error.HTTPError) or cause.code != 400:
                raise
            rec = None
        if rec and (rec['title'] != description or rec['body'] != content or rec['kind'] != kinds[type]):
            out = self.call('fix', {'key': key, 'title': description, 'body': content, 'kind': kinds[type]})
        else:
            out = self.call('save', {'key': key, 'title': description, 'body': content, 'kind': kinds[type]})['record']
        return f"Saved memory '{out['key']}'. Passport: {out['passport_line']}."

    def read(self, name):
        r = self.call('read', query={'key': self.key(name)})
        return f"{r['key']} {r['passport_line']}: {r['title']}\n{r['body']}"

    def search(self, query, limit=100):
        rows = (self.call('search', query={'q': query, 'limit': limit}) if query.strip() else self.call('list'))['results']
        return '\n'.join(f"- {r['key']} {r['passport_line']}: {r['title']}" +
                         ('\n    ! contradicts: ' + ', '.join(c['with'] for c in r['contradictions']) if r['contradictions'] else '')
                         for r in rows) or 'No memories found.'

    def delete(self, name):
        return self.forget(name)

    def fix(self, name, content, relation='replace'):
        return json.dumps(self.call('fix', {'key': self.key(name), 'body': content, 'relation': relation}), ensure_ascii=False)

    def forget(self, name, purge=False):
        return json.dumps(self.call('forget', {'key': self.key(name), 'purge': False}), ensure_ascii=False)

    def restore(self, name):
        return json.dumps(self.call('restore', {'key': self.key(name)}), ensure_ascii=False)

    def stats(self):
        return json.dumps(self.call('stats'), ensure_ascii=False)

    def export(self):
        return self.call('export')

    def import_records(self, text, external_source=None):
        # MCP input is untrusted even when it claims to be a Shura export.
        return json.dumps(self.call('import', {'text': text, 'external_source': 'mcp-import'}), ensure_ascii=False)

    def reindex(self):
        pass  # the gateway owns MEMORY.md too


def management_tools():
    def tool(name, description, properties, required=()):
        return {'name': name, 'description': description, 'inputSchema': {'type': 'object', 'properties': properties,
                'required': list(required), 'additionalProperties': False}}
    string = {'type': 'string'}
    return [tool('fix', 'Propose a correction to a memory. User confirmation is required.', {'name': string, 'content': string, 'relation': {'type': 'string', 'enum': ['replace', 'dispute', 'both_true']}}, ['name', 'content']),
            tool('forget', 'Soft-delete a memory. Permanent purge is available only from the user command.', {'name': string}, ['name']),
            tool('restore', 'Restore a soft-deleted memory after /memory restore.', {'name': string}, ['name']),
            tool('stats', 'Show memory counts and disk write statistics.', {}),
            tool('export', 'Return JSON Lines with passports and journal; write to a file only when requested.', {}),
            tool('import_records', 'Import supplied JSON Lines. Foreign material must carry external_source and stays proposed quotes.', {'text': string, 'external_source': string}, ['text'])]
