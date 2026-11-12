"""Bounded, public-HTTPS-only metadata fetches; no third-party browser requests."""
import base64
import hashlib
import http.client
import io
import ipaddress
import json
import socket
import ssl
import threading
import time
import warnings
from html.parser import HTMLParser
from urllib.parse import urlsplit, urljoin
from PIL import Image, ImageOps

SITES = {'makerworld.com': 'MakerWorld', 'www.makerworld.com': 'MakerWorld',
         'printables.com': 'Printables', 'www.printables.com': 'Printables'}
LOCK = threading.Lock()


def platform(url):
    try:
        return SITES.get(urlsplit(url).hostname, '')
    except ValueError:
        return ''


def fetch(url, limit, pages=False):
    """Pin each TLS connection to a validated public IP, including redirects."""
    for _ in range(4):
        p = urlsplit(url)
        if (p.scheme != 'https' or not p.hostname or p.username or p.password
                or p.port not in (None, 443) or any(ord(c) < 33 or c == '\\' for c in url)):
            raise ValueError('Invalid preview URL')
        if pages and p.hostname not in SITES:
            raise ValueError('Unsupported platform')
        addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError('Non-public destination')
        address = addresses[0][4][0]
        connection = http.client.HTTPSConnection(p.hostname, timeout=3, context=ssl.create_default_context())
        try:
            # Do not resolve again after validation (DNS rebinding).
            raw = socket.create_connection((address, 443), timeout=3)
            try:
                connection.sock = connection._context.wrap_socket(raw, server_hostname=p.hostname)
            except Exception:
                raw.close()
                raise
            connection.request('GET', p.path + ('?' + p.query if p.query else '') or '/',
                               headers={'User-Agent': 'PrintLeague-LinkPreview/1.0', 'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                url = urljoin(url, response.getheader('Location', ''))
                continue
            if response.status != 200:
                raise ValueError('Preview unavailable')
            mime = response.getheader('Content-Type', '').split(';')[0].lower()
            if (pages and mime not in ('text/html', 'application/xhtml+xml')) or (not pages and mime not in ('image/jpeg','image/png','image/webp')):
                raise ValueError('Unexpected content type')
            if int(response.getheader('Content-Length', '0')) > limit:
                raise ValueError('Preview too large')
            body = bytearray()
            end = time.monotonic() + 5
            while len(body) <= limit:
                if time.monotonic() > end:
                    raise ValueError('Preview timed out')
                chunk = response.read1(min(65536, limit + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
            if len(body) > limit:
                raise ValueError('Preview too large')
            return bytes(body), url
        finally:
            connection.close()
    raise ValueError('Too many redirects')


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values = {}
        self.in_title = False
        self.title = ''

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            key = attrs.get('property', attrs.get('name', '')).lower()
            self.values.setdefault(key, attrs.get('content', '')[:4096])
        if tag == 'title':
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title = (self.title + data)[:240]


def build(url):
    result = {'platform': platform(url), 'title': '', 'description': '', 'image': ''}
    if not result['platform']:
        return result
    try:
        body, final_url = fetch(url, 1024 * 1024, pages=True)
        parser = Metadata()
        parser.feed(body.decode('utf-8', errors='replace'))
        values = parser.values
        result['title'] = (values.get('og:title') or values.get('twitter:title') or parser.title)[:240]
        result['description'] = (values.get('og:description') or values.get('description') or '')[:300]
        image_url = values.get('og:image') or values.get('twitter:image')
        if image_url:
            raw, _ = fetch(urljoin(final_url, image_url), 4 * 1024 * 1024)
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw), formats=['JPEG','PNG','WEBP']) as original:
                    if original.width * original.height > 16_000_000:
                        raise ValueError('Image too large')
                    photo = ImageOps.exif_transpose(original).convert('RGB')
                    photo.thumbnail((960, 640))
                    photo.info.clear()
                    output = io.BytesIO()
                    photo.save(output, 'WEBP', quality=80)
                    result['image'] = base64.b64encode(output.getvalue()).decode('ascii')
    except (OSError, ValueError, http.client.HTTPException, Image.DecompressionBombError, Image.DecompressionBombWarning):
        pass  # The saved print link remains usable when providers block scraping.
    return result


CACHE_BUDGET = 20 * 1024 * 1024


def prune(folder, budget=CACHE_BUDGET):
    """Keep disposable preview files under the byte budget, newest first."""
    files = sorted(folder.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    used = 0
    for path in files:
        size = path.stat().st_size
        if time.time() - path.stat().st_mtime > 86400 or used + size > budget:
            path.unlink(missing_ok=True)
        else:
            used += size


def cached(url, folder):
    folder.mkdir(exist_ok=True)
    path = folder / (hashlib.sha256(url.encode()).hexdigest() + '.json')
    def read():
        try:
            data = json.loads(path.read_text())
            if time.time() - data['saved'] < 86400:
                return data['preview']
        except (OSError, ValueError, KeyError):
            pass
    value = read()
    if value is not None:
        return value
    # Never tie up all application workers behind slow remote metadata.
    if not LOCK.acquire(blocking=False):
        return {'platform': platform(url), 'title': '', 'description': '', 'image': ''}
    try:
        value = read()
        if value is None:
            value = build(url)
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'saved': time.time(), 'preview': value}))
            temporary.replace(path)
            prune(folder)
        return value
    finally:
        LOCK.release()
