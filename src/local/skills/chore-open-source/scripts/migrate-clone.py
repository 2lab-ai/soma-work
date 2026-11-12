#!/usr/bin/env python3
"""migrate-clone.py OWNER/REPO CLONE [--check | --plan | --apply]

Moves an existing clone from the old history to the rewritten one that swap.sh pushed, so that
nobody has to re-clone and no local-only branch, worktree edit or stash is lost.

  --check  (default) report: refs still on the old history, and pattern hits in local-only
           commits. Exit 1 when anything is found.
  --plan   what --apply would do, changing nothing.
  --apply  backup -> fetch -> move -> report:
     backup    the whole .git copied to $CHOS_WORK/clone-backups/<repo>-<time>/ (copy-on-write
               where the filesystem allows), and every ref copied once to refs/pre-rewrite/*
               (git push never sends that namespace; restore a branch with
               `git branch -f <b> refs/pre-rewrite/heads/<b>`)
     fetch     objects from the local rewritten repo, then the clone's own remote (its refspecs)
     branches  commit the rewrite replaced          -> moved to the new id (commit map)
               already on the new history            -> left as is
               local-only commits on the old history -> rebuilt: every shared ancestor takes its
                 pushed id, every local commit is recreated with the tree, message and identity
                 the same rules give it (filter-repo over the pushed rewrite's input plus these
                 branches; only the local commits are taken from that run, because filter-repo
                 translates commit ids quoted in messages in export order, so shared commits may
                 differ there). Moved only when the tree matches and no pattern is left.
     worktrees a checked-out branch moves with `git reset --keep`; uncommitted edits are stashed,
               re-applied, and on any conflict the worktree is put back exactly as it was
     tags      same-name tag of the rewritten repo, else the mapped commit; local-only tags on the
               old history are removed (kept in refs/pre-rewrite/tags)
     remotes   remote-tracking refs still on the old history are mapped, else removed (kept)

Needs $CHOS_WORK/out/<repo>/{orig.git,new.git} from the rewrite that was pushed, and the run's
config (filter-args.py). Works on shallow and single-branch clones.
"""
import os, pathlib, platform, re, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
if len(sys.argv) < 3 or '/' not in sys.argv[1]:
    sys.exit('usage: migrate-clone.py OWNER/REPO CLONE [--check|--plan|--apply]')
slug, clone = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
mode = (sys.argv[3] if len(sys.argv) > 3 else '--check').lstrip('-')
if mode not in ('check', 'plan', 'apply'):
    sys.exit(f'migrate-clone.py: unknown mode {sys.argv[3]}')
repo = slug.split('/', 1)[1]
work = pathlib.Path(os.environ.get('CHOS_WORK') or sys.exit('migrate-clone.py: set CHOS_WORK to the run folder')).resolve()
out = work / 'out' / repo
fr = out / 'new.git' / 'filter-repo'
if not (fr / 'commit-map').is_file():
    sys.exit(f'migrate-clone.py: no rewrite for {slug} in {out} (run rewrite.sh first)')


def git(*a, cwd=clone, check=True, inp=None, env=None):
    r = subprocess.run(['git', '-C', str(cwd), *a], capture_output=True, text=True, input=inp, env=env, errors='replace')
    if check and r.returncode:
        raise RuntimeError(f"git {' '.join(a[:3])}…: {r.stderr.strip()}")
    return r.stdout


# The forbidden lists are POSIX extended regexes — the dialect the gate's `grep -E` reads. Bracket
# classes such as [[:alpha:]] mean something else to Python's re; translate them so both agree.
POSIX_CLASSES = {'alpha': 'a-zA-Z', 'digit': '0-9', 'alnum': 'a-zA-Z0-9', 'upper': 'A-Z', 'lower': 'a-z',
                 'space': r'\s', 'blank': r' \t', 'xdigit': '0-9A-Fa-f', 'punct': r'!-/:-@\[-`{-~',
                 'cntrl': r'\x00-\x1f\x7f', 'print': r'\x20-\x7e', 'graph': r'\x21-\x7e'}


def ere(p):
    return re.sub(r'\[:([a-z]+):\]', lambda m: POSIX_CLASSES.get(m.group(1), m.group(0)), p)


