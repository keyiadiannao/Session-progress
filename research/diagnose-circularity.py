"""
diagnose-circularity.py - SEALING diagnostic for the ML line.

One run answers the causal question "is the 99.8% a real result or rule
relabelling?" with FIVE checks:

  0. Annotator self-consistency (is it a deterministic label function?)
  1. R_future = P(Label_full != Label_prefix)  -- the headline number.
     Re-runs the annotator on (a) the full turn trajectory and (b) the
     prefix up to snapshot t, and measures how often the oracle (final
     deliverable set / final test-pass / final report) actually MOVES a label.
  2. Label derivability: a transparent depth-3 decision tree on a handful of
     derived facts, leave-one-session-out.  If it ~matches Model A, the label
     is a function of prefix facts alone.
  3. Feature ablation: remove label-generator features (coverage proxy =
     files_count, tests, produced_artifact, tool_calls) and watch accuracy.
  4. Macro metrics (macro-F1, balanced accuracy, per-class recall, confusion)
     on the HONEST cross-framework holdout.

This is a diagnostic, not a new model experiment. No hyperparameter search.
"""
import json
import os
import random
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (accuracy_score, balanced_accuracy_score,
                             f1_score, confusion_matrix)

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

STAGES = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
MODES = ['exploring', 'executing', 'rework', 'validating', 'delivering']
NOMINAL = {'planned': 18, 'executing': 35, 'first_output': 55, 'integrating': 72,
           'validating': 86, 'ready': 96}

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]
labels = [json.loads(l) for l in open(os.path.join(DS, 'v2-labels.jsonl'), encoding='utf-8')]
LAB = {(r['sessionId'], r['turn'], r['callIndex']): r for r in labels}

turns = defaultdict(list)
for s in snaps:
    turns[(s['sessionId'], s['turn'])].append(s)

# ---------------------------------------------------------------- helpers
def has_report_from(files, claims):
    return (any(f.lower().endswith(('.md', '.tex')) or 'readme' in f.lower() for f in files)
            or any(c['type'] == 'ready_to_deliver' for c in claims))

def milestones_of(s):
    return {m['type'] for m in s['interpretation']['milestones']}

def tests_pass_from(milestones):
    return 'validation_passed' in milestones and 'validation_failed' not in milestones

def stage_rule(d, files_now, coverage, final_tests_pass, final_has_report, is_last):
    if is_last and final_has_report:
        return 'ready'
    if is_last and final_tests_pass:
        return 'validating'
    if final_tests_pass and d['tests_run'] >= 1 and d['tests_failed'] == 0 and coverage >= 0.5:
        return 'validating'
    if coverage >= 0.9:
        return 'integrating'
    if coverage >= 0.25 or d['produced_artifact']:
        return 'first_output'
    if d['tool_calls_total'] > 0:
        return 'executing'
    return 'planned'

def mode_rule(d, last_tool, args_summary, is_last, final_has_report):
    if d['recent_errors'] >= 2:
        return 'rework'
    if last_tool == 'run' and ('test' in (args_summary or '').lower() or d['tests_run'] >= 1):
        return 'validating'
    if last_tool == 'report' or (is_last and final_has_report):
        return 'delivering'
    if d['produced_artifact'] and last_tool == 'write':
        return 'executing'
    if d['tool_calls_total'] > 0 and not d['produced_artifact']:
        return 'exploring'
    return 'executing'

