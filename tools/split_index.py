# -*- coding: utf-8 -*-
"""将 index.json 拆分为 summary + index-lite + per-CP 索引，上传到 OSS。

生成文件：
  summary.json       — 轻量统计（~500B），含总数和每 CP 数量
  index-lite.json    — 全部书目不含 file/bytes 字段（约 60% 体积）
  index-{cp}.json    — per-CP 完整索引（含 file 路径），按需加载

用法：python tools/split_index.py
依赖：pip install python-dotenv oss2
"""
import os, json, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(ROOT, 'index.json')


def load_index():
    with open(INDEX_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_summary(books):
    """生成 summary.json — 只含统计数字"""
    cps = {}
    recommended = 0
    for b in books:
        cp = b.get('cp', '待分类')
        cps[cp] = cps.get(cp, 0) + 1
        if b.get('recommended'):
            recommended += 1
    return {
        'total': len(books),
        'recommended': recommended,
        'cps': cps,
    }


def build_index_lite(books):
    """生成 index-lite.json — 全部书目但去掉 file/bytes 字段"""
    return [
        {
            'id': b['id'],
            'title': b['title'],
            'cp': b.get('cp', '待分类'),
            'chars': b.get('chars', 0),
            'recommended': bool(b.get('recommended')),
        }
        for b in books
    ]


def build_cp_index(books, cp):
    """生成某个 CP 的完整索引（含 file）"""
    return [b for b in books if b.get('cp', '待分类') == cp]


def upload_to_oss(path, content_bytes, content_type='application/json'):
    """上传文件到 OSS，需要 .env 中的凭证"""
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, '.env'))
    import oss2

    auth = oss2.Auth(
        os.environ['OSS_ACCESS_KEY_ID'],
        os.environ['OSS_ACCESS_KEY_SECRET'],
    )
    bucket = oss2.Bucket(
        auth,
        os.environ['OSS_ENDPOINT'],
        os.environ['OSS_BUCKET'],
    )
    bucket.put_object(path, content_bytes, headers={'Content-Type': content_type})
    print(f'  [OSS] uploaded: {path} ({len(content_bytes):,} bytes)')


def main():
    books = load_index()
    print(f'Loaded {len(books)} books from index.json')

    # 1. summary.json
    summary = build_summary(books)
    summary_bytes = json.dumps(summary, ensure_ascii=False, indent=1).encode('utf-8')
    local_path = os.path.join(ROOT, 'summary.json')
    with open(local_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(f'  [summary.json] total={summary["total"]}, recommended={summary["recommended"]}, cps={list(summary["cps"].keys())}')

    # 2. index-lite.json
    lite = build_index_lite(books)
    lite_bytes = json.dumps(lite, ensure_ascii=False, indent=1).encode('utf-8')
    local_path = os.path.join(ROOT, 'index-lite.json')
    with open(local_path, 'w', encoding='utf-8') as f:
        json.dump(lite, f, ensure_ascii=False, indent=1)
    print(f'  [index-lite.json] {len(lite)} entries, {len(lite_bytes):,} bytes')

    # 3. per-CP indexes
    cp_set = set(b.get('cp', '待分类') for b in books)
    cp_files = []
    for cp in sorted(cp_set):
        cp_books = build_cp_index(books, cp)
        cp_bytes = json.dumps(cp_books, ensure_ascii=False, indent=1).encode('utf-8')
        filename = f'index-{cp}.json'
        local_path = os.path.join(ROOT, filename)
        with open(local_path, 'w', encoding='utf-8') as f:
            json.dump(cp_books, f, ensure_ascii=False, indent=1)
        cp_files.append((filename, cp_bytes))
        print(f'  [{filename}] {len(cp_books)} entries, {len(cp_bytes):,} bytes')

    # 4. upload to OSS
    print('\nUploading to OSS...')
    try:
        upload_to_oss('summary.json', summary_bytes)
        upload_to_oss('index-lite.json', lite_bytes)
        for filename, data in cp_files:
            upload_to_oss(filename, data)
        print(f'\n=== All done! Uploaded 2 + {len(cp_files)} = {2 + len(cp_files)} files to OSS.')
    except Exception as e:
        print(f'\n[WARNING] OSS upload failed: {e}')
        print('Files saved locally. Run again or upload manually when OSS credentials are ready.')


if __name__ == '__main__':
    main()