def load_map(p):
    return dict(l.split() for l in pathlib.Path(p).read_text().splitlines()[1:] if l.strip())


A = load_map(fr / 'commit-map')
first_changed = [l.split()[0] for l in (fr / 'first-changed-commits').read_text().splitlines() if l.strip()]
# The shared list and this repository's own list: a local-only commit must pass both.
_pats = [l.strip() for name in ('patterns.txt', 'repo-patterns.txt') if (work / 'config' / name).is_file()
         for l in (work / 'config' / name).read_text().splitlines() if l.strip() and not l.startswith('#')]
PAT = re.compile('|'.join(ere(p) for p in _pats), re.I | re.M) if _pats else None
new_tags = dict((r.split()[1][10:], r.split()[0]) for r in git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags', cwd=out / 'new.git').splitlines())
orig_tags = dict((r.split()[1][10:], r.split()[0]) for r in git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags', cwd=out / 'orig.git').splitlines())
# original tag object -> the rewritten one (by the name it had), for objects the rewrite replaced
orig_tag_objects = {o: new_tags[n] for n, o in orig_tags.items() if n in new_tags and new_tags[n] != o}


def rows(*ns):
    res = []
    for l in git('for-each-ref', '--format=%(objectname) %(*objectname) %(refname)', *ns).splitlines():
        f = l.split()
        res.append((f[0], f[1] if len(f) == 3 else f[0], f[-1]))
    return res


def has(obj):
    return subprocess.run(['git', '-C', str(clone), 'cat-file', '-e', obj + '^{commit}'], capture_output=True).returncode == 0


def reaches_old(c):
    """True when commit c has the old history below it: by ancestry, or (shallow clones, where the
    first changed commit may be missing) because some commit below it is one the rewrite replaced."""
    if any(has(f) and subprocess.run(['git', '-C', str(clone), 'merge-base', '--is-ancestor', f, c]).returncode == 0
           for f in first_changed):
        return True
    return any(A.get(x, x) != x for x in git('rev-list', c).split())


def old_refs():
    found = set()
    for c in first_changed:
        if has(c):
            found |= set(git('for-each-ref', '--contains', c, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags').split())
    for o, c, r in rows('refs/heads', 'refs/remotes', 'refs/tags'):
        if A.get(c, c) != c or (r.startswith('refs/heads/') and r not in found and reaches_old(c)):
            found.add(r)
        # An annotated tag the rewrite changed (its message, say) while its commit stayed the same.
        elif r.startswith('refs/tags/') and o in orig_tag_objects:
            found.add(r)  # an original tag object the rewrite replaced, under its own name or another
    return sorted(found)


def live_worktrees():
    """({branch ref: worktree}, [(worktree, HEAD) for detached ones]) of this repository's live
    worktrees; a registration whose path now belongs to another repository is stale and skipped."""
    me = os.path.realpath(git('rev-parse', '--path-format=absolute', '--git-common-dir').strip())
    branches, detached, w, head = {}, [], None, None

    def mine(path):
        cd = subprocess.run(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                            capture_output=True, text=True).stdout.strip()
        return os.path.isdir(path) and os.path.realpath(cd) == me
    # -z: a path may hold any byte but NUL; the line format splits or quotes some of them.
    for line in git('worktree', 'list', '--porcelain', '-z').split('\0') + ['']:
        if line.startswith('worktree '):
            w, head = line[9:], None
        elif line.startswith('HEAD '):
            head = line[5:]
        elif line.startswith('branch ') and w and mine(w):
            branches[line[7:]] = w
        elif line == 'detached' and w and head and mine(w):
            detached.append((w, head))
    return branches, detached


def old_heads():
    """Detached worktrees whose checked-out commit is still on the old history."""
    return [(w, h) for w, h in live_worktrees()[1] if A.get(h, h) != h or reaches_old(h)]


def leak_lines(*revs):
    """Lines matching the forbidden lists in the commits `git rev-list <revs>` names: their messages and
    identities, and every blob they introduce (merges against each parent). Blobs are read whole, line by
    line, so ^/$ anchor as in the gate and a binary is read byte for byte, as `grep -a` reads it."""
    if not PAT:
        return 0
    n, seen = 0, set()
    for c in git('rev-list', *revs, check=False).split():
        meta = git('show', '-s', '--format=%B%n%an %ae%n%cn %ce', c)
        n += sum(1 for l in meta.splitlines() if PAT.search(l))
        raw = git('diff-tree', '-r', '-m', '--root', '--no-renames', '--no-commit-id', c, check=False)
        for l in raw.splitlines():
            f = l.split()
            if len(f) >= 5 and l.startswith(':') and f[3] != '0' * len(f[3]) and f[3] not in seen:
                seen.add(f[3])
                data = subprocess.run(['git', '-C', str(clone), 'cat-file', 'blob', f[3]], capture_output=True).stdout
                text = data.decode('latin-1') if b'\0' in data[:8000] else data.decode('utf-8', 'replace')
                n += sum(1 for line in text.splitlines() if PAT.search(line))
    return n


def report():
    old = old_refs()
    heads = [r for _, _, r in rows('refs/heads') if r not in old]
    hits = 0
    if PAT and heads and git('rev-list', *heads, '--not', '--remotes', check=False).strip():
        hits = leak_lines(*heads, '--not', '--remotes')
    old += [f'HEAD of {w} (detached)' for w, _ in old_heads()]
    print(f'{slug} @ {clone}: refs on the old history {len(old)}; pattern lines in local-only commits {hits}')
    for r in old:
        print('    ' + r)
    return 1 if old or hits else 0


if mode == 'check':
    sys.exit(report())

print(f'== {slug}: {clone}  ({mode})')
if mode == 'apply':
    bdir = work / 'clone-backups' / f'{repo}-{time.strftime("%Y%m%d-%H%M%S")}-{os.getpid()}'
    bdir.mkdir(parents=True)
    cp = ['cp', '-cR'] if platform.system() == 'Darwin' else ['cp', '-a', '--reflink=auto']
    subprocess.run(cp + [git('rev-parse', '--path-format=absolute', '--git-common-dir').strip(), str(bdir / 'dot-git')], check=True)
    (bdir / 'refs.txt').write_text(git('for-each-ref'))
    if not git('for-each-ref', 'refs/pre-rewrite'):
        git('update-ref', '--stdin', inp=''.join(f'update refs/pre-rewrite/{r[5:]} {o}\n' for o, _, r in rows('refs/heads', 'refs/tags', 'refs/remotes', 'refs/stash')))
    print(f'   backup: {bdir} + refs/pre-rewrite/*')
    git('fetch', '-q', str(out / 'new.git'), '+refs/*:refs/rewrite-src/*')
    if 'origin' in git('remote').split():
        r = subprocess.run(['git', '-C', str(clone), 'fetch', '-q', '--prune', '--force', 'origin'], capture_output=True, text=True)
        print('   fetched origin' if r.returncode == 0 else f'   origin fetch failed (left as is): {r.stderr.strip()[:120]}')

wts, detached_wts = live_worktrees()
tips = {r[11:]: c for _, c, r in rows('refs/heads')}
plan = []  # (branch, old, target or None, how)
local_only = []
for b, c in tips.items():
    if A.get(c, c) != c:
        plan.append((b, c, A[c], 'maps'))
    elif c in A or not reaches_old(c):
        continue  # already on the new history (or older than the first change)
    else:
        local_only.append(b)

if local_only and mode == 'apply':
    # The pushed rewrite's input plus these branches, filtered by the same rules.
    scratch = work / 'clone-backups' / f'{repo}-rebuild-{os.getpid()}.git'
    subprocess.run(['git', 'clone', '-q', '--mirror', str(out / 'orig.git'), str(scratch)], check=True)
    git('remote', 'remove', 'origin', cwd=scratch, check=False)
    git('update-ref', '--stdin', cwd=scratch, inp=''.join(f'delete {r}\n' for r in git('for-each-ref', '--format=%(refname)', 'refs/pull', cwd=scratch).split()))
    git('fetch', '-q', str(clone), *[f'{tips[b]}:refs/heads/zz-local/{b}' for b in local_only], cwd=scratch)
    args = subprocess.run(['python3', '-I', str(HERE / 'filter-args.py')], capture_output=True, check=True,
                          env=dict(os.environ, CHOS_WORK=str(work))).stdout.decode().split('\0')[:-1]
    subprocess.run(['git', '-C', str(scratch), 'filter-repo', *args], capture_output=True, check=True, env=dict(os.environ, CHOS_WORK=str(work)))
    P = load_map(scratch / 'filter-repo' / 'commit-map')
    git('fetch', '-q', str(scratch), '+refs/heads/zz-local/*:refs/partial-src/*')
for b in local_only:
    c = tips[b]
    lines = git('rev-list', '--topo-order', '--reverse', '--parents', c).splitlines()
    local = [l.split() for l in lines if l.split()[0] not in A]
    if mode != 'apply':
        plan.append((b, c, None, f'rebuild {len(local)} local commit(s)'))
        continue
    made = {}
    for cc, *parents in local:
        pc = P[cc]
        head, msg = git('cat-file', 'commit', pc).split('\n\n', 1)
        hdr = {}
        for h in head.splitlines():
            k, v = h.split(' ', 1)
            hdr.setdefault(k, v)

        def who(v):
            name, rest = v.rsplit(' <', 1)
            email, date = rest.split('> ', 1)
            return name, email, date
        an, ae, ad = who(hdr['author'])
        cn, ce, cd = who(hdr['committer'])
        env = dict(os.environ, GIT_AUTHOR_NAME=an, GIT_AUTHOR_EMAIL=ae, GIT_AUTHOR_DATE=ad,
                   GIT_COMMITTER_NAME=cn, GIT_COMMITTER_EMAIL=ce, GIT_COMMITTER_DATE=cd)
        ps = [x for p in parents for x in ('-p', A[p] if p in A else made[p])]
        made[cc] = git('commit-tree', hdr['tree'], *ps, inp=msg, env=env).strip()
    target = made[c]
    src = git('rev-parse', f'refs/partial-src/{b}').strip()
    ok_tree = git('rev-parse', target + '^{tree}').strip() == git('rev-parse', src + '^{tree}').strip()
    if not ok_tree or leak_lines(target, '--not', *[A[p] for l in local for p in l[1:] if p in A]):
        plan.append((b, c, None, 'rebuild REFUSED (tree differs or a pattern is left)'))
        continue
    plan.append((b, c, target, f'rebuilt {len(local)} local commit(s)'))

def move_worktree(wt, old, target, label, detach):
    """Move a checkout to target keeping uncommitted edits (index and worktree, via stash --index).
    Any conflict puts it back exactly as it was. Returns None on success, else the reason."""
    stash = ''
    if git('rev-parse', 'HEAD', cwd=wt).strip() != old:
        return f'worktree {wt} moved since the plan was made (new commits?) — left as it is'
    # Checkout overwrites ignored files without asking: one where the target tracks a file would be lost.
    ignored = set(git('ls-files', '--others', '--ignored', '--exclude-standard', '-z', cwd=wt).split('\0')) - {''}
    files = set(git('ls-tree', '-r', '--name-only', '-z', target, cwd=wt).split('\0')) - {''}
    dirs = {f.rsplit('/', i)[0] for f in files for i in range(1, f.count('/') + 1)}

    def parents(path):
        return {path.rsplit('/', i)[0] for i in range(1, path.count('/') + 1)}
    # Same path, an ignored file where the target has a folder, or an ignored folder where it has a file.
    if any(i in files or i in dirs or parents(i) & files for i in ignored):
        return f'worktree {wt} has ignored files where the rewritten commit tracks files — left as it is'
    if git('status', '--porcelain', '--untracked-files=no', cwd=wt).strip():
        (bdir / f'edits-{label.replace("/", "_")}.patch').write_text(git('diff', 'HEAD', '--binary', cwd=wt))
        before = git('rev-parse', '-q', '--verify', 'refs/stash', cwd=wt, check=False).strip()
        git('stash', 'push', '-q', '-m', f'migrate-clone: edits of {label}', cwd=wt)
        after = git('rev-parse', '-q', '--verify', 'refs/stash', cwd=wt, check=False).strip()
        # `stash push` can save nothing and still succeed; then stash@{0} is someone else's stash.
        stash = after if after and after != before else ''
    def drop_mine():
        # The stash stack is shared by every worktree: drop this run's entry by position, not the top.
        ids = git('stash', 'list', '--format=%H', cwd=wt).split()
        if stash in ids:
            git('stash', 'drop', '-q', f'stash@{{{ids.index(stash)}}}', cwd=wt)
    go = ['checkout', '-q', '--detach', target] if detach else ['reset', '-q', '--keep', target]
    if subprocess.run(['git', '-C', wt, *go]).returncode:
        if stash:
            git('stash', 'apply', '-q', '--index', stash, cwd=wt)
            drop_mine()
        return f'worktree {wt} could not move'
    if stash and subprocess.run(['git', '-C', wt, 'stash', 'apply', '-q', '--index', stash], capture_output=True).returncode:
        git('reset', '-q', '--hard', 'HEAD', cwd=wt)
        git(*(['checkout', '-q', '--detach', old] if detach else ['reset', '-q', '--keep', old]), cwd=wt)
        git('stash', 'apply', '-q', '--index', stash, cwd=wt)
        drop_mine()
        return f'worktree {wt} has edits in lines the rewrite changed — left exactly as it was (patch in {bdir})'
    if stash:
        drop_mine()
    return None


moved, left = [], []
for b, c, target, how in plan:
    if not target:
        left.append(f'{b}: {how}')
        continue
    ref, wt = f'refs/heads/{b}', wts.get(f'refs/heads/{b}')
    if mode != 'apply':
        moved.append(f'{b} [{how}]' + (f' (worktree {wt})' if wt else ''))
        continue
    if not wt:
        # Leased to the planned value: a branch that got new commits since the plan stays as it is.
        if subprocess.run(['git', '-C', str(clone), 'update-ref', ref, target, c], capture_output=True).returncode:
            left.append(f'{b}: moved since the plan was made (new commits?) — left as it is')
            continue
        moved.append(f'{b} [{how}] -> {target[:10]}')
        continue
    edited = bool(git('status', '--porcelain', '--untracked-files=no', cwd=wt).strip())
    why = move_worktree(wt, c, target, b, detach=False)
    if why:
        left.append(f'{b}: {why}')
    else:
        moved.append(f'{b} [{how}] -> {target[:10]} (worktree {wt}{", edits kept" if edited else ""})')
for wt, h in detached_wts:
    if A.get(h, h) == h:
        if reaches_old(h):
            left.append(f'detached HEAD of {wt}: local commits on the old history — check out a migrated branch there')
        continue
    if mode != 'apply':
        moved.append(f'detached HEAD of {wt} [maps]')
        continue
    why = move_worktree(wt, h, A[h], 'detached-' + pathlib.Path(wt).name, detach=True)
    (left if why else moved).append(f'detached HEAD of {wt}: ' + (why or f'-> {A[h][:10]}'))

if mode == 'apply':
    for o, c, r in rows('refs/tags'):
        name = r[10:]
        if o in orig_tag_objects:
            git('update-ref', r, orig_tag_objects[o], o)
        elif name in new_tags and new_tags[name] != o and orig_tags.get(name) == o:
            git('update-ref', r, new_tags[name], o)
        elif A.get(c, c) != c:
            git('update-ref', r, A[c], o)
    for o, c, r in rows('refs/remotes'):
        if git('symbolic-ref', '-q', r, check=False).strip():
            continue
        if A.get(c, c) != c:
            git('update-ref', r, A[c], o)
    gone = [r for r in old_refs() if r.startswith(('refs/tags/', 'refs/remotes/'))]
    git('update-ref', '--stdin', inp=''.join(f'delete {r}\n' for r in gone))
    git('update-ref', '--stdin', inp=''.join(f'delete {r}\n' for r in git('for-each-ref', '--format=%(refname)', 'refs/rewrite-src', 'refs/partial-src').split()))
    if gone:
        print(f'   removed {len(gone)} tag/remote ref(s) only the old history had (kept in refs/pre-rewrite)')

print(f'   moved: {len(moved)}')
for m in moved:
    print('     ' + m)
print(f'   not moved: {len(left)}')
for m in left:
    print('     ' + m)
if mode == 'apply':
    sys.exit(report())
