# -*- coding: utf-8 -*-
"""
把 D:\\CLAUDE\\01-HP同人\\03-原小说库 整理成干净的 UTF-8 TXT 库 + 清单。
用法:
    python extract_library.py                 # 全量
    python extract_library.py --only 小龙     # 只跑某个 CP 文件夹
    python extract_library.py --limit 20      # 每个文件夹最多处理 N 个文件(测试用)
"""
import argparse
import csv
import html as html_mod
import json
import os
import re
import shutil
import string
import subprocess
import sys
import tempfile
import time
import unicodedata
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

LIB_ROOT = Path(r"D:\CLAUDE\01-HP同人\03-原小说库")
OUT_ROOT = Path(r"D:\CLAUDE\fanst-app\library")
MANIFEST_PATH = Path(r"D:\CLAUDE\fanst-app\library-manifest.json")
REPORT_PATH = Path(r"D:\CLAUDE\fanst-app\extract-report.md")
UNMATCHED_CSV_PATH = Path(r"D:\CLAUDE\fanst-app\unmatched-recommended.csv")
RECOMMENDED_CSV = Path(r"C:\Users\sageh\Downloads\已推荐小说收集_公号已推荐小说_表格.csv")
SEVEN_ZIP = r"C:\Program Files\7-Zip\7z.exe"

ARCHIVE_EXTS = {".rar", ".zip", ".7z"}
SKIP_EXTS = {".pdf", ".mobi", ".xltd", ".cfg", ".ffs_tmp", ".azw3", ".doc", ".docx"}
HTML_EXTS = {".html", ".htm"}

try:
    import chardet
except ImportError:
    chardet = None

# ---------------------------------------------------------------- 基础工具

