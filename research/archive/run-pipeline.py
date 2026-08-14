"""
run-pipeline.py - the reproducible data flywheel, FAIL-CLOSED, cross-framework.

  DSH logs        -> extract-snapshots.mjs -> snapshots-dsh.jsonl
  Claude Code logs -> claude-extract.mjs   -> snapshots-claude.jsonl
  merge -> snapshots.jsonl
  -> causal stage labeling (label_stages.py)
  -> prefix-invariance gate (test-prefix-invariance.py)   [fail-closed]
  -> train + evaluate (train-ordinal.py [--framework dsh|claude|both])

If the invariance check fails, the pipeline stops and does NOT produce a model.

Usage:
  python run-pipeline.py [sessionsRoot] [claudeProjectsRoot] [--framework dsh|claude|both]
"""
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
NODE = r'C:\Users\26433\AppData\Roaming\fnm\node-versions\v24.19.0\installation\node.exe'
PY = r'C:\Users\26433\miniconda3\envs\mamba2\python.exe'

# parse args: positional = [sessionsRoot, claudeProjectsRoot]; --framework dsh|claude|both
_argv = sys.argv[1:]
fw = 'both'
if '--framework' in _argv:
    _i = _argv.index('--framework')
    fw = _argv[_i + 1]
    _argv = _argv[:_i] + _argv[_i + 2:]
sessions_root = _argv[0] if len(_argv) > 0 else r'C:\Users\26433\.dsh\sessions'
claude_root = _argv[1] if len(_argv) > 1 else r'C:\Users\26433\.claude\projects'


def run(cmdlist, name):
    print(f'\n=== [{name}] ===', flush=True)
    r = subprocess.run(cmdlist, cwd=BASE)
    if r.returncode != 0:
        print(f'[PIPELINE FAIL] {name} exited {r.returncode} - stopping (fail-closed)', flush=True)
        sys.exit(r.returncode)
    print(f'[ok] {name}', flush=True)


run([NODE, 'extract-snapshots.mjs', sessions_root, os.path.join(DS, 'snapshots-dsh.jsonl')], '1/6 extract DSH snapshots')
run([NODE, 'claude-extract.mjs', claude_root, os.path.join(DS, 'snapshots-claude.jsonl')], '2/6 extract Claude snapshots')

# merge
print('\n=== [3/6 merge snapshots] ===', flush=True)
lines = []
for name in ('snapshots-dsh.jsonl', 'snapshots-claude.jsonl'):
    p = os.path.join(DS, name)
    if os.path.exists(p):
        lines += open(p, encoding='utf-8').read().splitlines()
with open(os.path.join(DS, 'snapshots.jsonl'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print(f'[ok] merged {len(lines)} snapshots', flush=True)

run([PY, 'label_stages.py'], '4/6 causal stage labeling')
run([PY, 'test-prefix-invariance.py'], '5/6 prefix-invariance gate (fail-closed)')
run([PY, '-u', 'train-ordinal.py', '--framework', fw], f'6/6 train + evaluate (framework={fw})')

print('\n[PIPELINE DONE] model artifact + metrics produced; invariance gate passed.')
