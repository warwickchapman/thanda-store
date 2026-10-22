#!/usr/bin/env python3
"""Bounded, resumable private Enertec catalogue research. Never writes to the store.

An initial manual run has a hard ceiling of 900 HTTP requests including robots,
redirects and one retry per transient failure. No scheduled or customer-triggered
requests are made. A single worker waits >=1 second between request starts per
host. Cached responses and the cumulative budget survive restarts. A 429 saves
Retry-After and stops; rerunning early is rejected. Public HTML is capped at 5MB,
PDFs at 15MB, images at 10MB. The output directory must stay outside public/.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from html.parser import HTMLParser
from urllib import error, parse, request, robotparser
from email.utils import parsedate_to_datetime

APPROVED_HOSTS = frozenset({'enertec.co.za', 'www.enertec.co.za', 'ctek.com', 'www.ctek.com', 'forbatt.co.za', 'www.forbatt.co.za'})
BASE = 'https://enertec.co.za'
USER_AGENT = 'ThandaCatalogueResearch/1.0 (+https://store.thanda.solar)'
LIMITS = {'html': 5 * 1024 * 1024, 'pdf': 15 * 1024 * 1024, 'image': 10 * 1024 * 1024, 'robots': 512 * 1024}
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
CODE_RE = re.compile(r'\b\d{2}(?:[A-Z]{3,8}|EV|P)[A-Z0-9/-]*-[A-Z0-9/-]+\b', re.I)


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def normalized_code(value):
    return str(value or '').strip().upper()


def safe_url(url, base=BASE):
    resolved = parse.urljoin(base, url.strip())
    parts = parse.urlsplit(resolved)
    if parts.scheme != 'https' or parts.hostname not in APPROVED_HOSTS or parts.username or parts.password or parts.port not in (None, 443):
        raise ValueError('URL must use HTTPS on an approved manufacturer host')
    return parse.urlunsplit((parts.scheme, parts.netloc.lower(), parts.path, parts.query, ''))


class Node:
    def __init__(self, tag='', attrs=None):
        self.tag, self.attrs, self.children = tag, dict(attrs or []), []

    def find_all(self, pred):
        result = [self] if pred(self) else []
        for child in self.children:
            if isinstance(child, Node):
                result.extend(child.find_all(pred))
        return result

    def by_id(self, value):
        nodes = self.find_all(lambda n: n.attrs.get('id') == value)
        return nodes[0] if nodes else None

    def text(self):
        if self.tag in {'script', 'style'}:
            return ''
        value = ' '.join(c.text() if isinstance(c, Node) else c for c in self.children)
        return re.sub(r'\s+', ' ', value).strip()


class Document(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def listing_urls(html, base):
    doc = Document(html).root
    urls, pages = set(), set()
    for anchor in doc.find_all(lambda n: n.tag == 'a' and 'href' in n.attrs):
        try:
            url = safe_url(anchor.attrs['href'], base)
        except ValueError:
            continue
        parts = parse.urlsplit(url)
        if parts.hostname not in {'enertec.co.za', 'www.enertec.co.za'}:
            continue
        if parts.path.startswith('/products/') and parts.path.endswith('.html'):
            urls.add(url)
        elif parts.path.rstrip('/') == '/products' and 'pg=' in parts.query:
            pages.add(url)
    return sorted(urls), sorted(pages)


def full_codes(value):
    return sorted({code.upper().rstrip('-/') for code in CODE_RE.findall(parse.unquote(value))})


def parse_product(html, url):
    doc = Document(html).root
    code_node = doc.by_id('ppvc-r-code')
    code = normalized_code(code_node.text() if code_node else '')
    title_node = doc.by_id('ppvc-r-title')
    title = title_node.text() if title_node else ''
    description_node = doc.by_id('ppvc-r-description')
    contents = description_node.find_all(lambda n: 'accordion-content-wrapper' in n.attrs.get('class', '').split()) if description_node else []
    description = contents[0].text() if contents else ''
    tech_node = doc.by_id('tech-grid')
    technical = {}
    if tech_node:
        for node in tech_node.find_all(lambda n: n.tag == 'p'):
            text = node.text()
            if ':' in text:
                label, value = text.split(':', 1)
                if label.strip() and value.strip():
                    technical[label.strip()] = value.strip()
    image_node = doc.by_id('ppvc-l-image')
    images, documents, rejected = [], [], []
    for node in image_node.find_all(lambda n: n.tag == 'img' and n.attrs.get('src')) if image_node else []:
        try:
            img = safe_url(node.attrs.get('src', ''), url)
            if img not in images:
                images.append(img)
        except ValueError:
            rejected.append({'kind': 'image', 'url': node.attrs.get('src', ''), 'reason': 'unapproved URL'})
    for section_id, kind in [('ppvc-r-specs', 'datasheet'), ('ppvc-r-user-manual', 'manual')]:
        section = doc.by_id(section_id)
        for node in section.find_all(lambda n: n.tag == 'a' and n.attrs.get('href')) if section else []:
            raw = node.attrs['href']
            try:
                href = safe_url(raw, url)
                if not parse.urlsplit(href).path.lower().endswith('.pdf'):
                    rejected.append({'kind': kind, 'url': href, 'reason': 'not a PDF URL'})
                    continue
                label = node.text()
                if not any(item['url'] == href for item in documents):
                    documents.append({'url': href, 'kind': kind, 'title': label or kind.title()})
            except ValueError:
                rejected.append({'kind': kind, 'url': raw, 'reason': 'unapproved URL'})
    issues = []
    for context, value in [('page URL', url), ('page title', title)] + [('document label', d['title']) for d in documents] + [('document filename', d['url']) for d in documents] + [('image filename', im) for im in images]:
        others = [found for found in full_codes(value) if found != code]
        if code and others:
            issues.append({'type': 'conflicting-stock-code', 'context': context, 'pageCode': code, 'otherCodes': others, 'value': value})
    for document in documents:
        filename = parse.urlsplit(document['url']).path.lower()
        if document['kind'] == 'manual' and any(token in filename for token in ('spec-sheet', 'spec_sheet', 'datasheet')):
            issues.append({'type': 'manual-links-to-specification', 'url': document['url']})
    if len(documents) > 4:
        issues.append({'type': 'document-limit', 'count': len(documents), 'kept': 4})
    return {'sku': code, 'url': url, 'title': title, 'description': description, 'technicalData': technical, 'imageUrls': images[:1], 'documents': documents[:4], 'rejectedResources': rejected, 'issues': issues, 'observedAt': utcnow()}


class StopMining(RuntimeError):
    pass


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Fetcher:
    def __init__(self, output, max_requests=900):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        os.chmod(self.output, 0o700)
        self.cache = self.output / 'cache'
        self.cache.mkdir(exist_ok=True)
        self.path = self.output / 'http-state.json'
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {'requests': 0, 'responses': {}, 'robots': {}, 'nextAllowedAt': {}, 'ledger': []}
        self.max_requests = min(max_requests, 900)
        self.last_started = {}
        self.opener = request.build_opener(NoRedirect())

    def save(self):
        write_json(self.path, self.state)

    def robots_allowed(self, url):
        origin = parse.urlunsplit(parse.urlsplit(url)[:2] + ('', '', ''))
        if origin not in self.state['robots']:
            try:
                data, _ = self.get(origin + '/robots.txt', 'robots', check_robots=False)
                rules = data.decode('utf-8', 'replace')
            except StopMining:
                raise
            except Exception as exc:
                # A missing robots file permits crawling; an unavailable file does not.
                if isinstance(exc, error.HTTPError) and exc.code == 404:
                    rules = ''
                else:
                    raise StopMining(f'Cannot establish robots policy for {origin}: {exc}') from exc
            self.state['robots'][origin] = rules
            self.save()
        parser = robotparser.RobotFileParser()
        parser.parse(self.state['robots'][origin].splitlines())
        return parser.can_fetch(USER_AGENT, url), max(1.0, float(parser.crawl_delay(USER_AGENT) or 1))

    def get(self, url, kind, check_robots=True, redirects=0):
        url = safe_url(url)
        allowed, delay = self.robots_allowed(url) if check_robots else (True, 1.0)
        if not allowed:
            raise ValueError('robots.txt prohibits this URL')
        prior = self.state['responses'].get(url)
        if prior and prior.get('file'):
            file = self.output / prior['file']
            if file.exists() and hashlib.sha256(file.read_bytes()).hexdigest() == prior['sha256']:
                return file.read_bytes(), prior
        if prior and prior.get('permanentError'):
            raise ValueError(prior['permanentError'])
        host = parse.urlsplit(url).hostname
        deadline = self.state['nextAllowedAt'].get(host, 0)
        if time.time() < deadline:
            raise StopMining(f'Host Retry-After has not elapsed; resume after {dt.datetime.fromtimestamp(deadline, dt.timezone.utc).isoformat()}')
        limit = LIMITS[kind]
        for attempt in range(2):
            if self.state['requests'] >= self.max_requests:
                raise StopMining(f'Cumulative HTTP budget reached ({self.state["requests"]}/{self.max_requests})')
            previous_wall = self.state.setdefault('lastRequestAt', {}).get(host, 0)
            time.sleep(max(0, self.last_started.get(host, 0) + delay - time.monotonic(), previous_wall + delay - time.time()))
            self.last_started[host] = time.monotonic()
            self.state['lastRequestAt'][host] = time.time()
            self.state['requests'] += 1
            entry = {'url': url, 'kind': kind, 'startedAt': utcnow()}
            self.state['ledger'].append(entry)
            self.save()
            try:
                req = request.Request(parse.quote(url, safe=':/?=&%+()@,;~!*\''), headers={'User-Agent': USER_AGENT, 'Accept': '*/*'})
                with self.opener.open(req, timeout=20) as response:
                    content_type = response.headers.get_content_type()
                    announced = int(response.headers.get('Content-Length') or 0)
                    if announced > limit:
                        raise ValueError(f'{kind} exceeds byte limit')
                    data = response.read(limit + 1)
                    if len(data) > limit:
                        raise ValueError(f'{kind} exceeds byte limit')
                    if kind == 'pdf' and not data.startswith(b'%PDF-'):
                        raise ValueError('Response is not a PDF')
                    if kind == 'image' and not (data.startswith(b'\x89PNG\r\n\x1a\n') or data.startswith(b'\xff\xd8\xff') or data.startswith((b'GIF87a', b'GIF89a')) or (data.startswith(b'RIFF') and data[8:12] == b'WEBP')):
                        raise ValueError('Unsupported or invalid raster image')
                    digest = hashlib.sha256(data).hexdigest()
                    extension = {'pdf': '.pdf', 'html': '.html', 'robots': '.txt'}.get(kind) or { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }.get(content_type, '.image')
                    dest = self.cache / (digest + extension)
                    dest.write_bytes(data)
                    os.chmod(dest, 0o600)
                    metadata = {'url': url, 'file': str(dest.relative_to(self.output)), 'sha256': digest, 'bytes': len(data), 'contentType': content_type, 'fetchedAt': utcnow()}
                    self.state['responses'][url] = metadata
                    entry.update({'status': response.status, 'bytes': len(data), 'contentType': content_type})
                    self.save()
                    return data, metadata
            except error.HTTPError as exc:
                exc.close()
                entry['status'] = exc.code
                if exc.code in (301, 302, 303, 307, 308) and exc.headers.get('Location'):
                    if redirects >= 3:
                        raise ValueError('Redirect limit reached') from exc
                    target = safe_url(exc.headers['Location'], url)
                    self.save()
                    data, metadata = self.get(target, kind, check_robots, redirects + 1)
                    self.state['responses'][url] = metadata
                    self.save()
                    return data, metadata
                if exc.code == 429:
                    raw = exc.headers.get('Retry-After')
                    try:
                        wait_until = time.time() + max(0, float(raw))
                    except (TypeError, ValueError):
                        try:
                            wait_until = parsedate_to_datetime(raw).timestamp()
                        except (TypeError, ValueError):
                            wait_until = time.time() + 3600
                    self.state['nextAllowedAt'][host] = max(time.time(), wait_until)
                    entry['retryAfter'] = raw
                    self.save()
                    raise StopMining('HTTP 429; stopped and saved Retry-After') from exc
                if exc.code in (500, 502, 503, 504) and attempt == 0:
                    self.save()
                    continue
                if exc.code not in (500, 502, 503, 504):
                    self.state['responses'][url] = {'permanentError': f'HTTP {exc.code}'}
                self.save()
                raise
            except (error.URLError, TimeoutError) as exc:
                entry['error'] = str(exc)
                self.save()
                if attempt == 0:
                    continue
                raise
            except ValueError as exc:
                entry['error'] = str(exc)
                self.state['responses'][url] = {'permanentError': str(exc)}
                self.save()
                raise
        raise RuntimeError('Unexpected exhausted attempts')


def priority(url, rows):
    slug = parse.unquote(parse.urlsplit(url).path).lower()
    compact = re.sub(r'[^a-z0-9]', '', slug)
    score = 0
    for row in rows:
        sku = normalized_code(row['sku'])
        if re.sub(r'[^a-z0-9]', '', sku.lower()) in compact:
            score = max(score, 100)
        brand = str(row.get('brand', '')).lower()
        if len(brand) >= 4 and brand in slug:
            score = max(score, 20)
        # Candidate ranking changes scan order only. Identity always uses ppvc-r-code.
        for token in re.findall(r'[a-z]+\d+[a-z0-9-]*|\d+[a-z]+[a-z0-9-]*', str(row.get('name', '')).lower()):
            if len(token) >= 4 and token in slug:
                score = max(score, 10)
    return -score, url


def attach_asset(fetcher, url, kind):
    data, metadata = fetcher.get(url, kind)
    asset = dict(metadata)
    if kind == 'pdf' and shutil.which('pdftotext'):
        text_path = fetcher.output / (metadata['file'] + '.txt')
        if not text_path.exists():
            subprocess.run(['pdftotext', '-layout', str(fetcher.output / metadata['file']), str(text_path)], timeout=20, check=True, capture_output=True)
            os.chmod(text_path, 0o600)
        asset['textFile'] = str(text_path.relative_to(fetcher.output))
    return asset


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=os.environ.get('ENERTEC_SOURCE_FILE', str(Path(__file__).resolve().parents[1] / 'data/enertec-products.json')))
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--listing-url', default=BASE + '/products/?num_products=1000')
    parser.add_argument('--listing-file')
    parser.add_argument('--max-requests', type=int, default=900)
    parser.add_argument('--max-pages', type=int)
    parser.add_argument('--no-assets', action='store_true')
    parser.add_argument('--assets-only', action='store_true')
    args = parser.parse_args(argv)
    output = Path(args.output_dir).resolve()
    if 'public' in output.parts:
        parser.error('Private mining output must not be saved in public/')
    if args.max_requests < 1 or args.max_requests > 900:
        parser.error('--max-requests must be 1..900 (cumulative across resumes)')
    source = json.loads(Path(args.source).read_text())
    if not isinstance(source, list) or not source or any(not isinstance(row, dict) or not normalized_code(row.get('sku')) for row in source) or len({normalized_code(r.get('sku')) for r in source}) != len(source):
        parser.error('Source must be a nonempty array with unique full SKUs')
    wanted = {normalized_code(row['sku']): row for row in source}
    output.mkdir(parents=True, exist_ok=True)
    lock_file = (output / 'miner.lock').open('a')
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error('Another miner is already using this output directory')
    try:
        fetcher = Fetcher(output, args.max_requests)
        progress_path = output / 'progress.json'
        progress = json.loads(progress_path.read_text()) if progress_path.exists() else {'discoveredUrls': [], 'listingUrls': [], 'scanned': {}, 'errors': {}}
        report = {}

        def checkpoint(stopped=None):
            matches = {}
            other = []
            for product in progress['scanned'].values():
                if product.get('sku') in wanted:
                    matches.setdefault(product['sku'], []).append(product)
                else:
                    other.append({'sku': product.get('sku', ''), 'url': product['url'], 'title': product.get('title', '')})
            duplicates = {sku: pages for sku, pages in matches.items() if len(pages) > 1}
            matched = []
            for sku, pages in sorted(matches.items()):
                for page in pages:
                    matched.append(dict(page, matchStatus='duplicate-code' if sku in duplicates else 'exact-code'))
            report.update({'observedAt': utcnow(), 'sourceRows': len(wanted), 'discoveredPages': len(progress['discoveredUrls']), 'scannedPages': len(progress['scanned']), 'matchedSkus': len(matches), 'missingSkus': sorted(set(wanted) - set(matches)), 'duplicateSkus': sorted(duplicates), 'imagesDownloaded': sum(bool(p.get('imageAsset')) for p in matched), 'pdfsDownloaded': sum(len([d for d in p['documents'] if d.get('asset')]) for p in matched), 'issues': [{'sku': p['sku'], 'url': p['url'], **issue} for p in matched for issue in p['issues']], 'errors': progress['errors'], 'requestsUsed': fetcher.state['requests'], 'requestLimit': args.max_requests, 'stopped': stopped})
            write_json(progress_path, progress)
            write_json(output / 'matched-products.json', matched)
            write_json(output / 'unmatched-website-products.json', other)
            write_json(output / 'report.json', report)

        try:
            if not args.assets_only:
                # Restart from every previously discovered listing page, including
                # pages whose fetch was interrupted before its checkpoint.
                queue = [safe_url(args.listing_url)] + list(progress.get('pendingListingUrls', []))
                while queue:
                    url = queue.pop(0)
                    if url in progress['listingUrls']:
                        continue
                    if args.listing_file and url == safe_url(args.listing_url):
                        html = Path(args.listing_file).read_text()
                    else:
                        html = fetcher.get(url, 'html')[0].decode('utf-8', 'replace')
                    links, pages = listing_urls(html, url)
                    progress['discoveredUrls'] = sorted(set(progress['discoveredUrls']) | set(links))
                    progress['listingUrls'].append(url)
                    queue.extend(p for p in pages if p not in progress['listingUrls'] and p not in queue)
                    progress['pendingListingUrls'] = list(queue)
                    checkpoint()
                urls = sorted(progress['discoveredUrls'], key=lambda u: priority(u, source))
                scanned_now = 0
                for url in urls:
                    if url in progress['scanned'] or url in progress['errors']:
                        continue
                    if args.max_pages is not None and scanned_now >= args.max_pages:
                        break
                    try:
                        html = fetcher.get(url, 'html')[0].decode('utf-8', 'replace')
                        product = parse_product(html, url)
                        product['htmlAsset'] = fetcher.state['responses'][url]
                        progress['scanned'][url] = product
                        scanned_now += 1
                    except StopMining:
                        raise
                    except Exception as exc:
                        progress['errors'][url] = str(exc)
                    checkpoint()
                    if scanned_now % 20 == 0:
                        print(f"Scanned {len(progress['scanned'])}; matched {report['matchedSkus']}; requests {fetcher.state['requests']}", flush=True)
            if not args.no_assets:
                # Documents first: preserve source evidence before images when the budget is tight.
                pages = [p for p in progress['scanned'].values() if p.get('sku') in wanted]
                for product in pages:
                    for document in product['documents']:
                        if document.get('asset') or document.get('error'):
                            continue
                        try:
                            document['asset'] = attach_asset(fetcher, document['url'], 'pdf')
                        except StopMining:
                            raise
                        except Exception as exc:
                            document['error'] = str(exc)
                        checkpoint()
                for product in pages:
                    if not product.get('imageAsset') and product['imageUrls'] and not product.get('imageError'):
                        try:
                            product['imageAsset'] = attach_asset(fetcher, product['imageUrls'][0], 'image')
                        except StopMining:
                            raise
                        except Exception as exc:
                            product['imageError'] = str(exc)
                        checkpoint()
            checkpoint()
        except (StopMining, KeyboardInterrupt) as exc:
            checkpoint(str(exc) or 'Interrupted; safely resumable')
            print(json.dumps(report, indent=2))
            return 2
        print(json.dumps(report, indent=2))
        return 0

    finally:
        lock_file.close()


if __name__ == '__main__':
    raise SystemExit(main())