def decode_bytes(data: bytes):
    """返回 (text, encoding) 或抛 UnicodeDecodeError。"""
    for enc in ("utf-8", "gb18030"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            pass
    if chardet is not None:
        guess = chardet.detect(data)
        enc = guess.get("encoding")
        if enc and enc.lower() not in ("utf-8", "gb18030", "gb2312", "gbk"):
            try:
                return data.decode(enc), enc
            except (UnicodeDecodeError, LookupError):
                pass
    # 兜底:文件尾部截断或夹杂坏字节,用 replace 尽力解码
    if chardet is not None:
        enc = chardet.detect(data).get("encoding")
        if enc:
            try:
                return data.decode(enc, errors="replace"), f"{enc}(有损)"
            except LookupError:
                pass
    return data.decode("gb18030", errors="replace"), "gb18030(有损)"


PREFIX_RE = re.compile(r"^\s*【[^】]*】\s*")


def clean_title(filename: str) -> str:
    stem = Path(filename).stem
    stem = PREFIX_RE.sub("", stem)
    # 去掉尾部的 【...】 也不罕见,顺手清掉
    stem = re.sub(r"\s*【[^】]*】\s*$", "", stem)
    return stem.strip()


TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
BR_RE = re.compile(r"<(br|/p|/div|/h[1-6]|/li|/tr)[^>]*>", re.I)


def html_to_text(raw: str) -> str:
    raw = SCRIPT_RE.sub(" ", raw)
    raw = BR_RE.sub("\n", raw)
    raw = TAG_RE.sub("", raw)
    raw = html_mod.unescape(raw)
    raw = re.sub(r"[ \t　]+", " ", raw)
    raw = re.sub(r"\n\s*\n+", "\n\n", raw)
    return raw.strip()


def epub_to_text(path: Path) -> str:
    parts = []
    with zipfile.ZipFile(path) as zf:
        names = [n for n in zf.namelist()
                 if n.lower().endswith((".html", ".htm", ".xhtml"))]
        names.sort()
        for n in names:
            try:
                text, _ = decode_bytes(zf.read(n))
            except UnicodeDecodeError:
                continue
            parts.append(html_to_text(text))
    return "\n\n".join(p for p in parts if p)


PUNCT_TABLE = {c: None for c in (string.punctuation +
                                 "　 \t，。！？、；：‘’“”（）《》〈〉【】…—·～「」『』")}


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    return s.lower().translate(PUNCT_TABLE)

# ---------------------------------------------------------------- 单文件处理

def process_txt(path: Path):
    """返回 (text, note) ; 失败抛异常"""
    text, enc = decode_bytes(path.read_bytes())
    note = None if enc == "utf-8" else f"转码 {enc}->utf-8"
    return text, note


def process_epub(path: Path):
    text = epub_to_text(path)
    if not text:
        raise ValueError("epub 解析后无文本内容")
    return text, "epub 剥标签转文本"


def docx_to_text(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        raw = zf.read("word/document.xml").decode("utf-8", "replace")
    raw = re.sub(r"</w:p>", "\n", raw)
    return html_to_text(raw)


def pick_txts_from_extract(extract_dir: Path, depth: int = 0):
    """在解压目录里找正文 txt。
    返回 (items, notes, err):
      items: [(text, suffix, note)]  每个要输出的书
      notes: 报告备注列表
      err:   失败原因(无 txt 时)"""
    all_files = [p for p in extract_dir.rglob("*") if p.is_file()]
    txts = [p for p in all_files if p.suffix.lower() == ".txt"]
    notes = []
    if txts:
        txts.sort(key=lambda p: p.stat().st_size, reverse=True)
        largest = txts[0].stat().st_size
        # 多册判定:体积 >= 100KB 且 >= 最大文件的一半,视为另一册
        big = [p for p in txts
               if p.stat().st_size >= 100_000 and p.stat().st_size >= largest * 0.5]
        items = []
        if len(big) > 1:
            for i, p in enumerate(big, 1):
                text, _ = decode_bytes(p.read_bytes())
                items.append((text, f"_{i}", f"一书多册第 {i} 部分({p.name})"))
            dropped = [p.name for p in txts if p not in big]
            if dropped:
                notes.append(f"多 txt,保留 {len(big)} 个大文件,忽略: {', '.join(dropped[:5])}")
        else:
            text, _ = decode_bytes(txts[0].read_bytes())
            items.append((text, "", None))
            if len(txts) > 1:
                others = ", ".join(p.name for p in txts[1:6])
                notes.append(f"共 {len(txts)} 个 txt,取最大的({txts[0].name}),其余: {others}")
        return items, notes, None
    # 没有 txt,找 html
    htmls = [p for p in all_files if p.suffix.lower() in HTML_EXTS]
    if htmls:
        htmls.sort(key=lambda p: p.stat().st_size, reverse=True)
        raw, _ = decode_bytes(htmls[0].read_bytes())
        text = html_to_text(raw)
        if text:
            return [(text, "", f"无 txt,由 {htmls[0].name} 剥标签转换")], notes, None
        return [], notes, "html 剥标签后无文本内容"
    # 没有 txt/html,尝试包内的 epub
    epubs = [p for p in all_files if p.suffix.lower() == ".epub"]
    if epubs:
        epubs.sort(key=lambda p: p.stat().st_size, reverse=True)
        try:
            text = epub_to_text(epubs[0])
        except Exception as e:  # noqa: BLE001
            return [], notes, f"包内 epub 解析失败: {e}"
        if text:
            return [(text, "", f"无 txt,由包内 {epubs[0].name} (epub) 转换")], notes, None
        return [], notes, "包内 epub 剥标签后无文本内容"
    # 尝试包内的 docx
    docxs = [p for p in all_files if p.suffix.lower() == ".docx"]
    if docxs:
        docxs.sort(key=lambda p: p.stat().st_size, reverse=True)
        try:
            text = docx_to_text(docxs[0])
        except Exception as e:  # noqa: BLE001
            return [], notes, f"包内 docx 解析失败: {e}"
        if text:
            return [(text, "", f"无 txt,由包内 {docxs[0].name} (docx) 转换")], notes, None
        return [], notes, "包内 docx 解析后无文本内容"
    # 嵌套压缩包,递归一层
    nested = [p for p in all_files if p.suffix.lower() in ARCHIVE_EXTS]
    if nested and depth < 2:
        nested.sort(key=lambda p: p.stat().st_size, reverse=True)
        inner = Path(tempfile.mkdtemp(prefix="fanst_n_", dir=tempfile.gettempdir()))
        try:
            r = subprocess.run(
                [SEVEN_ZIP, "x", f"-o{inner}", "-y", str(nested[0])],
                capture_output=True, timeout=300)
            if r.returncode != 0:
                return [], notes, f"嵌套压缩包 {nested[0].name} 解压失败(7z 退出码 {r.returncode})"
            items, n2, err = pick_txts_from_extract(inner, depth + 1)
            notes = n2 + notes
            if items:
                items = [(t, s, (nt or "") + f"[来自嵌套包 {nested[0].name}]") for t, s, nt in items]
            return items, notes, err
        finally:
            shutil.rmtree(inner, ignore_errors=True)
    kinds = sorted({p.suffix.lower() or p.name for p in all_files})[:8]
    return [], notes, f"压缩包内无 txt/html/epub/docx(内含: {', '.join(kinds) or '空'})"


def process_archive(path: Path):
    """返回 (items, notes);失败抛异常"""
    tmp = Path(tempfile.mkdtemp(prefix="fanst_", dir=tempfile.gettempdir()))
    try:
        r = subprocess.run(
            [SEVEN_ZIP, "x", f"-o{tmp}", "-y", str(path)],
            capture_output=True, timeout=300)
        if r.returncode != 0 and not any(tmp.rglob("*")):
            raise RuntimeError(f"7z 退出码 {r.returncode}(可能加密或损坏)")
        items, notes, err = pick_txts_from_extract(tmp)
        if r.returncode != 0 and items:
            notes.insert(0, f"7z 报错(退出码 {r.returncode},包可能损坏)但仍提取到内容,正文可能不完整")
        return items, notes, err
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def process_one(cp: str, path: Path, source: str = None):
    """处理单个源文件。
    返回 dict: {status: ok/skip/fail, ...}"""
    ext = path.suffix.lower()
    base = {"cp": cp, "source": source or path.name, "ext": ext or path.name}
    try:
        if ext == ".txt":
            text, note = process_txt(path)
            items = [(text, "", note)]
            notes = []
        elif ext == ".epub":
            text, note = process_epub(path)
            items = [(text, "", note)]
            notes = []
        elif ext in ARCHIVE_EXTS:
            items, notes, err = process_archive(path)
            if err:
                return {**base, "status": "fail", "reason": err}
        elif ext in SKIP_EXTS or path.name.lower().startswith(".ds_store"):
            return {**base, "status": "skip", "reason": f"{ext or path.name} 格式跳过"}
        else:
            return {**base, "status": "skip", "reason": f"未知格式 {ext or path.name} 跳过"}
        title = clean_title(path.name)
        if not title:
            return {**base, "status": "fail", "reason": "书名清洗后为空"}
        return {**base, "status": "ok", "title": title, "items": items, "notes": notes}
    except subprocess.TimeoutExpired:
        return {**base, "status": "fail", "reason": "7z 解压超时(300s)"}
    except UnicodeDecodeError:
        return {**base, "status": "fail", "reason": "编码无法识别(utf-8/gb18030/chardet 均失败)"}
    except Exception as e:  # noqa: BLE001
        return {**base, "status": "fail", "reason": f"{type(e).__name__}: {e}"}

# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只处理某个 CP 文件夹名")
    ap.add_argument("--limit", type=int, default=0, help="每个文件夹最多处理文件数")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    t0 = time.time()
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    cp_dirs = sorted(p for p in LIB_ROOT.iterdir() if p.is_dir())
    if args.only:
        cp_dirs = [p for p in cp_dirs if p.name == args.only]
        if not cp_dirs:
            sys.exit(f"找不到文件夹: {args.only}")

    tasks = []
    for d in cp_dirs:
        files = sorted(p for p in d.rglob("*") if p.is_file())
        if args.limit:
            files = files[: args.limit]
        for p in files:
            tasks.append((d.name, p, str(p.relative_to(d))))
    print(f"共 {len(tasks)} 个文件待处理, workers={args.workers}", flush=True)

    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_one, cp, p, src): (cp, p) for cp, p, src in tasks}
        for fut in as_completed(futs):
            results.append(fut.result())
            done += 1
            if done % 200 == 0:
                ok = sum(1 for r in results if r["status"] == "ok")
                print(f"  进度 {done}/{len(tasks)} (成功 {ok}) "
                      f"已用 {time.time()-t0:.0f}s", flush=True)

    # ---- 汇总,写入库(同名冲突保留先处理的:按 cp/书名/源文件名排序保证稳定)
    ok_results = sorted((r for r in results if r["status"] == "ok"),
                        key=lambda r: (r["cp"], r["title"], r["source"]))
    fails = [r for r in results if r["status"] == "fail"]
    skips = [r for r in results if r["status"] == "skip"]

    manifest = []
    seen = {}          # (cp, title) -> source
    duplicates = []    # (cp, title, kept_source, dup_source)
    extra_notes = []   # 多 txt 等备注
    for r in ok_results:
        for text, suffix, note in r["items"]:
            title = r["title"] + suffix
            key = (r["cp"], title)
            if key in seen:
                duplicates.append((r["cp"], title, seen[key], r["source"]))
                continue
            seen[key] = r["source"]
            out_path = OUT_ROOT / r["cp"] / f"{title}.txt"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            data = text.encode("utf-8")
            out_path.write_bytes(data)
            manifest.append({
                "id": "", "title": title, "cp": r["cp"],
                "file": f"{r['cp']}/{title}.txt",
                "chars": len(text), "bytes": len(data),
                "source": r["source"], "recommended": False,
            })
            if note:
                extra_notes.append(f"- `{r['source']}` → `{title}.txt`: {note}")
        for n in r["notes"]:
            extra_notes.append(f"- `{r['source']}`: {n}")

    manifest.sort(key=lambda m: (m["cp"], m["title"]))
    for i, m in enumerate(manifest, 1):
        m["id"] = str(i)

    # ---- 已推荐匹配
    matched_titles = set()
    unmatched_rows = []
    if RECOMMENDED_CSV.exists():
        with open(RECOMMENDED_CSV, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
        header, data_rows = rows[0], rows[1:]
        norm_map = {}
        for m in manifest:
            norm_map.setdefault(normalize(m["title"]), []).append(m)
        norm_list = [(normalize(m["title"]), m) for m in manifest]
        for row in data_rows:
            if len(row) < 2:
                continue
            title_cell = row[1].strip()
            n = normalize(title_cell)
            hit = None
            if n and n in norm_map:
                hit = norm_map[n][0]
            elif len(n) >= 3:  # 太短不做包含匹配,避免误伤
                for tn, m in norm_list:
                    if n in tn or (len(tn) >= 3 and tn in n):
                        hit = m
                        break
            if hit is not None:
                hit["recommended"] = True
                matched_titles.add(title_cell)
            else:
                unmatched_rows.append(row)
        with open(UNMATCHED_CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(header)
            w.writerows(unmatched_rows)

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    # ---- 报告
    total_bytes = sum(m["bytes"] for m in manifest)
    rec_count = sum(1 for m in manifest if m["recommended"])
    fmt_counts = {}
    for r in results:
        k = f"{r['ext'] or '(无扩展)'}"
        fmt_counts.setdefault(k, {"ok": 0, "fail": 0, "skip": 0})
        fmt_counts[k][r["status"]] += 1

    lines = ["# 小说库整理报告", "",
             f"- 源目录: `{LIB_ROOT}`",
             f"- 输出: `{OUT_ROOT}`",
             f"- 耗时: {time.time()-t0:.0f} 秒",
             f"- **成功转换 {len(manifest)} 本**(源文件 {len(ok_results)} 个),"
             f"失败 {len(fails)} 个,跳过 {len(skips)} 个",
             f"- TXT 库总大小: {total_bytes/1024/1024:.1f} MB",
             f"- 已推荐标记: {rec_count} 本匹配成功, {len(unmatched_rows)} 行未匹配",
             "", "## 各格式处理数量", "",
             "| 格式 | 成功 | 失败 | 跳过 |", "|---|---|---|---|"]
    for k in sorted(fmt_counts):
        c = fmt_counts[k]
        lines.append(f"| {k} | {c['ok']} | {c['fail']} | {c['skip']} |")
    lines += ["", "## 失败文件列表", ""]
    for r in sorted(fails, key=lambda x: x["source"]):
        lines.append(f"- `{r['cp']}/{r['source']}`: {r['reason']}")
    if not fails:
        lines.append("（无）")
    lines += ["", "## 跳过的文件", ""]
    for r in sorted(skips, key=lambda x: x["source"]):
        lines.append(f"- `{r['cp']}/{r['source']}`: {r['reason']}")
    if not skips:
        lines.append("（无）")
    lines += ["", "## 重复书名(保留先处理的)", ""]
    for cp, t, kept, dup in duplicates:
        lines.append(f"- `{cp}/{t}`: 保留 `{kept}`,丢弃 `{dup}`")
    if not duplicates:
        lines.append("（无）")
    lines += ["", "## 处理备注(多 txt 取舍 / 转码 / 多册拆分等)", ""]
    lines += extra_notes or ["（无）"]
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")

    print(f"完成: 成功 {len(manifest)} / 失败 {len(fails)} / 跳过 {len(skips)}, "
          f"耗时 {time.time()-t0:.0f}s", flush=True)
    print(f"库大小 {total_bytes/1024/1024:.1f} MB, 已推荐匹配 {rec_count}, "
          f"未匹配 {len(unmatched_rows)}", flush=True)


if __name__ == "__main__":
    main()
