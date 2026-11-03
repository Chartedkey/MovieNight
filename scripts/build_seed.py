#!/usr/bin/env python3
"""Собирает начальные данные приложения из таблицы и списка «Ближайшие»."""
import json, re, sys, openpyxl
xlsx, near_path, out = sys.argv[1:4]
ws = openpyxl.load_workbook(xlsx).active
def parse(raw):
    lines = [l.strip() for l in str(raw).split('\n') if l.strip()]
    text = lines[0] if lines else ''
    note = ' '.join(lines[1:]) or None
    m = re.search(r'\(?\b((?:18|19|20)\d\d)\)?\s*$', text)
    if m and len(text[:m.start()].strip()) > 0:
        return text[:m.start()].strip(), int(m.group(1)), note
    return text, None, note
def kp(cell):
    t = cell.hyperlink.target if cell.hyperlink and cell.hyperlink.target else ''
    m = re.search(r'kinopoisk\.ru/(?:film|series)/(\d+)', t)
    return (int(m.group(1)) if m else None), (t or None)
groups, junk = [], []
for row in ws.iter_rows(min_row=2):
    films = []
    for i in (0, 1, 5, 6, 7):
        if i >= len(row): continue
        v = row[i].value
        if not isinstance(v, str) or not v.strip(): continue
        title, year, note = parse(v)
        if re.fullmatch(r'\?+', title) or title.lower() == 'сериал':
            junk.append({'row': row[0].row, 'value': v.strip()}); continue
        kid, link = kp(row[i])
        films.append({'title': title, 'year': year, 'note': note, 'kinopoiskId': kid, 'link': link, 'column': row[i].column_letter})
    if films: groups.append({'row': row[0].row, 'films': films})
def norm(s):
    s = s.lower().replace('ё', 'е')
    return re.sub(r'[^0-9a-zа-я]+', ' ', s).strip()
idx = {}
for g in groups:
    for f in g['films']:
        idx.setdefault(norm(f['title']), []).append((g['row'], f))
near, unmatched = [], []
for pos, line in enumerate(l.strip() for l in open(near_path, encoding='utf8') if l.strip()):
    parts = re.split(r'\s+(?:или|ИЛИ)\s+', line)
    alts = []
    for part in parts:
        t, y, _ = parse(re.sub(r'\(ТВ,\s*', '(', part))
        hits = idx.get(norm(t), [])
        if y: hits = [h for h in hits if h[1]['year'] in (y, None)] or hits
        rec = {'title': t, 'year': y, 'tableRow': hits[0][0] if len(hits) == 1 else None, 'tableYear': hits[0][1]['year'] if len(hits) == 1 else None, 'matches': len(hits)}
        if len(hits) != 1: unmatched.append({'line': line, 'title': t, 'year': y, 'matches': len(hits)})
        alts.append(rec)
    near.append({'position': pos, 'source': line, 'alternatives': alts})
json.dump({'groups': groups, 'skipped': junk, 'near': near}, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
n = sum(len(g['films']) for g in groups)
print('групп', len(groups), 'фильмов', n, 'без года', sum(1 for g in groups for f in g['films'] if not f['year']), 'с id кинопоиска', sum(1 for g in groups for f in g['films'] if f['kinopoiskId']))
print('по числу фильмов в строке', {k: sum(1 for g in groups if len(g['films']) == k) for k in range(1, 6)})
print('пропущено', junk)
print('заметки', [f for g in groups for f in g['films'] if f['note']])
print('без года', [(g['row'], f['title']) for g in groups for f in g['films'] if not f['year']])
dups = {k: v for k, v in idx.items() if len(v) > 1}
print('повторы названий', len(dups), [(k, [(r, f['year']) for r, f in v]) for k, v in list(dups.items())[:40]])
print('ближайшие строк', len(near), 'вариантов', sum(len(x['alternatives']) for x in near), 'не сопоставлено', len(unmatched))
for u in unmatched: print(' ', u)
