import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from PIL import Image
import previews
from test_flow import app, db


class Previews(unittest.TestCase):
    def test_metadata_image_and_cache(self):
        photo = io.BytesIO()
        Image.new('RGB', (1200, 800), 'orange').save(photo, 'PNG')
        html = b'<title>fallback</title><meta property="og:title" content="Boat &amp; waves"><meta property="og:image" content="/photo.png"><meta name="description" content="A tiny boat">'
        with tempfile.TemporaryDirectory() as folder, patch('previews.fetch', side_effect=[(html, 'https://printables.com/model/1'), (photo.getvalue(), '')]) as fetch:
            first = previews.cached('https://printables.com/model/1', Path(folder))
            second = previews.cached('https://printables.com/model/1', Path(folder))
            self.assertEqual(first, second)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(first['title'], 'Boat & waves')
            self.assertEqual(first['platform'], 'Printables')
            self.assertTrue(first['image'])

    def test_unsupported_and_blocked_pages_fall_back(self):
        with patch('previews.fetch', side_effect=OSError('blocked')) as fetch:
            self.assertEqual(previews.build('https://example.com/model')['platform'], '')
            fetch.assert_not_called()
            self.assertEqual(previews.build('https://makerworld.com/en/models/1')['image'], '')
            self.assertEqual(fetch.call_count, 1)

    def test_reject_private_addresses_and_unsafe_urls(self):
        for url in ['http://printables.com/model/1', 'https://user:pass@printables.com/x', 'https://printables.com:444/x', 'https://printables.com.evil.test/x', 'https://printables.com/\nfoo']:
            with self.assertRaises(ValueError):
                previews.fetch(url, 100, pages=True)
        for ip in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']:
            with patch('previews.socket.getaddrinfo', return_value=[(2,1,6,'',(ip,443))]), patch('previews.socket.create_connection') as connect:
                with self.assertRaises(ValueError):
                    previews.fetch('https://printables.com/model/1', 100, pages=True)
                connect.assert_not_called()

    def test_connection_pins_public_ip_and_revalidates_redirect(self):
        conn = MagicMock()
        response = conn.getresponse.return_value
        response.status = 302
        response.getheader.return_value = 'https://127.0.0.1/image.png'
        with patch('previews.socket.getaddrinfo', side_effect=[[(2,1,6,'',('93.184.216.34',443))], [(2,1,6,'',('127.0.0.1',443))]]), patch('previews.socket.create_connection') as connect, patch('previews.http.client.HTTPSConnection', return_value=conn):
            with self.assertRaises(ValueError):
                previews.fetch('https://cdn.example.com/image.png', 100)
            connect.assert_called_once_with(('93.184.216.34',443), timeout=3)
            conn._context.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='cdn.example.com')
            conn.close.assert_called_once()

    def test_oversize_and_wrong_content_rejected(self):
        for headers, body in [({'Content-Type':'text/html','Content-Length':'101'},b''), ({'Content-Type':'text/html'},b'x'*101), ({'Content-Type':'application/json'},b'{}')]:
            conn=MagicMock();response=conn.getresponse.return_value;response.status=200
            response.getheader.side_effect=lambda key, default=None: headers.get(key,default)
            response.read1.side_effect=[body,b'']
            with patch('previews.socket.getaddrinfo',return_value=[(2,1,6,'',('93.184.216.34',443))]), patch('previews.socket.create_connection'), patch('previews.http.client.HTTPSConnection',return_value=conn):
                with self.assertRaises(ValueError):
                    previews.fetch('https://printables.com/model/1',100,pages=True)

    def test_preview_access_and_404_formats(self):
        client=app.test_client()
        self.assertEqual(client.get('/api/print-links/1/preview').status_code,401)
        page=client.get('/lost-at-sea')
        self.assertEqual(page.status_code,404)
        self.assertEqual(page.mimetype,'text/html')
        self.assertIn(b'Well, ship.',page.data)
        api=client.get('/api/missing')
        self.assertEqual(api.status_code,404)
        self.assertTrue(api.is_json)
        with db() as c:
            uid=c.execute("INSERT INTO users(name,password) VALUES('preview-tester','unused')").lastrowid
            rid=c.execute("INSERT INTO rounds(title,phase) VALUES('Preview round','completed')").lastrowid
            lid=c.execute('INSERT INTO print_links(round_id,user_id,title,url) VALUES(?,?,?,?)',(rid,uid,'Boat','https://printables.com/model/1')).lastrowid
        try:
            with client.session_transaction() as session: session.update(uid=uid,version=0)
            with patch('app.previews.cached',return_value={'platform':'Printables','title':'Boat','description':'','image':''}):
                self.assertEqual(client.get(f'/api/print-links/{lid}/preview').json['platform'],'Printables')
                self.assertEqual(client.get(f'/api/print-links/{lid}/image').status_code,404)
            self.assertEqual(client.get('/api/print-links/999999/preview').status_code,404)
        finally:
            with db() as c:
                c.execute('DELETE FROM print_links WHERE id=?',(lid,))
                c.execute('DELETE FROM rounds WHERE id=?',(rid,))
                c.execute('DELETE FROM users WHERE id=?',(uid,))

    def test_cache_prunes_oldest_to_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder)
            for n in range(3):
                (folder/f'{n}.json').write_text('x'*100)
            previews.prune(folder, budget=150)
            self.assertLessEqual(sum(p.stat().st_size for p in folder.glob('*.json')),150)
