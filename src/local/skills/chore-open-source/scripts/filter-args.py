#!/usr/bin/env python3
"""filter-args.py — the git filter-repo arguments of this run, NUL-separated on stdout.

One source for rewrite.sh and migrate-clone.py, so a clone migrated later gets exactly the
rules the pushed history got. Reads the run folder $CHOS_WORK:

  config/replace.txt     required. filter-repo --replace-text rules, used for file contents and
                         commit messages; filename-callback.py applies them to path names too
  config/mailmap         optional. author / committer rewrites (git mailmap format)
  config/blob-map.txt    optional. "<old blob id> <file with the new bytes>" per line (media)
  config/filter-args     optional. extra filter-repo arguments, one per line
                         (for example --path / --invert-paths to drop a file from history)
"""
import os, pathlib, sys

work = os.environ.get('CHOS_WORK')
if not work:
    sys.exit('filter-args.py: set CHOS_WORK to the run folder')
cfg = pathlib.Path(work) / 'config'
here = pathlib.Path(__file__).resolve().parent
replace = cfg / 'replace.txt'
if not replace.is_file():
    sys.exit(f'filter-args.py: missing {replace}')

args = ['--force', '--replace-text', str(replace), '--replace-message', str(replace),
        '--blob-callback', (here / 'blob-callback.py').read_text(),
        '--filename-callback', (here / 'filename-callback.py').read_text(),
        '--prune-empty', 'never', '--prune-degenerate', 'never']
if (cfg / 'mailmap').is_file():
    args += ['--mailmap', str(cfg / 'mailmap')]
extra = cfg / 'filter-args'
if extra.is_file():
    args += [l.strip() for l in extra.read_text().splitlines() if l.strip() and not l.lstrip().startswith('#')]
sys.stdout.write('\0'.join(args) + '\0')
