# git filter-repo --filename-callback body (filter-args.py passes this file's text).
# Applies the rules of $CHOS_WORK/config/replace.txt to path names as well, so a file or folder
# named after a private host is renamed like the text inside files. Rule syntax is filter-repo's:
#   literal-text==>replacement      regex:PATTERN==>replacement      glob:PATTERN==>replacement
# (a rule without "==>" replaces with ***REMOVED***).
if filename is None:  # a path that --path / --invert-paths already dropped
    return None
rules = globals().get('_chos_path_rules')
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
    globals()['_chos_path_rules'] = rules
for rx, rep in rules:
    filename = rx.sub(rep, filename)
return filename
