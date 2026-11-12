#!/usr/bin/env python3
"""recon.py OWNER/REPO [--ocr] [--no-github] — read-only inventory before an open-source cleanup.

Writes $CHOS_WORK/recon/<repo>.md and prints its summary. Changes nothing anywhere.

The report quotes the matched text so the rules can be written from it. It is LOCAL ONLY: never
paste it, or any matched value, into a pull request, issue, commit message, release note or chat.

  history    every version of every text file that ever existed (all branches, tags, pull
             request refs — merge resolutions included), commit messages, author and committer
             lines, tag messages, ref names, path names
  patterns   $CHOS_WORK/config/patterns.txt (the forbidden list, one regex per line), optional
             config/repo-patterns.txt — and built-in leak classes: home paths, e-mail addresses
             outside example domains, private and CGNAT addresses, tailnet / .internal / .local
             hosts, chat workspace ids, token shapes, private keys
  media      every image / video / PDF blob in history; --ocr reads them (tesseract, ffmpeg) and
             matches the same patterns against the text in the frames
  workflows  pull_request_target, self-hosted runners reachable from fork pull requests, secrets
             handed to jobs fork pull requests trigger, missing top-level permissions
  github     visibility, license, forks, Actions secret and variable names, and the text and
             release assets no git rewrite reaches: pull request and issue bodies and comments,
             review comments, commit comments, release notes, release asset contents
"""
import io, json, os, pathlib, re, shutil, subprocess, sys, tarfile, tempfile, zipfile
from collections import Counter, defaultdict

if len(sys.argv) < 2 or '/' not in sys.argv[1]:
    sys.exit('usage: recon.py OWNER/REPO [--ocr] [--no-github]')
slug = sys.argv[1]
repo = slug.split('/', 1)[1]
ocr = '--ocr' in sys.argv
github = '--no-github' not in sys.argv
work = pathlib.Path(os.environ.get('CHOS_WORK') or sys.exit('recon.py: set CHOS_WORK to the run folder')).resolve()
url = os.environ.get('CHOS_URL') or f'https://github.com/{slug}.git'
rdir = work / 'recon'
rdir.mkdir(parents=True, exist_ok=True)
mirror = rdir / f'{repo}.git'


def run(*a, cwd=None, check=True, binary=False):
    r = subprocess.run(list(a), cwd=cwd, capture_output=True, text=not binary, errors=None if binary else 'replace')
    if check and r.returncode:
        raise RuntimeError(f"{' '.join(a[:3])}…: {r.stderr if not binary else r.stderr.decode(errors='replace')}")
    return r.stdout


def git(*a, check=True, binary=False):
    return run('git', '-C', str(mirror), *a, check=check, binary=binary)


def patterns(name):
    p = work / 'config' / name
    return [l.strip() for l in p.read_text().splitlines() if l.strip() and not l.startswith('#')] if p.is_file() else []


# The forbidden lists are POSIX extended regexes — the dialect the gate's `grep -E` reads. Bracket
# classes such as [[:alpha:]] mean something else to Python's re; translate them so both agree.
POSIX_CLASSES = {'alpha': 'a-zA-Z', 'digit': '0-9', 'alnum': 'a-zA-Z0-9', 'upper': 'A-Z', 'lower': 'a-z',
                 'space': r'\s', 'blank': r' \t', 'xdigit': '0-9A-Fa-f', 'punct': r'!-/:-@\[-`{-~',
                 'cntrl': r'\x00-\x1f\x7f', 'print': r'\x20-\x7e', 'graph': r'\x21-\x7e'}


def ere(p):
    return re.sub(r'\[:([a-z]+):\]', lambda m: POSIX_CLASSES.get(m.group(1), m.group(0)), p)


forbidden = patterns('patterns.txt') + patterns('repo-patterns.txt')
CLASSES = {
    # re.M: ^ and $ anchor at every line, as in the gate's line-by-line grep
    'forbidden list': re.compile('|'.join(ere(p) for p in forbidden), re.I | re.M) if forbidden else None,
    'home path': re.compile(r'(/Users|/home)/(?!(runner|operator|ci|user|me|you|example|name|username|USER|\$USER|\{USER\})\b)[A-Za-z0-9._-]{2,}'),
    'e-mail': re.compile(r'\b[A-Za-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost|users\.noreply\.github\.com|noreply\.github\.com)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', re.I),
    'private address': re.compile(r'\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b'),
    'cgnat/tailnet address': re.compile(r'\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b'),
    'internal host': re.compile(r'\b[A-Za-z0-9-]+\.(?:[A-Za-z0-9-]+\.)*(?:ts\.net|internal|corp|lan|local|intranet)\b', re.I),
    'chat workspace id': re.compile(r'\b[UTCWG]0[A-Z0-9]{8,10}\b'),
    'token shape': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b'),
    'private key': re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
}
CLASSES = {k: v for k, v in CLASSES.items() if v is not None}
# config/allow.txt: one regex per line for matches already judged harmless in this repository
# (test fixtures, code identifiers); the forbidden list is never filtered by it.
ALLOW = [re.compile(l) for l in patterns('allow.txt')]
hits = defaultdict(Counter)       # class -> Counter(matched text)
where = defaultdict(set)          # class -> {location}
incomplete = []                   # reads that failed: the report then proves nothing clean


