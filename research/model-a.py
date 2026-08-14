"""
model-a.py - Model A: predict full-trajectory labels from PREFIX facts only.

Input = observations + derived facts ONLY (no interpretation / rule / cost).
Two heads: progress_stage + activity_mode.

Eval: leave-one-session-out (sampled), cross-framework holdout, and bucket
metrics (has-artifact / validating / rework) as acceptance criteria.

Ablation: --no-file-features removes file-type flags.
Usage: python model-a.py [--no-file-features]
"""
import json
import os
import sys
import random

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
USE_FILE_FEATURES = '--no-file-features' not in sys.argv

SNAPS = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r for r in [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]}
LABELS = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r for r in [json.loads(l) for l in open(os.path.join(DS, 'v2-labels.jsonl'), encoding='utf-8')]}
RULE = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r['label']['stage'] for r in [json.loads(l) for l in open(os.path.join(DS, 'stage-labels.jsonl'), encoding='utf-8')]}

CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']
CLAIMS = ['validation_passed', 'bug_found', 'approach_switched', 'ready_to_deliver']
STAGES = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
MODES = ['exploring', 'executing', 'rework', 'validating', 'delivering']
NOMINAL = {'planned': 18, 'executing': 35, 'first_output': 55, 'integrating': 72, 'validating': 86, 'ready': 96}

def feats(s):
    d = s['derived']
    f = {
        'tool_calls_total': d['tool_calls_total'], 'writes_succeeded': d['writes_succeeded'],
        'tests_run': d['tests_run'], 'tests_failed': d['tests_failed'],
        'errors_total': d['errors_total'], 'recent_errors': d['recent_errors'],
        'todo_done': d['todo_done'], 'todo_total': d['todo_total'],
        'todo_ratio': d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0,
        'produced_artifact': int(d['produced_artifact']),
    }
    cc = {c: 0 for c in CATS}
    for tc in s['observations']['tool_calls']: cc[tc['category']] = cc.get(tc['category'], 0) + 1
    for c in CATS: f['cat_' + c] = cc.get(c, 0)
    clc = {c: 0 for c in CLAIMS}
    for cl in s['observations']['visible_claims']: clc[cl['type']] = clc.get(cl['type'], 0) + 1
    for c in CLAIMS: f['claim_' + c] = clc.get(c, 0)
    st = {'success': 0, 'error': 0, 'unknown': 0}
    for tr in s['observations']['tool_results']: st[tr['status']] = st.get(tr['status'], 0) + 1
    f['status_success'] = st['success']; f['status_error'] = st['error']; f['status_unknown'] = st['unknown']
    f['files_count'] = len(s['observations']['files'])
    if USE_FILE_FEATURES:
        exts = {fl['ext'].lower() for fl in s['observations']['files']}
        f['has_report'] = int(any(e in ('.md', '.tex') for e in exts) or any('readme' in fl['path'].lower() for fl in s['observations']['files']))
        f['has_code'] = int(any(e in ('.py', '.js', '.ts', '.mjs', '.sh', '.ps1') for e in exts))
        f['has_binary_doc'] = int(any(e in ('.pdf', '.docx', '.pptx', '.xlsx') for e in exts))
    return f

rows = []
for k, lab in LABELS.items():
    s = SNAPS.get(k)
    if not s: continue
    rows.append({**feats(s), 'sessionId': k[0], 'turn': k[1], 'callIndex': k[2],
                 'framework': s.get('framework', 'dsh'),
                 'stage': lab['progress_stage'], 'mode': lab['activity_mode'],
                 'has_artifact': int(len(s['observations']['files']) > 0)})
df = pd.DataFrame(rows)
FEAT_COLS = [c for c in df.columns if c not in ('sessionId', 'turn', 'callIndex', 'framework', 'stage', 'mode', 'has_artifact')]
print(f'samples {len(df)} | sessions {df.sessionId.nunique()} | file-features={USE_FILE_FEATURES}')

def fit_predict(tr, te, target):
    m = HistGradientBoostingClassifier(max_leaf_nodes=15, max_iter=60)
    m.fit(tr[FEAT_COLS], tr[target])
    return m.predict(te[FEAT_COLS])

def stage_mae(te, pred):
    return np.mean([abs(NOMINAL.get(te['stage'].iloc[i], 0) - NOMINAL.get(pred[i], 0)) for i in range(len(te))])

# --- leave-one-session-out (stage head) ---
random.seed(0)
sessions = list(df.groupby('sessionId'))
if len(sessions) > 12: sessions = random.sample(sessions, 12)
print('\n=== leave-one-session-out（stage head）===')
accs, maes = [], []
for sid, g in sessions:
    te, tr = g, df[df.sessionId != sid]
    pred = fit_predict(tr, te, 'stage')
    accs.append(accuracy_score(te['stage'], pred)); maes.append(stage_mae(te, pred))
print(f'  mean stage_acc={np.mean(accs)*100:.1f}%  mean mae={np.mean(maes):.1f}pp')

# --- cross-framework holdout ---
print('\n=== cross-framework holdout（stage head）===')
claude, dsh = df[df.framework == 'claude'], df[df.framework == 'dsh']
for name, tr, te in [('claude->dsh', claude, dsh), ('dsh->claude', dsh, claude)]:
    pred = fit_predict(tr, te, 'stage')
    print(f'  {name:18} n_test={len(te):5} stage_acc={accuracy_score(te["stage"], pred)*100:5.1f}%  mae={stage_mae(te, pred):4.1f}pp')

# --- activity_mode head ---
print('\n=== activity_mode head（leave-one-session-out）===')
accs = []
for sid, g in sessions:
    te, tr = g, df[df.sessionId != sid]
    pred = fit_predict(tr, te, 'mode')
    accs.append(accuracy_score(te['mode'], pred))
print(f'  mean mode_acc={np.mean(accs)*100:.1f}%')

# --- bucket comparison: Model A vs rule, on DSH test ---
print('\n=== Model A vs 规则基线（DSH 测试集，按桶）===')
tr, te = claude, dsh
pred = fit_predict(tr, te, 'stage')
buckets = [('has_artifact', te['has_artifact'] == 1), ('no_artifact', te['has_artifact'] == 0),
           ('mode=validating', te['mode'] == 'validating'), ('mode=rework', te['mode'] == 'rework'),
           ('mode=executing', te['mode'] == 'executing')]
for bname, mask in buckets:
    idx = np.where(mask)[0]
    if len(idx) == 0: continue
    ma = accuracy_score(te['stage'].iloc[idx], pred[idx])
    rule_stages = []
    for i in idx:
        rule_stages.append(RULE.get((te.sessionId.iloc[i], te.turn.iloc[i], te.callIndex.iloc[i])))
    valid = [(a, b) for a, b in zip(te['stage'].iloc[idx], rule_stages) if b is not None]
    ra = sum(1 for a, b in valid if a == b) / len(valid) if valid else 0.0
    print(f'  {bname:18} n={len(idx):5} ModelA={ma*100:5.1f}%  rule={ra*100:5.1f}%')
