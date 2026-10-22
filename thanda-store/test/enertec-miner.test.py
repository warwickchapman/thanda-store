"""Synthetic parsing, private cache, robots and resumability checks; no network."""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SPEC = importlib.util.spec_from_file_location('enertec_miner', Path(__file__).resolve().parents[1] / 'scripts/mine-enertec-products.py')
sys.dont_write_bytecode = True
miner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(miner)

PAGE = '''<div id="ppvc-l-image"><img src="/photo.png"></div>
<div id="ppvc-r-title"><h1>Example 12V 90Ah</h1></div>
<div id="ppvc-r-code"><p>11BAT-EXAMPLE-A</p></div>
<div id="ppvc-r-description"><div class="accordion-title-wrapper">DESCRIPTION</div>
<div class="product-accordian-content accordion-content-wrapper"><p>Clean &amp; safe.</p><ul><li>Details</li></ul></div></div>
<div id="tech-grid"><p><span>Length: </span>300mm</p><p><span>Weight: </span>12kg</p></div>
<div id="ppvc-r-specs"><p><a href="/11bat-example-b.pdf">11BAT-EXAMPLE-B Spec Sheet</a></p>
<a href="https://untrusted.invalid/file.pdf">Unapproved</a></div>
<div id="ppvc-r-user-manual"><a href="/example-spec-sheet.pdf">Download User Manual</a></div>'''


class Response:
    status = 200

    def __init__(self, data, content_type='text/html'):
        from email.message import Message
        self.data = data
        self.headers = Message()
        self.headers['Content-Type'] = content_type

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return self.data[:limit]


