# -*- coding: utf-8 -*-
"""把 library/ 上传到 OSS，并生成上传 index.json。幂等：已存在的文件跳过。"""
import os, json, sys, time
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
import oss2

auth = oss2.Auth(os.environ['OSS_ACCESS_KEY_ID'], os.environ['OSS_ACCESS_KEY_SECRET'])
bucket = oss2.Bucket(auth, os.environ['OSS_ENDPOINT'], os.environ['OSS_BUCKET'])

ROOT = os.path.join(os.path.dirname(__file__), '..')

def main():
    manifest = json.load(open(os.path.join(ROOT, 'library-manifest.json'), encoding='utf-8'))

    # 1. 生成 index.json（PWA 消费的 schema）
    index = [{
        'id': i + 1,
        'title': b['title'],
        'cp': b['cp'],
        'file': 'library/%s/%s.txt' % (b['cp'], b['title']),
        'chars': b.get('chars', 0),
        'bytes': b.get('bytes', 0),
        'recommended': bool(b.get('recommended')),
    } for i, b in enumerate(manifest)]
    idx_path = os.path.join(ROOT, 'index.json')
    json.dump(index, open(idx_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('index.json entries:', len(index))

    # 2. 收集 OSS 上已有文件（断点续传）
    existing = set()
    for obj in oss2.ObjectIteratorV2(bucket):
        existing.add(obj.key)
    print('already on OSS:', len(existing))

    # 3. 上传 index.json（每次都覆盖，便宜）
    bucket.put_object_from_file('index.json', idx_path)
    print('index.json uploaded')

    # 4. 上传书库
    total = done = skipped = failed = 0
    t0 = time.time()
    for b in index:
        total += 1
        key = b['file']
        if key in existing:
            skipped += 1
            continue
        local = os.path.join(ROOT, 'library', b['cp'], b['title'] + '.txt')
        if not os.path.exists(local):
            print('MISSING local:', local)
            failed += 1
            continue
        try:
            bucket.put_object_from_file(key, local)
            done += 1
        except Exception as e:
            print('FAIL', key, repr(e)[:120])
            failed += 1
        if (done + skipped) % 100 == 0:
            rate = (done) / max(time.time() - t0, 1)
            print('progress: %d/%d uploaded, %d skipped, %d failed, %.1f files/s' % (done, total, skipped, failed, rate), flush=True)
    print('DONE uploaded=%d skipped=%d failed=%d total=%d elapsed=%.0fs' % (done, skipped, failed, total, time.time() - t0))

if __name__ == '__main__':
    main()
