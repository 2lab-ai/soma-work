# git filter-repo --refname-callback body (filter-args.py passes this file's text).
# Applies the rules of $CHOS_WORK/config/replace.txt to branch and tag names, so a ref named after a
# private host is renamed like the text inside files; the namespace prefix is kept as it is.
rules = globals().get('_chos_ref_rules')
if rules is None:
    import os, re, fnmatch
    rules = []
    path = os.path.join(os.environ.get('CHOS_WORK', ''), 'config', 'replace.txt')
    with open(path, 'rb') as f:
        for raw in f.read().splitlines():
            line = raw.strip()
            if not line or line.startswith(b'#'):
                continue
            pat, rep = line.split(b'==>', 1) if b'==>' in line else (line, b'***REMOVED***')
            if pat.startswith(b'regex:'):
                rx = re.compile(pat[6:])
            elif pat.startswith(b'glob:'):
                rx = re.compile(fnmatch.translate(pat[5:].decode()).encode())
            else:
                rx = re.compile(re.escape(pat[8:] if pat.startswith(b'literal:') else pat))
            rules.append((rx, rep))
    globals()['_chos_ref_rules'] = rules
for prefix in (b'refs/heads/', b'refs/tags/'):
    if refname.startswith(prefix):
        name = refname[len(prefix):]
        for rx, rep in rules:
            name = rx.sub(rep, name)
        return prefix + name
return refname