# ================================================================ 0. self-consistency
print('=' * 70)
print('[0] Annotator self-consistency (determinism)')
print('=' * 70)
# annotate-v2.py contains NO randomness, NO model call, NO set-iteration that
# affects output: it is a pure if/elif function.  Re-running it N times is
# identical BY CONSTRUCTION.  Verify cheaply by re-deriving stage twice.
def annotate_once(oracle='full'):
    out = {}
    for (sid, tn), tlist in turns.items():
        tlist = sorted(tlist, key=lambda x: x['callIndex'])
        final = tlist[-1]
        final_files = {f['path'] for f in final['observations']['files']}
        final_ms = milestones_of(final)
        final_tests_pass = tests_pass_from(final_ms)
        final_has_report = has_report_from(final_files, final['observations']['visible_claims'])
        for s in tlist:
            files_now = {f['path'] for f in s['observations']['files']}
            d = s['derived']
            if oracle == 'full':
                coverage = (len(files_now & final_files) / len(final_files)) if final_files else 0.0
                st = stage_rule(d, files_now, coverage, final_tests_pass, final_has_report, s is final)
                mo = mode_rule(d, (s['observations']['tool_calls'][-1]['category'] if s['observations']['tool_calls'] else None),
                               (s['observations']['tool_calls'][-1].get('args_summary', '') if s['observations']['tool_calls'] else ''),
                               s is final, final_has_report)
            else:  # prefix: oracle = snapshot t itself
                ms_now = milestones_of(s)
                tpass = tests_pass_from(ms_now)
                hrep = has_report_from(files_now, s['observations']['visible_claims'])
                coverage = 1.0 if files_now else 0.0
                st = stage_rule(d, files_now, coverage, tpass, hrep, True)
                mo = mode_rule(d, (s['observations']['tool_calls'][-1]['category'] if s['observations']['tool_calls'] else None),
                               (s['observations']['tool_calls'][-1].get('args_summary', '') if s['observations']['tool_calls'] else ''),
                               True, hrep)
            out[(sid, tn, s['callIndex'])] = (st, mo)
    return out

a1, a2 = annotate_once('full'), annotate_once('full')
agree = sum(1 for k in a1 if a1[k] == a2[k])
print(f'  two independent re-derivations agree on {agree}/{len(a1)} snapshots = {agree/len(a1)*100:.1f}%')
print('  -> annotator is a DETERMINISTIC hand-written if/elif function (no stochastic judge).')
print('  -> self-consistency ~100% is by construction and proves nothing about label quality.')

# ================================================================ 1. R_future
print('\n' + '=' * 70)
print('[1] R_future = P(Label_full != Label_prefix)  -- the headline number')
print('=' * 70)
full = annotate_once('full')
prefix = annotate_once('prefix')

d_stage, d_mode = 0, 0
stage_pairs = Counter()
mode_pairs = Counter()
n = len(full)
for k in full:
    f_st, f_mo = full[k]
    p_st, p_mo = prefix[k]
    if f_st != p_st:
        d_stage += 1
        stage_pairs[(p_st, '->', f_st)] += 1
    if f_mo != p_mo:
        d_mode += 1
        mode_pairs[(p_mo, '->', f_mo)] += 1

print(f'  R_future(stage) = {d_stage}/{n} = {d_stage/n*100:.1f}%')
print(f'  R_future(mode)  = {d_mode}/{n}  = {d_mode/n*100:.1f}%')
print(f'  -> the full-trajectory oracle moves the stage label on only {d_stage/n*100:.1f}% of snapshots.')
print('  top stage flips (prefix -> full):')
for (a, arrow, b), c in stage_pairs.most_common(8):
    print(f'      {a} {arrow} {b}: {c}')
print('  top mode flips (prefix -> full):')
for (a, arrow, b), c in mode_pairs.most_common(5):
    print(f'      {a} {arrow} {b}: {c}')

# ================================================================ 2. label derivability (shallow tree)
print('\n' + '=' * 70)
print('[2] Label derivability: depth-3 decision tree, leave-one-session-out')
print('=' * 70)
rows = []
for k, lab in LAB.items():
    s = next((x for x in turns[(k[0], k[1])] if x['callIndex'] == k[2]), None)
    if not s:
        continue
    d = s['derived']
    rows.append({
        'sessionId': k[0],
        'files_count': len(s['observations']['files']),
        'tests_run': d['tests_run'], 'tests_failed': d['tests_failed'],
        'produced_artifact': int(d['produced_artifact']),
        'tool_calls_total': d['tool_calls_total'],
        'errors_total': d['errors_total'], 'todo_done': d['todo_done'], 'todo_total': d['todo_total'],
        'stage': lab['progress_stage'],
    })
df = pd.DataFrame(rows)
BASE_FEATS = ['files_count', 'tests_run', 'tests_failed', 'produced_artifact', 'tool_calls_total']
EXTRA_FEATS = ['errors_total', 'todo_done', 'todo_total']
ALL_FEATS = BASE_FEATS + EXTRA_FEATS

