# -*- coding: utf-8 -*-
"""由于之前生成的 manifest 标题编码损坏，这个脚本从实际文件目录重新生成正确的 manifest 和 index.json。"""
import os, json, csv, re

ROOT = os.path.dirname(__file__).replace('/tools','').replace('\\tools','')
LIB = os.path.join(ROOT, 'library')
CP_FOLDERS = ["德哈","哈德","德赫","斯赫","格邓","伏哈","小龙","柿饼","待分类"]

def normalize(s):
    return re.sub(r'[^\u4e00-\u9fa5a-zA-Z0-9]', '', s).lower()

def main():
    books = []
    idx = 1
    for cp in CP_FOLDERS:
        folder = os.path.join(LIB, cp)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith('.txt'):
                continue
            path = os.path.join(folder, name)
            title = name[:-4]
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                text = f.read()
            books.append({
                'id': idx,
                'title': title,
                'cp': cp,
                'file': f'library/{cp}/{title}.txt',
                'chars': len(text),
                'bytes': os.path.getsize(path),
                'recommended': False,
            })
            idx += 1

    # 用 CSV 标记已推荐
    csv_titles = []
    csv_path = os.path.join(os.path.expanduser('~'), 'Downloads', '已推荐小说收集_公号已推荐小说_表格.csv')
    if os.path.exists(csv_path):
        with open(csv_path, encoding='utf-8-sig') as f:
            rdr = csv.DictReader(f)
            for row in rdr:
                t = (row.get('小说标题') or '').strip()
                if t:
                    csv_titles.append(t)

    matched = 0
    for b in books:
        nt = normalize(b['title'])
        for ct in csv_titles:
            nct = normalize(ct)
            if nct in nt or nt in nct:
                b['recommended'] = True
                matched += 1
                break

    print('regenerated books:', len(books))
    print('CSV matched recommended:', matched)

    # 保留旧 index 中 file=null 的仅标记条目
    old_index = []
    try:
        with open(os.path.join(ROOT, 'index.json'), encoding='utf-8') as f:
            old_index = json.load(f)
    except Exception:
        pass
    markers = [x for x in old_index if x.get('file') is None]
    for m in markers:
        m['id'] = idx
        idx += 1
    final = books + markers
    print('markers kept:', len(markers))

    # 写 manifest
    with open(os.path.join(ROOT, 'library-manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(books, f, ensure_ascii=False, indent=1)

    # 写 index
    with open(os.path.join(ROOT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(final, f, ensure_ascii=False, indent=1)

    # 上传 index.json
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, '.env'))
    import oss2
    auth = oss2.Auth(os.environ['OSS_ACCESS_KEY_ID'], os.environ['OSS_ACCESS_KEY_SECRET'])
    bucket = oss2.Bucket(auth, os.environ['OSS_ENDPOINT'], os.environ['OSS_BUCKET'])
    bucket.put_object_from_file('index.json', os.path.join(ROOT, 'index.json'))
    print('index.json uploaded, total entries:', len(final))

if __name__ == '__main__':
    main()