def scan(text, loc):
    for k, rx in CLASSES.items():
        for m in rx.finditer(text):
            if k != 'forbidden list' and any(a.search(m.group(0)) for a in ALLOW):
                continue
            hits[k][m.group(0)] += 1
            if len(where[k]) < 400:
                where[k].add(loc)


# ---- history -------------------------------------------------------------------------------
if mirror.exists():
    shutil.move(str(mirror), str(rdir / f'{repo}.git.old-{os.getpid()}'))
run('git', 'clone', '-q', '--mirror', url, str(mirror))
heads = git('for-each-ref', '--format=%(refname)', 'refs/heads').split()
tags = git('for-each-ref', '--format=%(refname)', 'refs/tags').split()
pulls = git('for-each-ref', '--format=%(refname)', 'refs/pull/*/head').split()
commits = git('rev-list', '--all').split()
# Every blob ever reachable, not `log -p` additions: those omit merge commits, so a value added
# while resolving a conflict (and removed later) would never be seen.
first_path = {}
for l in git('rev-list', '--objects', '--all').splitlines():
    oid, _, p = l.partition(' ')
    if p:
        first_path.setdefault(oid, p)
check = subprocess.run(['git', '-C', str(mirror), 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
                       input='\n'.join(first_path) + '\n', capture_output=True, text=True).stdout.split('\n')
MEDIA = re.compile(r'\.(png|jpe?g|gif|webp|bmp|tiff?|mp4|mov|webm|mkv|pdf)$', re.I)
MAX_BLOB = int(os.environ.get('CHOS_MAX_BLOB') or 200_000_000)
BATCH = min(20_000_000, MAX_BLOB + 1)   # blobs read 400 at a time; larger ones one by one
sized = [(f[0], int(f[2])) for f in (l.split() for l in check) if len(f) == 3 and f[1] == 'blob']
blobs = [o for o, n in sized if n < BATCH]
for oid, n in sized:
    if n < BATCH:
        continue
    if n > MAX_BLOB:
        # Media goes through OCR below; any other file this large is unread, not clean.
        if not MEDIA.search(first_path[oid]):
            incomplete.append(f'history: {first_path[oid]} (blob {oid[:10]}, {n} bytes) is over CHOS_MAX_BLOB and was not scanned')
        continue
    data = git('cat-file', 'blob', oid, binary=True)
    scan(data.decode('latin-1') if b'\0' in data[:8000] else data.decode('utf-8', 'replace'), f'{first_path[oid]} (blob {oid[:10]})')
# Batches bounded by bytes, not count: a few highly compressible blobs can be gigabytes inflated.
size_of = dict(sized)
chunks, cur, total = [], [], 0
for oid in blobs:
    if cur and total + size_of[oid] > 64_000_000:
        chunks.append(cur); cur, total = [], 0
    cur.append(oid); total += size_of[oid]
if cur:
    chunks.append(cur)


def text_of(data):
    # A binary is read byte for byte (latin-1), as the gate's `grep -a` reads it; media is OCR'd too.
    return data.decode('latin-1') if b'\0' in data[:8000] else data.decode('utf-8', 'replace')


for chunk in chunks:
    out = subprocess.run(['git', '-C', str(mirror), 'cat-file', '--batch'], input=('\n'.join(chunk) + '\n').encode(),
                         capture_output=True).stdout
    pos = 0
    for oid in chunk:
        nl = out.index(b'\n', pos)
        size = int(out[pos:nl].split()[2])
        data = out[nl + 1:nl + 1 + size]
        pos = nl + 1 + size + 1
        scan(text_of(data), f'{first_path[oid]} (blob {oid[:10]})')
for c, body in zip(commits, git('log', '--all', '--format=%B%x00').split('\0')):
    scan(body, 'commit messages')
idents = Counter(git('log', '--all', '--format=%an <%ae>%n%cn <%ce>').splitlines())
for i in idents:
    scan(i, 'author/committer lines')
for t in git('for-each-ref', '--format=%(refname) %(taggername) %(taggeremail) %(contents)', 'refs/tags').splitlines():
    scan(t, 'tags')
for r in git('for-each-ref', '--format=%(refname)').split():
    scan(r, 'ref names')
blob_paths = defaultdict(set)
raw = git('log', '--all', '--format=', '--raw', '-m', '--no-renames', '--no-abbrev', '-z').split('\0')
for i in range(0, len(raw) - 1):
    if raw[i].startswith(':'):
        f = raw[i].split()
        if len(f) >= 5:
            blob_paths[f[3]].add(raw[i + 1])
paths = set(p for ps in blob_paths.values() for p in ps)
paths |= set(l.split(' ', 1)[1] for l in git('rev-list', '--objects', '--all').splitlines() if ' ' in l)
for p in paths:
    scan(p, 'path names')

# ---- media ---------------------------------------------------------------------------------
media = {}
for l in git('rev-list', '--objects', '--all').splitlines():
    if ' ' in l and MEDIA.search(l.split(' ', 1)[1]):
        media.setdefault(l.split(' ', 1)[0], l.split(' ', 1)[1])
for blob, ps in blob_paths.items():
    for p in sorted(ps):
        if MEDIA.search(p) and blob != '0' * 40:
            media.setdefault(blob, p)
VIDEO = ('.gif', '.mp4', '.mov', '.webm', '.mkv')


def tool(*a, text=True):
    """Run a tool; None when it is missing or fails."""
    if not shutil.which(a[0]):
        return None
    r = subprocess.run(list(a), capture_output=True, text=text, errors='replace' if text else None)
    return None if r.returncode else r


def ocr_media(data, name, label):
    """Text shown in an image, video or PDF, or None (recorded as incomplete) when it cannot be read.
    A PDF is read twice: its text layer, and every page rasterised for OCR — an image-only page has no
    text layer."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='chos-ocr-'))
    try:
        f = tmp / ('m' + pathlib.Path(name).suffix.lower())
        f.write_bytes(data)
        frames, text = [f], ''
        if f.suffix in VIDEO:
            r = tool('ffmpeg', '-loglevel', 'error', '-i', str(f), '-vf', 'fps=1', str(tmp / 'f%04d.png'))
            frames = sorted(tmp.glob('f*.png'))
            if r is None or not frames:
                incomplete.append(f'{label}: frames could not be extracted (ffmpeg)')
                return None
        elif f.suffix == '.pdf':
            r = tool('pdftotext', str(f), '-')
            pages = tool('pdftoppm', '-r', '150', '-png', str(f), str(tmp / 'page'))
            frames = sorted(tmp.glob('page*.png'))
            if r is None or pages is None or not frames:
                incomplete.append(f'{label}: PDF text or pages could not be extracted (pdftotext, pdftoppm)')
                return None
            text = r.stdout + '\n'
        bad = 0
        for fr in frames:
            r = tool('tesseract', str(fr), '-')
            if r is None:
                bad += 1
            else:
                text += r.stdout + '\n'
        if bad:
            incomplete.append(f'{label}: {bad} of {len(frames)} frame(s) or page(s) could not be read (tesseract)')
            return None
        return text
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


ocr_hits = {}
if media and not ocr:
    incomplete.append(f'media: {len(media)} image/video/PDF blob(s) in history were not OCR-read (rerun with --ocr)')
if ocr:
    for blob, p in media.items():
        label = f'media {blob[:10]} {p}'
        text = ocr_media(git('cat-file', 'blob', blob, binary=True), p, label)
        if text is None:
            continue
        before = sum(sum(c.values()) for c in hits.values())
        scan(text, label)
        n = sum(sum(c.values()) for c in hits.values()) - before
        if n:
            ocr_hits[f'{blob[:10]} {p}'] = n

# ---- workflows -----------------------------------------------------------------------------
wf_notes = []
default = git('symbolic-ref', '--short', 'HEAD', check=False).strip() or 'main'
for p in git('ls-tree', '--name-only', f'{default}:.github/workflows', check=False).split():
    y = git('show', f'{default}:.github/workflows/{p}', check=False)
    if 'pull_request_target' in y:
        wf_notes.append(f'{p}: pull_request_target — runs with secrets on fork pull requests; check what it checks out')
    if re.search(r'runs-on:.*self-hosted', y) and re.search(r'^\s*pull_request:?\s*$|pull_request\b', y, re.M):
        wf_notes.append(f'{p}: self-hosted runner on a pull_request trigger — guard jobs to same-repo pull requests')
    if 'secrets.' in y and 'pull_request' in y and 'head.repo.full_name' not in y:
        wf_notes.append(f'{p}: secrets in a workflow fork pull requests trigger, without a same-repo guard')
    if not re.search(r'^permissions:', y, re.M):
        wf_notes.append(f'{p}: no top-level permissions block (token defaults apply)')

# ---- release asset unpacking ---------------------------------------------------------------------
MAX_EXPANDED = int(os.environ.get('CHOS_MAX_EXPANDED') or 1_000_000_000)
UNREADABLE = ((b'\x28\xb5\x2f\xfd', 'zstd'), (b'\x37\x7a\xbc\xaf\x27\x1c', '7z'), (b'Rar!', 'rar'),
              (b'!<arch>', 'ar (deb)'), (b'xar!', 'xar (pkg)'), (b'MSCF', 'cab'))


def unpack(name, data, where_, depth=0, budget=None):
    """[(name, bytes)] an asset holds, by content not by file name: zip, tar (any compression), single
    gzip/bz2/xz streams, nested once more. A format this cannot open (zstd, 7z, rar, deb, pkg, cab) or an
    expansion past CHOS_MAX_EXPANDED returns None and marks the recon incomplete."""
    import bz2, gzip, lzma
    budget = budget if budget is not None else [MAX_EXPANDED]
    for magic, kind in UNREADABLE:
        if data.startswith(magic):
            incomplete.append(f'github: {where_} {name} is {kind}, which recon cannot open — not examined')
            return None
    out = []
    try:
        if data.startswith(b'PK\x03\x04'):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    scan(info.filename, f'{where_} (member path)')
                    if info.is_dir():
                        continue
                    budget[0] -= info.file_size
                    if budget[0] < 0:
                        raise OverflowError
                    out.append((info.filename, zf.read(info)))
        else:
            try:
                tf = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
            except tarfile.TarError:
                tf = None
            if tf is not None:
                with tf:
                    for m in tf.getmembers():
                        scan(m.name, f'{where_} (member path)')
                        if m.issym() or m.islnk():
                            scan(m.linkname, f'{where_} (link target)')
                        if not m.isfile():
                            continue
                        budget[0] -= m.size
                        if budget[0] < 0:
                            raise OverflowError
                        out.append((m.name, tf.extractfile(m).read()))
            else:
                single = {b'\x1f\x8b': gzip.decompress, b'BZh': bz2.decompress, b'\xfd7zXZ\x00': lzma.decompress}
                fn = next((f for m, f in single.items() if data.startswith(m)), None)
                if fn is None:
                    return [(name, data)]
                inner = fn(data)
                budget[0] -= len(inner)
                if budget[0] < 0:
                    raise OverflowError
                if depth >= 2:
                    return [(name, inner)]
                return unpack(name.rsplit('.', 1)[0], inner, where_, depth + 1, budget)
    except OverflowError:
        incomplete.append(f'github: {where_} expands past CHOS_MAX_EXPANDED — not fully examined')
        return None
    except Exception as e:
        incomplete.append(f'github: {where_} could not be unpacked ({e})')
        return None
    if depth < 2:
        nested = []
        for n, d in out:
            if d[:4] == b'PK\x03\x04' or d[:2] == b'\x1f\x8b' or d[:3] == b'BZh' or d[:6] == b'\xfd7zXZ\x00':
                inner = unpack(n, d, where_, depth + 1, budget)
                if inner is None:
                    return None
                nested += inner
            else:
                nested.append((n, d))
        out = nested
    return out


# ---- GitHub side ---------------------------------------------------------------------------
gh = {}
if github and not shutil.which('gh'):
    incomplete.append('github: gh is not installed (run with --no-github to skip the GitHub side on purpose)')
if github and shutil.which('gh'):
    def ghj(*a):
        r = subprocess.run(['gh', *a], capture_output=True, text=True)
        if r.returncode:
            incomplete.append(f"github: gh {' '.join(a[:2])} failed: {r.stderr.strip()[:200]}")
            return None
        return json.loads(r.stdout) if r.stdout.strip() else None

    def ghpages(path):
        # --paginate prints one JSON document per page; --slurp wraps them in one array.
        pages = ghj('api', path, '--paginate', '--slurp') or []
        return [x for page in pages for x in (page if isinstance(page, list) else [page])]
    gh['repo'] = ghj('repo', 'view', slug, '--json', 'visibility,licenseInfo,forkCount,isFork')
    gh['forks'] = [f['full_name'] for f in ghpages(f'repos/{slug}/forks')]
    gh['secrets'] = [s['name'] for s in ((ghj('api', f'repos/{slug}/actions/secrets') or {}).get('secrets') or [])]
    gh['variables'] = [s['name'] for s in ((ghj('api', f'repos/{slug}/actions/variables') or {}).get('variables') or [])]
    prs = []
    for kind, path in (('issue/PR', 'issues?state=all&per_page=100'), ('issue/PR comment', 'issues/comments?per_page=100'),
                       ('review comment', 'pulls/comments?per_page=100'), ('commit comment', 'comments?per_page=100'),
                       ('release', 'releases?per_page=100')):
        for item in ghpages(f'repos/{slug}/{path}'):
            scan(' '.join(str(item.get(k) or '') for k in ('title', 'name', 'body')), f'github {kind} {item.get("number") or item.get("id")}')
            if kind == 'issue/PR' and 'pull_request' in item:
                prs.append(item['number'])
    # A submitted review's own body is not a review comment: read each pull request's reviews.
    for n in prs:
        for rv in ghpages(f'repos/{slug}/pulls/{n}/reviews?per_page=100'):
            scan(str(rv.get('body') or ''), f'github review on #{n} ({rv.get("id")})')
    gh['assets'] = 0
    for rel in ghpages(f'repos/{slug}/releases'):
        for a in rel.get('assets') or []:
            gh['assets'] += 1
            r = subprocess.run(['gh', 'api', '-H', 'Accept: application/octet-stream', f'repos/{slug}/releases/assets/{a["id"]}'], capture_output=True)
            if r.returncode:
                incomplete.append(f'github: release asset {rel["tag_name"]}/{a["name"]} could not be downloaded')
                continue
            data, where_ = r.stdout, f'release asset {rel["tag_name"]}/{a["name"]}'
            scan(a['name'], f'{where_} (name)')
            parts = unpack(a['name'], data, where_)
            if parts is None:
                continue
            for pname, pdata in parts:
                if MEDIA.search(pname):
                    if not ocr:
                        incomplete.append(f'github: {where_} {pname} is media and was not OCR-read (rerun with --ocr)')
                        continue
                    t = ocr_media(pdata, pname, f'{where_} {pname}')
                    if t is not None:
                        scan(t, f'{where_} {pname} (OCR)')
                else:
                    scan(pdata.decode('latin-1') if b'\0' in pdata[:8000] else pdata.decode('utf-8', 'replace'), where_)

# ---- report --------------------------------------------------------------------------------
L = [f'# recon {slug} — LOCAL ONLY (quotes matched text; never paste it into a PR, issue, commit or chat)', '',
     f'- refs: {len(heads)} branches, {len(tags)} tags, {len(pulls)} pull request heads; {len(commits)} commits',
     f'- identities ({len(idents)}): ' + ', '.join(sorted({i.split("<")[-1].rstrip(">").split("@")[-1] for i in idents})),
     f'- media blobs in history: {len(media)}' + (f' (OCR hits in {len(ocr_hits)})' if ocr else ' (not OCR-read; rerun with --ocr)'), '']
L.append('## Hits by class')
for k in CLASSES:
    total = sum(hits[k].values())
    L.append(f'- **{k}**: {total} match(es), {len(hits[k])} distinct')
    for v, n in hits[k].most_common(25):
        L.append(f'    - `{v}` ×{n}')
    for w in sorted(where[k])[:15]:
        L.append(f'    - at {w}')
if ocr_hits:
    L += ['', '## Media with OCR hits'] + [f'- {k}: {n}' for k, n in ocr_hits.items()]
L += ['', '## Workflow hazards'] + ([f'- {n}' for n in wf_notes] or ['- none found'])
if gh:
    L += ['', '## GitHub', f'- repo: {json.dumps(gh.get("repo"))}', f'- forks: {gh.get("forks")}',
          f'- Actions secrets: {gh.get("secrets")}', f'- Actions variables: {gh.get("variables")}',
          f'- release assets scanned: {gh.get("assets")}']
if incomplete:
    L += ['', f'## INCOMPLETE — {len(incomplete)} read(s) failed; this report does not prove anything clean'] + \
         [f'- {x}' for x in incomplete]
(rdir / f'{repo}.md').write_text('\n'.join(L) + '\n')
print('\n'.join(l for l in L if not l.startswith('    - ')))
print(f'\nfull report (local only): {rdir / (repo + ".md")}')
sys.exit(3 if incomplete else 0)