def stage_mae(te, pred):
    return np.mean([abs(NOMINAL.get(te['stage'].iloc[i], 0) - NOMINAL.get(pred[i], 0)) for i in range(len(te))])

def loo_acc(features, depth=3, min_leaf=50):
    accs, maes = [], []
    for sid in df.sessionId.unique():
        te, tr = df[df.sessionId == sid], df[df.sessionId != sid]
        if len(te) == 0 or len(tr) == 0:
            continue
        m = DecisionTreeClassifier(max_depth=depth, min_samples_leaf=min_leaf, random_state=0)
        m.fit(tr[features], tr['stage'])
        pred = m.predict(te[features])
        accs.append(accuracy_score(te['stage'], pred))
        maes.append(stage_mae(te, pred))
    return np.mean(accs), np.mean(maes)

acc, mae = loo_acc(ALL_FEATS)
print(f'  depth-3 tree on {len(ALL_FEATS)} facts (all {df.sessionId.nunique()} sessions): acc={acc*100:.1f}%  mae={mae:.1f}pp')
acc, mae = loo_acc(BASE_FEATS)
print(f'  depth-3 tree on 5 core facts only:                              acc={acc*100:.1f}%  mae={mae:.1f}pp')

# ================================================================ 3. feature ablation
print('\n' + '=' * 70)
print('[3] Feature ablation: drop label-generator features')
print('=' * 70)
acc, mae = loo_acc(ALL_FEATS)
print(f'  all 8 facts:                                       acc={acc*100:.1f}%  mae={mae:.1f}pp')
acc, mae = loo_acc([f for f in ALL_FEATS if f != 'files_count'])
print(f'  drop files_count (coverage proxy) only:            acc={acc*100:.1f}%  mae={mae:.1f}pp')
acc, mae = loo_acc([f for f in ALL_FEATS if f not in BASE_FEATS])
print(f'  drop ALL label-generator facts (keep errors+todo): acc={acc*100:.1f}%  mae={mae:.1f}pp')
print('  -> if dropping label-generator facts collapses accuracy, the shortcut is precisely there.')

# ================================================================ 4. macro metrics on cross-framework
print('\n' + '=' * 70)
print('[4] Macro metrics on the HONEST cross-framework holdout')
print('=' * 70)

# replicate Model A's facts-only feature vector (no interpretation/rule/cost)
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']
CLAIMS = ['validation_passed', 'bug_found', 'approach_switched', 'ready_to_deliver']

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

rows2 = []
for k, lab in LAB.items():
    s = next((x for x in turns[(k[0], k[1])] if x['callIndex'] == k[2]), None)
    if not s:
        continue
    rows2.append({**feats(s), 'framework': s.get('framework', 'dsh'), 'stage': lab['progress_stage']})
df2 = pd.DataFrame(rows2)
FEATS2 = [c for c in df2.columns if c not in ('framework', 'stage')]

claude, dsh = df2[df2.framework == 'claude'], df2[df2.framework == 'dsh']
for name, tr, te in [('claude->dsh', claude, dsh), ('dsh->claude', dsh, claude)]:
    m = HistGradientBoostingClassifier(max_leaf_nodes=15, max_iter=60)
    m.fit(tr[FEATS2], tr['stage'])
    pred = m.predict(te[FEATS2])
    y = te['stage']
    macro_f1 = f1_score(y, pred, average='macro', labels=STAGES, zero_division=0)
    bal = balanced_accuracy_score(y, pred)
    acc = accuracy_score(y, pred)
    print(f'  {name:14} acc={acc*100:5.1f}%  macro-F1={macro_f1*100:5.1f}%  balanced-acc={bal*100:5.1f}%')
    cm = confusion_matrix(y, pred, labels=STAGES)
    print(f'    confusion (rows=true, cols=pred):')
    hdr = '          ' + ''.join(f'{s[:3]:>5}' for s in STAGES)
    print(hdr)
    for i, s in enumerate(STAGES):
        print(f'    {s:>8}' + ''.join(f'{cm[i,j]:>5}' for j in range(len(STAGES))))
    rec = {s: (cm[i, i] / cm[i].sum() if cm[i].sum() else 0.0) for i, s in enumerate(STAGES)}
    print('    per-class recall: ' + ', '.join(f'{s}={rec[s]*100:.0f}%' for s in STAGES))
