# git filter-repo --blob-callback body (filter-args.py passes this file's text).
# Replaces whole blobs listed in $CHOS_WORK/config/blob-map.txt: "<old blob id> <file with the
# new bytes>" per line. Used for media (a screenshot or a recording repainted by hand), which
# --replace-text cannot reach. No map, or an empty one, changes nothing.
m = globals().get('_chos_blob_map')
if m is None:
    import os
    m = {}
    path = os.path.join(os.environ.get('CHOS_WORK', ''), 'config', 'blob-map.txt')
    if os.path.isfile(path):
        with open(path) as f:
            for line in f:
                if line.strip() and not line.startswith('#'):
                    old, new = line.split(None, 1)
                    m[old.encode()] = new.strip()
    globals()['_chos_blob_map'] = m
p = m.get(blob.original_id)
if p:
    with open(p, 'rb') as f:
        blob.data = f.read()