class MinerTest(unittest.TestCase):
    def test_exact_identity_and_section_scoped_resources(self):
        data = miner.parse_product(PAGE, 'https://enertec.co.za/products/example.html')
        self.assertEqual(data['sku'], '11BAT-EXAMPLE-A')
        self.assertEqual(data['description'], 'Clean & safe. Details')
        self.assertEqual(data['technicalData'], {'Length': '300mm', 'Weight': '12kg'})
        self.assertEqual(data['imageUrls'], ['https://enertec.co.za/photo.png'])
        self.assertEqual(len(data['documents']), 2)
        self.assertEqual(len(data['rejectedResources']), 1)
        self.assertTrue(any(issue['type'] == 'conflicting-stock-code' for issue in data['issues']))
        self.assertTrue(any(issue['type'] == 'manual-links-to-specification' for issue in data['issues']))

    def test_fullcode_keeps_punctuation_and_never_guesses_from_title(self):
        data = miner.parse_product('<h1>11BAT-EXAMPLE-A</h1>', 'https://enertec.co.za/products/example.html')
        self.assertEqual(data['sku'], '')
        self.assertNotEqual(miner.normalized_code('11BAT-EXAMPLE-A'), miner.normalized_code('11BATEXAMPLEA'))

    def test_listing_discovery_filters_other_hosts_and_paths(self):
        urls, pages = miner.listing_urls('''<a href="example.html">One</a>
          <a href="https://untrusted.invalid/products/example.html">Other</a>
          <a href="?num_products=24&pg=2">Next</a><a href="/about.html">About</a>''', 'https://enertec.co.za/products/')
        self.assertEqual(urls, ['https://enertec.co.za/products/example.html'])
        self.assertEqual(pages, ['https://enertec.co.za/products/?num_products=24&pg=2'])
        for bad in ('http://enertec.co.za/a', 'https://user:pass@enertec.co.za/a', 'https://enertec.co.za:4433/a'):
            with self.assertRaises(ValueError):
                miner.safe_url(bad)

    def test_robots_and_checksum_cache_survive_restart_without_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(miner.time, 'sleep'):
            fetcher = miner.Fetcher(directory, 3)
            with patch.object(fetcher.opener, 'open', side_effect=[Response(b'User-agent: *\nAllow: /\n', 'text/plain'), Response(b'<h1>Example</h1>')]) as opener:
                first, metadata = fetcher.get('https://enertec.co.za/products/example.html', 'html')
                self.assertEqual(opener.call_count, 2)
                self.assertEqual(fetcher.state['requests'], 2)
            resumed = miner.Fetcher(directory, 3)
            with patch.object(resumed.opener, 'open', side_effect=AssertionError('Network must not run')):
                cached, again = resumed.get('https://enertec.co.za/products/example.html', 'html')
            self.assertEqual(first, cached)
            self.assertEqual(metadata['sha256'], again['sha256'])
            self.assertEqual(resumed.state['requests'], 2)

    def test_robots_prohibition_fails_before_product_request(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(miner.time, 'sleep'):
            fetcher = miner.Fetcher(directory, 3)
            with patch.object(fetcher.opener, 'open', return_value=Response(b'User-agent: *\nDisallow: /products/\n', 'text/plain')) as opener:
                with self.assertRaisesRegex(ValueError, 'robots'):
                    fetcher.get('https://enertec.co.za/products/example.html', 'html')
                self.assertEqual(opener.call_count, 1)

    def test_429_stops_and_enforces_retry_after_across_resume(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(miner.time, 'sleep'):
            fetcher = miner.Fetcher(directory, 10)
            fetcher.state['robots']['https://enertec.co.za'] = 'User-agent: *\nAllow: /\n'
            failure = HTTPError('https://enertec.co.za/test', 429, 'Busy', {'Retry-After': '3600'}, None)
            with patch.object(fetcher.opener, 'open', side_effect=failure) as opener:
                with self.assertRaises(miner.StopMining):
                    fetcher.get('https://enertec.co.za/test', 'html')
                self.assertEqual(opener.call_count, 1)
            resumed = miner.Fetcher(directory, 10)
            with patch.object(resumed.opener, 'open', side_effect=AssertionError('Too early')):
                with self.assertRaisesRegex(miner.StopMining, 'Retry-After'):
                    resumed.get('https://enertec.co.za/test', 'html')
            self.assertEqual(resumed.state['requests'], 1)

    def test_cumulative_request_budget_stops_before_network(self):
        with tempfile.TemporaryDirectory() as directory:
            fetcher = miner.Fetcher(directory, 1)
            fetcher.state['requests'] = 1
            fetcher.state['robots']['https://enertec.co.za'] = 'User-agent: *\nAllow: /\n'
            fetcher.save()
            resumed = miner.Fetcher(directory, 1)
            with patch.object(resumed.opener, 'open', side_effect=AssertionError('No budget')):
                with self.assertRaisesRegex(miner.StopMining, 'budget'):
                    resumed.get('https://enertec.co.za/test', 'html')

    def test_transient_retry_is_bounded_to_one(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(miner.time, 'sleep'):
            fetcher = miner.Fetcher(directory, 10)
            fetcher.state['robots']['https://enertec.co.za'] = 'User-agent: *\nAllow: /\n'
            failure = HTTPError('https://enertec.co.za/test', 503, 'Busy', {}, None)
            with patch.object(fetcher.opener, 'open', side_effect=failure) as opener:
                with self.assertRaises(HTTPError):
                    fetcher.get('https://enertec.co.za/test', 'html')
                self.assertEqual(opener.call_count, 2)

    def test_product_checkpoint_resumes_without_scanning_completed_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            source = work / 'private-source.json'
            source.write_text(json.dumps([{'sku': '11BAT-EXAMPLE-A'}, {'sku': '11BAT-EXAMPLE-B'}]))
            listing = work / 'listing.html'
            listing.write_text('<a href="/products/example-a.html">A</a><a href="/products/example-b.html">B</a>')
            called = []

            def fake_get(fetcher, url, kind):
                called.append(url)
                letter = 'A' if 'example-a' in url else 'B'
                html = f'<div id="ppvc-r-code">11BAT-EXAMPLE-{letter}</div>'.encode()
                metadata = {'file': f'cache/example-{letter}.html'}
                fetcher.state['requests'] += 1
                fetcher.state['responses'][url] = metadata
                fetcher.save()
                return html, metadata

            args = ['--source', str(source), '--output-dir', str(work / 'output'), '--listing-file', str(listing), '--no-assets']
            with patch.object(miner.Fetcher, 'get', fake_get), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(miner.main(args + ['--max-pages', '1']), 0)
                self.assertEqual(len(called), 1)
                self.assertEqual(miner.main(args), 0)
            self.assertEqual(len(called), 2)
            self.assertEqual(len(set(called)), 2)
            report = json.loads((work / 'output/report.json').read_text())
            self.assertEqual(report['matchedSkus'], 2)
            self.assertEqual(report['requestsUsed'], 2)


if __name__ == '__main__':
    unittest.main()
