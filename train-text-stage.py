"""
train-text-stage.py - the decisive test: can TEXT features beat FACTS features
on the high-maturity stages?

Target = flash-labeled stage (new 6-class ontology, from annotate-stage.mjs).
Features A = facts (derived + files + tool categories)   [known to cap ~60%]
Features B = TF-IDF text (task + activity流水)           [the candidate]

If B (or A+B) lifts integrating/validating/ready recall substantially, the text
carries semantic signal the facts lack -> worth training a small LM.  If not,
even text is insufficient (unlikely, since flash itself reaches ~90%).
"""
import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
STAGES = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']

snaps = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r
         for r in [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]}
labels = [json.loads(l) for l in open(os.path.join(DS, 'stage-labels-flash.jsonl'), encoding='utf-8')]


def facts(s):
    d = s['derived']
    f = {'tool_calls_total': d['tool_calls_total'], 'writes_succeeded': d['writes_succeeded'],
         'tests_run': d['tests_run'], 'tests_failed': d['tests_failed'], 'errors_total': d['errors_total'],
         'recent_errors': d['recent_errors'], 'todo_done': d['todo_done'], 'todo_total': d['todo_total'],
         'todo_ratio': d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0,
         'produced_artifact': int(d['produced_artifact']), 'files_count': len(s['observations']['files'])}
    exts = {fl['ext'].lower() for fl in s['observations']['files']}
    f['has_report'] = int(any(e in ('.md', '.tex') for e in exts) or any('readme' in fl['path'].lower() for fl in s['observations']['files']))
    f['has_code'] = int(any(e in ('.py', '.js', '.ts', '.mjs', '.sh', '.ps1') for e in exts))
    cc = {c: 0 for c in CATS}
    for tc in s['observations']['tool_calls']:
        cc[tc['category']] = cc.get(tc['category'], 0) + 1
    for c in CATS:
        f['cat_' + c] = cc.get(c, 0)
    return f


def text(s):
    # cleaner than activityText: use the activity array's action -> result
    acts = s['observations'].get('activity') or []
    lines = [(a.get('action') or '') + ' ' + (a.get('result') or '') for a in acts[-14:]]
    return (s.get('task') or '') + '\n' + '\n'.join(lines)


rows = []
for lab in labels:
    s = snaps.get((lab['sessionId'], lab['turn'], lab['callIndex']))
    if not s:
        continue
    rows.append({**facts(s), 'sessionId': lab['sessionId'], 'stage': lab['stage'], 'text': text(s)})
df = pd.DataFrame(rows)
FACT_COLS = [c for c in df.columns if c not in ('sessionId', 'stage', 'text')]

print(f'samples {len(df)} | sessions {df.sessionId.nunique()}')
print('stage distribution:', dict(df.stage.value_counts()))

# TF-IDF text features — char n-gram handles mixed CJK/latin (word-boundary \b regex
# explodes on Chinese).  .tolist() avoids pandas-Series iteration overhead.
tfidf = TfidfVectorizer(max_features=1500, analyzer='char_wb', ngram_range=(2, 4), sublinear_tf=True)
Xsem = tfidf.fit_transform(df['text'].tolist()).toarray()
SEM_COLS = [f'tf_{i}' for i in range(Xsem.shape[1])]


def run(tr_idx, te_idx, use_facts, use_sem):
    parts = []
    if use_facts:
        parts.append(df.iloc[tr_idx][FACT_COLS].values)
    if use_sem:
        parts.append(Xsem[tr_idx])
    Xtr = np.hstack(parts)
    parts = []
    if use_facts:
        parts.append(df.iloc[te_idx][FACT_COLS].values)
    if use_sem:
        parts.append(Xsem[te_idx])
    Xte = np.hstack(parts)
    m = LogisticRegression(max_iter=500, random_state=0)
    m.fit(Xtr, df.iloc[tr_idx]['stage'])
    pred = m.predict(Xte)
    y = df.iloc[te_idx]['stage']
    acc = accuracy_score(y, pred)
    macro = f1_score(y, pred, average='macro', labels=STAGES, zero_division=0)
    cm = confusion_matrix(y, pred, labels=STAGES)
    rec = {s: (cm[i, i] / cm[i].sum() if cm[i].sum() else 0.0) for i, s in enumerate(STAGES)}
    return acc, macro, rec


# 5-fold GroupKFold (sessions never split across train/test) — fast + honest
from sklearn.model_selection import GroupKFold
res = {k: {'acc': [], 'macro': [], 'rec': {s: [] for s in STAGES}} for k in ('facts', 'text', 'both')}
gkf = GroupKFold(n_splits=5)
for tr_idx, te_idx in gkf.split(df, df['stage'], groups=df['sessionId']):
    for k, (uf, us) in [('facts', (True, False)), ('text', (False, True)), ('both', (True, True))]:
        acc, macro, rec = run(tr_idx, te_idx, uf, us)
        res[k]['acc'].append(acc)
        res[k]['macro'].append(macro)
        for s in STAGES:
            res[k]['rec'][s].append(rec[s])

print('\n=== leave-one-session-out (mean) ===')
print(f"{'features':8} {'acc':>6} {'macroF1':>8}  " + '  '.join(f"{s[:4]}" for s in STAGES))
for k, label in [('facts', 'facts'), ('text', 'text'), ('both', 'both')]:
    acc = np.mean(res[k]['acc'])
    macro = np.mean(res[k]['macro'])
    recs = '  '.join(f"{np.mean(res[k]['rec'][s]) * 100:4.0f}" for s in STAGES)
    print(f"{label:8} {acc*100:6.1f} {macro*100:8.1f}  {recs}")

print('\n=> 关注 integrating/validating/ready 三列：若 text/both 明显高于 facts，')
print('   则文本携带 facts 缺失的语义信号，值得上小语言模型。')
