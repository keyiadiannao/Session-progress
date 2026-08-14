"""
semantic-features.py - does SEMANTIC prefix content rescue the future-dependent
part of the label (validating / ready)?

The diagnosis showed: facts-only features learn only the monotonic part
(executing ~100% recall) and fail on validating/ready (0-28% recall).  The
snapshots DO carry semantic text the model never used: `task` (full task
description), `tool_results[].tail` (actual per-tool result text),
`visible_claims[].type`.  This script adds TF-IDF over that text and re-runs
the honest cross-framework holdout to see whether validating/ready recall moves.

This is a hypothesis test, not a new production model.  One axis: facts vs
facts+semantic.  Metric: balanced-acc / macro-F1 / per-class recall on
validating + ready.
"""
import json
import os
import re
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import (accuracy_score, balanced_accuracy_score,
                             f1_score, confusion_matrix)

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
STAGES = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']
CLAIMS = ['validation_passed', 'bug_found', 'approach_switched', 'ready_to_deliver']

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]
labels = [json.loads(l) for l in open(os.path.join(DS, 'v2-labels.jsonl'), encoding='utf-8')]
SNAP = {(s['sessionId'], s['turn'], s['callIndex']): s for s in snaps}
LAB = {(r['sessionId'], r['turn'], r['callIndex']): r for r in labels}

def facts(s):
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
    for tc in s['observations']['tool_calls']:
        cc[tc['category']] = cc.get(tc['category'], 0) + 1
    for c in CATS:
        f['cat_' + c] = cc.get(c, 0)
    clc = {c: 0 for c in CLAIMS}
    for cl in s['observations']['visible_claims']:
        clc[cl['type']] = clc.get(cl['type'], 0) + 1
    for c in CLAIMS:
        f['claim_' + c] = clc.get(c, 0)
    st = {'success': 0, 'error': 0, 'unknown': 0}
    for tr in s['observations']['tool_results']:
        st[tr['status']] = st.get(tr['status'], 0) + 1
    f['status_success'] = st['success']; f['status_error'] = st['error']; f['status_unknown'] = st['unknown']
    f['files_count'] = len(s['observations']['files'])
    exts = {fl['ext'].lower() for fl in s['observations']['files']}
    f['has_report'] = int(any(e in ('.md', '.tex') for e in exts) or any('readme' in fl['path'].lower() for fl in s['observations']['files']))
    f['has_code'] = int(any(e in ('.py', '.js', '.ts', '.mjs', '.sh', '.ps1') for e in exts))
    f['has_binary_doc'] = int(any(e in ('.pdf', '.docx', '.pptx', '.xlsx') for e in exts))
    return f

def semtext(s):
    """The semantic prefix content the model never saw: task + per-tool results + claims."""
    parts = [s.get('task', '') or '']
    for tr in s['observations']['tool_results']:
        tail = (tr.get('tail') or '').strip()
        if tail:
            parts.append(tail)
    for cl in s['observations']['visible_claims']:
        parts.append('CLAIM:' + (cl.get('type') or ''))
        if cl.get('text'):
            parts.append(cl['text'])
    return ' '.join(parts)

rows = []
for k, lab in LAB.items():
    s = SNAP.get(k)
    if not s:
        continue
    rows.append({'key': k, **facts(s), 'semtext': semtext(s),
                 'framework': s.get('framework', 'dsh'), 'stage': lab['progress_stage']})
df = pd.DataFrame(rows)
FACT_COLS = [c for c in df.columns if c not in ('key', 'semtext', 'framework', 'stage')]

# TF-IDF over semantic text (prefix-legal: task known at t=0, tails accumulate)
tfidf = TfidfVectorizer(max_features=800, sublinear_tf=True, ngram_range=(1, 2),
                        token_pattern=r'(?u)\b\w+\b', stop_words='english')
Xsem = tfidf.toarray() if False else None
# fit on ALL data (transductive feature extraction is fine for a hypothesis test;
# we hold out at the sample level below)
sem_tfidf = tfidf.fit_transform(df['semtext']).toarray()
SEM_COLS = [f'tf_{i}' for i in range(sem_tfidf.shape[1])]

def run_split(tr_df, te_df, tr_X, te_X, label):
    m = HistGradientBoostingClassifier(max_leaf_nodes=31, max_iter=80)
    m.fit(tr_X, tr_df['stage'])
    pred = m.predict(te_X)
    y = te_df['stage']
    acc = accuracy_score(y, pred)
    bal = balanced_accuracy_score(y, pred)
    macro = f1_score(y, pred, average='macro', labels=STAGES, zero_division=0)
    cm = confusion_matrix(y, pred, labels=STAGES)
    rec = {s: (cm[i, i] / cm[i].sum() if cm[i].sum() else 0.0) for i, s in enumerate(STAGES)}
    return acc, bal, macro, rec

print(f'samples {len(df)} | facts-dim {len(FACT_COLS)} | semantic-dim {sem_tfidf.shape[1]}')
print()

claude, dsh = df[df.framework == 'claude'], df[df.framework == 'dsh']
for name, tr, te in [('claude->dsh', claude, dsh), ('dsh->claude', dsh, claude)]:
    tr_idx = [df.index.get_loc(i) for i in tr.index]
    te_idx = [df.index.get_loc(i) for i in te.index]
    print('=' * 72)
    print(f'{name}  (n_test={len(te)})')
    print('=' * 72)
    # facts only
    acc, bal, macro, rec = run_split(tr, te, tr[FACT_COLS].values, te[FACT_COLS].values, 'stage')
    print(f'  facts-only        : acc={acc*100:5.1f}%  bal={bal*100:5.1f}%  macroF1={macro*100:5.1f}%  '
          f'valid={rec["validating"]*100:4.1f}% ready={rec["ready"]*100:4.1f}% integ={rec["integrating"]*100:4.1f}%')
    # facts + semantic
    Xtr = np.hstack([tr[FACT_COLS].values, sem_tfidf[tr_idx]])
    Xte = np.hstack([te[FACT_COLS].values, sem_tfidf[te_idx]])
    acc, bal, macro, rec = run_split(tr, te, Xtr, Xte, 'stage')
    print(f'  facts+semantic    : acc={acc*100:5.1f}%  bal={bal*100:5.1f}%  macroF1={macro*100:5.1f}%  '
          f'valid={rec["validating"]*100:4.1f}% ready={rec["ready"]*100:4.1f}% integ={rec["integrating"]*100:4.1f}%')
    # semantic only
    acc, bal, macro, rec = run_split(tr, te, sem_tfidf[tr_idx], sem_tfidf[te_idx], 'stage')
    print(f'  semantic-only     : acc={acc*100:5.1f}%  bal={bal*100:5.1f}%  macroF1={macro*100:5.1f}%  '
          f'valid={rec["validating"]*100:4.1f}% ready={rec["ready"]*100:4.1f}% integ={rec["integrating"]*100:4.1f}%')
