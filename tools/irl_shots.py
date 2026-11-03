"""Screenshot sink for the IRL building verification: POST a JPEG data URL to http://127.0.0.1:<port>/<name>.jpg,
it is saved to tools/cache/osm/shots/<name>.jpg (GET serves it back, for montages). Local only.

Run: .venv/bin/python tools/irl_shots.py [port=5397]
"""
import base64
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tools', 'cache', 'osm', 'shots')


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def _path(self):
        name = os.path.basename(self.path.split('?')[0]) or 'shot.jpg'
        return os.path.join(OUT, name if name.endswith('.jpg') else name + '.jpg')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if body.startswith(b'data:'):
            body = base64.b64decode(body.split(b',', 1)[1])
        os.makedirs(OUT, exist_ok=True)
        with open(self._path(), 'wb') as f:
            f.write(body)
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(b'ok')

    def do_GET(self):
        p = self._path()
        if not os.path.exists(p):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'image/jpeg')
        self.end_headers()
        self.wfile.write(open(p, 'rb').read())

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5397
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
