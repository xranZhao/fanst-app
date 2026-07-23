const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

let state = {
  tab: 'library',
  books: [],          // 当前显示的书籍列表
  booksLite: [],      // index-lite 全量摘要（搜索用）
  summary: null,      // summary.json 统计信息
  booksLoaded: {},    // {cp: true} 已加载的 CP 分片
  cpCache: {},        // {cp: [books]} 已加载的 CP 完整数据缓存
  currentCp: 'all',   // 当前选中的 CP
  progress: {},
  uploaded: [],
  currentBook: null,
  readReport: null,
  topics: null,
  titleOptions: [],
  selectedTitle: '',
  attributeOptions: [],
  selectedAttribute: '',
  editingMd: '',
  draftMd: null,
  finalMd: null,
  previewMode: false,
};

const OSS_BASE = `https://${CONFIG.OSS_BUCKET}.${CONFIG.OSS_ENDPOINT}/`;

function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2500);
}

function navTo(tab) {
  state.tab = tab;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'library') renderLibrary();
  if (tab === 'upload') renderUpload();
  if (tab === 'articles') renderArticles();
}

function getOssClient() {
  return new OSS({
    region: `oss-cn-wuhan-lr`,
    accessKeyId: CONFIG.OSS_KEY_ID,
    accessKeySecret: CONFIG.OSS_KEY_SECRET,
    bucket: CONFIG.OSS_BUCKET,
    secure: true,
  });
}

async function ossGet(path) {
  const cacheBuster = `?t=${Date.now()}`;
  const res = await fetch(OSS_BASE + encodeURIComponent(path).replace(/%2F/g, '/') + cacheBuster, { cache: 'no-store' });
  if (!res.ok) throw new Error(`OSS GET ${path} ${res.status}`);
  return res.text();
}

async function loadBooks() {
  try {
    // 1. 首屏：只加载 summary + index-lite（并行，~390KB total）
    const [summaryJson, liteJson] = await Promise.all([
      ossGet(CONFIG.OSS_SUMMARY).catch(() => null),
      ossGet(CONFIG.OSS_INDEX_LITE).catch(() => null),
    ]);
    state.summary = summaryJson ? JSON.parse(summaryJson) : null;
    state.booksLite = liteJson ? JSON.parse(liteJson) : [];
    // 2. 加载 progress
    try {
      const prog = JSON.parse(await ossGet(CONFIG.OSS_PROGRESS));
      state.progress = prog || {};
    } catch (e) {}
    // 3. 全标签装 lite 数据（不含 file 路径，不可下载；点书时懒加载对应 CP 完整索引）
    state.books = state.booksLite;
    state.currentCp = 'all';
    // 4. 后台静默预热第一个有书的 CP 的完整索引
    const firstCp = CP_LIST.find(cp => (state.summary?.cps?.[cp] || 0) > 0);
    if (firstCp) switchCp(firstCp).then(() => {
      // 预热成功后恢复回 all（仅缓存，不切换显示）
      state.books = state.booksLite;
      state.currentCp = 'all';
    });
    renderLibrary();
  } catch (e) {
    $('#main').innerHTML = `<div class="loading">加载书库失败：${e.message}<br>请检查 OSS 设置和 Key</div>`;
  }
}

// 懒加载：切换 CP 时按需拉取完整索引（含 file 路径）
async function switchCp(cp) {
  if (cp === 'all') {
    state.books = state.booksLite;
    state.currentCp = 'all';
    return;
  }
  state.currentCp = cp;
  if (state.cpCache[cp]) {
    state.books = state.cpCache[cp];
    return;
  }
  // 如果这个 CP 还没加载过，就按需拉取
  try {
    const filename = CONFIG.OSS_INDEX_PREFIX + cp + '.json';
    const idx = JSON.parse(await ossGet(filename));
    state.cpCache[cp] = idx;
    state.books = idx;
    state.booksLoaded[cp] = true;
  } catch (e) {
    // 降级：用 lite 数据
    state.books = state.booksLite.filter(b => b.cp === cp);
    state.booksLoaded[cp] = true;
    console.warn('CP index load failed, using lite fallback:', cp, e.message);
  }
}

// 保留兼容旧接口
async function ensureBookCp(cp) {
  if (!cp || state.cpCache[cp]) return;
  await switchCp(cp);
  state.books = state.booksLite;
  state.currentCp = 'all';
  renderLibrary();
}

async function loadCpBooks(cp) {
  if (cp === 'all') { state.books = state.booksLite; state.currentCp = 'all'; }
  else await switchCp(cp);
  renderLibrary();
}

async function saveProgress() {
  if (!CONFIG.OSS_KEY_ID || !CONFIG.OSS_KEY_SECRET) return;
  try {
    const client = getOssClient();
    const blob = new Blob([JSON.stringify(state.progress)], {type: 'application/json'});
    client.put(CONFIG.OSS_PROGRESS, blob);
  } catch (e) { console.error('progress save fail', e); }
}

function cpFromFile(file) {
  const m = file.match(/library\/([^/]+)\//);
  return m ? m[1] : '待分类';
}

/* ===== Library ===== */
function renderLibrary() {
  // 统计栏
  const statsHtml = state.summary ? `
    <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:80px;background:var(--sky-pale);border-radius:10px;padding:10px 12px;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:var(--sky);">${state.summary.total.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted);">书库总数</div>
      </div>
      <div style="flex:1;min-width:80px;background:#fdf2f5;border-radius:10px;padding:10px 12px;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:var(--pink);">${state.summary.recommended.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted);">已推荐</div>
      </div>
      <div style="flex:1;min-width:80px;background:#f7f7f7;border-radius:10px;padding:10px 12px;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:var(--ink);">${Object.keys(state.progress).filter(k => state.progress[k] === 'passed').length.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted);">已过</div>
      </div>
      <div style="flex:1;min-width:80px;background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px 12px;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:#666;">${Object.keys(state.progress).filter(k => state.progress[k] === 'unread').length.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted);">待判定</div>
      </div>
    </div>` : '';

  $('#main').innerHTML = `
    <div class="screen" id="library-screen">
      ${statsHtml}
      <div class="filter-row" id="cp-filters">
        <button class="chip active" data-cp="all">全部</button>
        ${CP_LIST.map(cp => `<button class="chip" data-cp="${cp}">${cp}</button>`).join('')}
      </div>
      <input type="search" id="book-search" placeholder="搜索书名" style="margin-bottom:12px;">
      <div class="loading" id="cp-loading" style="display:none;padding:8px;">加载中...</div>
      <div class="book-list" id="book-list"></div>
    </div>`;
  const filter = (cp, q) => {
    let list = state.books.filter(b => b.title);  // lite 数据没有 file 字段也显示
    if (cp !== 'all') list = list.filter(b => b.cp === cp || cpFromFile(b.file || '') === cp);
    if (q) list = list.filter(b => b.title.toLowerCase().includes(q.toLowerCase()));
    renderBookList(list, cp);
  };
  $('#cp-filters').onclick = async (e) => {
    if (!e.target.classList.contains('chip')) return;
    $$('#cp-filters .chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    const cp = e.target.dataset.cp;
    if (cp !== 'all' && !state.cpCache[cp]) {
      $('#cp-loading').style.display = 'block';
      await switchCp(cp);
      $('#cp-loading').style.display = 'none';
    } else {
      // '全部' 直接用 booksLite
      if (cp === 'all') {
        state.books = state.booksLite;
        state.currentCp = 'all';
      } else {
        state.books = state.cpCache[cp];
        state.currentCp = cp;
      }
    }
    filter(cp, $('#book-search').value);
  };
  $('#book-search').oninput = (e) => filter($('#cp-filters .active').dataset.cp, e.target.value);
  filter('all', '');
}

function renderBookList(list, currentCp) {
  const el = $('#book-list');
  if (!list.length) { el.innerHTML = '<div class="loading">没有匹配的书</div>'; return; }
  el.innerHTML = list.map(b => {
    const status = state.progress[b.title] || (b.recommended ? 'recommended' : 'unread');
    const badge = status === 'recommended' ? '<span class="badge badge-rec">已推荐</span>' : status === 'passed' ? '<span class="badge badge-pass">已过</span>' : '';
    return `<div class="book-item" data-title="${escapeHtml(b.title)}" data-cp="${escapeHtml(b.cp || '')}" data-file="${escapeHtml(b.file || '')}">
      <div><div class="book-title">${escapeHtml(b.title)}</div><span class="book-cp">${escapeHtml(b.cp || cpFromFile(b.file))}</span> ${badge}</div>
      <span class="book-cp">${(b.chars/10000).toFixed(1)}万字</span>
    </div>`;
  }).join('');
  el.onclick = async (e) => {
    const item = e.target.closest('.book-item');
    if (!item) return;
    const title = item.dataset.title;
    let file = item.dataset.file;
    const cp = item.dataset.cp;
    // 如果文件路径为空（来自 lite 摘要），先加载该 CP 的完整索引
    if (!file && cp) {
      if (!state.cpCache[cp]) {
        item.style.opacity = '0.5';
        await switchCp(cp);
        // switchCp 会改 books，需要重新渲染后再找
        const idx = state.cpCache[cp];
        const full = idx ? idx.find(b => b.title === title && b.cp === cp) : null;
        if (full && full.file) {
          file = full.file;
        }
      } else {
        const full = state.cpCache[cp].find(b => b.title === title && b.cp === cp);
        if (full && full.file) file = full.file;
      }
    }
    if (!file) {
      showToast('无法获取该书文件路径，请切换到对应 CP 标签后再试');
      return;
    }
    const book = { title, file, cp, chars: 0, bytes: 0, recommended: false };
    // 优先从 cpCache 取完整数据
    if (cp && state.cpCache[cp]) {
      const full = state.cpCache[cp].find(b => b.title === title && b.file === file);
      if (full) Object.assign(book, full);
    }
    openBook(book);
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ===== Book flow ===== */
async function openBook(book) {
  $('#main').innerHTML = `<div class="loading"><div class="loading-spinner"></div><p>正在下载《${escapeHtml(book.title)}》...</p></div>`;
  try {
    const text = await ossGet(book.file);
    state.currentBook = { ...book, text };
    state.readReport = null;
    state.draftMd = null;
    showBookMenu();
  } catch (e) {
    $('#main').innerHTML = `<div class="loading">下载失败：${e.message}</div><button class="btn btn-primary btn-block" onclick="navTo('library')">返回书库</button>`;
  }
}

function showBookMenu() {
  const b = state.currentBook;
  const prog = state.progress[b.title];
  const statusBadge = prog === 'recommended' ? '<span style="color:var(--sky);font-size:12px;">（已推荐）</span>'
    : prog === 'passed' ? '<span style="color:var(--muted);font-size:12px;">（已过）</span>'
    : '';
  $('#main').innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="card-title">${escapeHtml(b.title)} ${statusBadge}</div>
        <div class="card-meta">${escapeHtml(b.cp || cpFromFile(b.file))} · ${(b.chars/10000).toFixed(1)}万字</div>
      </div>
      <button class="btn btn-primary btn-block" style="margin-bottom:12px;" id="btn-read">AI 阅读并判定</button>
      <button class="btn btn-ghost btn-block" onclick="navTo('library')">返回书库</button>
    </div>`;
  $('#btn-read').onclick = () => runReading();
}

function truncateText(text, maxChars=200000) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n（后文已截断，共 ${text.length} 字）`;
}

async function runReading() {
  if (!CONFIG.API_KEY) { alert('请先填 DeepSeek API Key'); openSettings(); return; }
  const b = state.currentBook;
  $('#main').innerHTML = `<div class="loading"><div class="loading-spinner"></div><p>AI 正在阅读《${escapeHtml(b.title)}》...<br>这是省钱的 Flash 模型，大概 30-90 秒</p></div>`;
  const text = truncateText(b.text, 200000);
  const prompt = `请阅读以下 HP 同人小说全文，输出一份结构化的阅读报告。要求：
1. 真实简介（基于原文，不要编造；控制在 2-3 句话）
2. CP、字数、完结状态（简明列出）
3. 文笔评价：是否流畅、情感描写是否细腻、剧情是否保留完整（控制在 1-2 句话）
4. 雷点 / 避雷预警：如强制婚姻、黑化、OOC、未完结、BE 等；其中 OOC 不作为主要推荐标准，仅作为避雷提示
5. 最终判定四选一：强推 / 可推 / 避雷可写 / 不推不写，并给出简短理由
6. 总字数控制在 1000 字以内，不要复述剧情细节，减少冗长描述

小说全文：\n${text}`;
  try {
    const res = await deepSeekChat(CONFIG.READ_MODEL, prompt, 4000);
    state.readReport = res;
    state.progress[b.title] = state.progress[b.title] || 'unread';
    saveProgress();
    showReadingReport();
  } catch (e) {
    $('#main').innerHTML = `<div class="loading">阅读失败：${e.message}<br><button class="btn btn-primary btn-block" onclick="showBookMenu()">重试</button></div>`;
  }
}

async function deepSeekChat(model, content, maxTokens=4000, timeoutMs=120000) {
  const MAX_RETRIES = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(CONFIG.BASE_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.API_KEY}` },
        body: JSON.stringify({ model, messages: [{role:'user', content}], max_tokens: maxTokens, temperature: 0.7 }),
      });
      clearTimeout(timer);
      if (!res.ok) {
        const txt = await res.text();
        // 429 限频 / 503 服务繁忙 不重试直接返回错误提示
        if (res.status === 429 || res.status === 503) {
          throw new Error(`服务繁忙 (${res.status})，请稍后重试。`);
        }
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`返回格式异常：${JSON.stringify(data).slice(0, 200)}`);
      }
      return data.choices[0].message.content;
    } catch (e) {
      lastError = e;
      // 用户取消/并发冲突等不重试
      if (e.message?.includes('服务繁忙') || e.name === 'CanceledError') {
        throw e;
      }
      const isNetwork = e.name === 'TypeError' || e.name === 'AbortError' || e.message?.includes('Failed to fetch');
      const reason = e.name === 'AbortError' ? '请求超时' : (isNetwork ? '网络连接失败' : e.message);
      console.error(`deepSeekChat 第 ${attempt}/${MAX_RETRIES} 次失败`, e);
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`已重试 ${MAX_RETRIES} 次仍失败：${lastError.message || lastError}`);
}

function showReadingReport() {
  const b = state.currentBook;
  const r = state.readReport;
  let verdict = '不推不写';
  if (r.includes('强推')) verdict = '强推';
  else if (r.includes('可推')) verdict = '可推';
  else if (r.includes('避雷可写')) verdict = '避雷可写';
  const color = verdict === '不推不写' ? '#888' : verdict === '避雷可写' ? '#E8739A' : '#3B82C5';
  $('#main').innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="card-title">${escapeHtml(b.title)}</div>
        <div class="card-meta" style="color:${color};font-weight:700;">判定：${verdict}</div>
      </div>
      <div style="background:#f7f7f7;padding:14px;border-radius:10px;font-size:14px;line-height:1.8;color:#3a3a3a;margin-bottom:16px;">${renderMarkdown(r)}</div>
      ${verdict === '不推不写' ? `
        <button class="btn btn-ghost btn-block" id="btn-pass">标记“已过”</button>
      ` : `
        <button class="btn btn-primary btn-block" id="btn-title-options" style="margin-bottom:12px;">生成标题候选</button>
        <button class="btn btn-ghost btn-block" id="btn-pass">这书不推，标记“已过”</button>
      `}
      <button class="btn btn-ghost btn-block" style="margin-top:12px;" onclick="showBookMenu()">返回上书详情</button>
      <button class="btn btn-ghost btn-block" style="margin-top:4px;" onclick="navTo('library')">返回书库</button>
    </div>`;
  $('#btn-pass').onclick = () => { state.progress[b.title] = 'passed'; saveProgress(); showToast('已标记“已过”'); navTo('library'); };
  const tbtn = $('#btn-title-options');
  if (tbtn) tbtn.onclick = () => generateTitleOptions(verdict);
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  lines.forEach(line => {
    let l = line.trim();
    if (!l) { html += '<br>'; return; }
    // heading
    const h = l.match(/^(#{1,3})\s+(.+)/);
    if (h) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h${h[1].length} style="font-weight:700;color:#1a1a1a;margin:12px 0 8px;">${inlineMd(h[2])}</h${h[1].length}>`;
      return;
    }
    // list item
    if (l.startsWith('- ') || l.startsWith('* ')) {
      if (!inList) { html += '<ul style="margin:0 0 10px 18px;padding:0;list-style:disc;">'; inList = true; }
      html += `<li style="margin-bottom:4px;">${inlineMd(l.slice(2))}</li>`;
      return;
    }
    if (inList) { html += '</ul>'; inList = false; }
    // plain paragraph
    html += `<p style="margin:0 0 8px;">${inlineMd(l)}</p>`;
  });
  if (inList) html += '</ul>';
  return html;
}

function inlineMd(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#1a1a1a;">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em style="color:#666;">$1</em>');
}

async function generateTitleOptions(verdict) {
  if (!state.readReport) return;
  $('#main').innerHTML = `<div class="loading"><div class="loading-spinner"></div><p>正在生成标题候选...</p></div>`;
  const prompt = `根据以下阅读报告，为这篇 HP 同人文的公众号推文生成 5 个标题候选。

要求：
- 每个标题贴合剧情、有吸引力、适合 1500 字公众号推文
- 不要夸张到失实，不要剧透核心反转
- 标题党但真诚，能勾起 HP 同好点击兴趣
- 判定调性为「${verdict}」：
  - 强推/可推：突出嗑点、张力、名场面氛围
  - 避雷可写：可带「避雷」「测评」「先别嗑」等警示感
- 只输出 5 行标题，每行前面加编号 1-5，不要多余解释

阅读报告：\n${state.readReport}`;
  try {
    const res = await deepSeekChat(CONFIG.WRITE_MODEL, prompt, 2000, 120000);
    state.titleOptions = parseNumberedList(res);
    if (!state.titleOptions.length) {
      state.titleOptions = [res.trim().split('\n').filter(Boolean).slice(0, 5).join('\n') || res.trim()];
    }
    showTitleSelector();
  } catch (e) {
    $('#main').innerHTML = `<div class="loading">标题生成失败：${e.message}</div><button class="btn btn-primary btn-block" onclick="showReadingReport()">重试</button>`;
  }
}

function parseNumberedList(md) {
  // 解析 1. / 1、/ 1) / **1.** 等编号列表；兼容 AI 返回带 markdown 格式的行
  let lines = md.split('\n').map(l => l.trim()).filter(Boolean);
  lines = lines.map(l => {
    return l.replace(/^\d+[\.、)）\s]+/, '').replace(/^[-*]\s+/, '').replace(/^\*\*\d+[\.、)）\s]*\*\*\s*/, '').trim();
  }).filter(l => {
    if (l.length <= 2) return false;
    // 过滤引导语
    if (/^(以下|以上|根据|注意|备注|说明|示例|提示|好的|这是|以下列)/.test(l)) return false;
    return true;
  });
  // 降级：过滤后为空，把所有非空行当候选
  if (!lines.length) {
    lines = md.split('\n').map(l => l.trim()).filter(Boolean).filter(l => l.length > 2 && !/^(以下|以上|根据|注意|备注|说明|示例|提示|好的|这是)/.test(l));
  }
  return lines;
}

function showTitleSelector() {
  $('#main').innerHTML = `
    <div class="screen">
      <h3 style="margin-top:0;margin-bottom:12px;">选择文章标题</h3>
      <div class="option-list" id="title-options">
        ${state.titleOptions.map((t, i) => `
          <label class="option-row" style="word-break:break-word;">
            <input type="radio" name="title" value="${escapeHtml(t)}" ${i === 0 ? 'checked' : ''}>
            <span class="option-text">${escapeHtml(t)}</span>
          </label>
        `).join('')}
      </div>
      <div class="setting-group" style="margin-top:16px;">
        <div class="setting-label">或自定义标题</div>
        <input type="text" id="custom-title" placeholder="输入你想用的标题">
      </div>
      <button class="btn btn-primary btn-block" id="btn-next-attr" style="margin-top:16px;">下一步：选择属性</button>
      <button class="btn btn-ghost btn-block" style="margin-top:12px;" onclick="showReadingReport()">返回</button>
    </div>`;
  $('#btn-next-attr').onclick = () => {
    const custom = $('#custom-title').value.trim();
    const selected = custom || document.querySelector('input[name="title"]:checked')?.value;
    if (!selected) { showToast('请选择一个标题'); return; }
    state.selectedTitle = selected;
    generateAttributeOptions();
  };
}

async function generateAttributeOptions() {
  if (!state.readReport) return;
  $('#main').innerHTML = `<div class="loading"><div class="loading-spinner"></div><p>正在生成人物属性候选...<br>大概 20-40 秒</p></div>`;
  const prompt = `根据以下阅读报告，为这篇 HP 同人文生成 3 个人物属性描述候选。

要求：
- 每个候选用一句短语概括两个核心人物，格式如：「铁腕政治家救世主哈利 × 落魄斯莱特林王子德拉科」
- 突出角色设定和 CP 张力，有画面感
- 输出格式：每行一个候选，前面加编号 1. 2. 3.，不要额外解释文字

阅读报告：\n${state.readReport}`;
  try {
    const res = await deepSeekChat(CONFIG.WRITE_MODEL, prompt, 2000, 120000);
    state.attributeOptions = parseNumberedList(res);
    if (!state.attributeOptions.length) {
      state.attributeOptions = [res.trim().split('\n').filter(Boolean).slice(0, 3).join('\n') || res.trim()];
    }
    if (!state.attributeOptions.length) {
      state.attributeOptions = ['从阅读报告提取的属性'];
    }
    // 如果只有一个占了全宽文本，拆分一下
    if (state.attributeOptions.length === 1 && state.attributeOptions[0].length > 60) {
      const parts = state.attributeOptions[0].split(/[;；\n]/).filter(s => s.trim().length > 3);
      if (parts.length >= 2) state.attributeOptions = parts;
    }
    showAttributeSelector();
  } catch (e) {
    $('#main').innerHTML = `<div class="loading">属性生成失败：${e.message}</div><button class="btn btn-primary btn-block" onclick="showTitleSelector()">重试</button>`;
  }
}

function showAttributeSelector() {
  $('#main').innerHTML = `
    <div class="screen">
      <h3 style="margin-top:0;">选择人物属性</h3>
      <div class="option-list" id="attr-options">
        ${state.attributeOptions.map((a, i) => `
          <label class="option-row">
            <input type="radio" name="attr" value="${escapeHtml(a)}" ${i === 0 ? 'checked' : ''}>
            <span class="option-text">${escapeHtml(a)}</span>
          </label>
        `).join('')}
      </div>
      <div class="setting-group" style="margin-top:16px;">
        <div class="setting-label">或自定义属性</div>
        <input type="text" id="custom-attr" placeholder="例如：温柔隐忍赫敏 × 锋芒毕露德拉科">
      </div>
      <button class="btn btn-primary btn-block" id="btn-generate-draft" style="margin-top:16px;">生成初稿</button>
      <button class="btn btn-ghost btn-block" style="margin-top:12px;" onclick="showTitleSelector()">返回改标题</button>
    </div>`;
  $('#btn-generate-draft').onclick = () => {
    const custom = $('#custom-attr').value.trim();
    const selected = custom || document.querySelector('input[name="attr"]:checked')?.value;
    if (!selected) { showToast('请选择一个人物属性'); return; }
    state.selectedAttribute = selected;
    generateDraft();
  };
}

async function generateDraft() {
  const b = state.currentBook;
  $('#main').innerHTML = `<div class="loading"><div class="loading-spinner"></div><p>正在用 Pro 模型写初稿...<br>网络波动会自动重试 3 次，请稍候</p></div>`;
  const styleGuide = await loadStyleGuide();
  const is避雷 = state.readReport.includes('避雷可写');
  const sections = is避雷
    ? '00 小说哪里看 | 01 避雷点 | 02 Fanst 碎碎念 | 03 踩雷预警 | 04 最戳我的一个槽点 | 05 综合评价'
    : '00 小说哪里看 | 01 文案推荐 | 02 Fanst 碎碎念 | 03 名场面预警 | 04 最戳我的一个细节 | 05 综合评价';
  const title = state.selectedTitle || b.title;
  const attr = state.selectedAttribute || '待补充';
  const prompt = `请根据以下信息，按「杂志风推文」结构写初稿，直接输出 Markdown。

注意：不要输出标题行（标题会单独展示），直接从正文信息卡开始。

固定信息卡格式（必须严格遵循）：

**基本信息卡**
- **原作**：《${b.title}》${b.titleEn ? ' / ' + b.titleEn : ''}
- **作者**：从阅读报告或小说原文中提取真实作者；若无法提取或阅读报告未署名，请直接删除这一行，不要写“待考”“未知”
- **分级**：[沿用 AO3 或阅读报告中的分级，如 Mature / R / NC-17]（[补充说明，如含婚内压力、成人议题等]）
- **属性**：${attr}
- **CP**：[主 CP，按阅读报告提取]
- **标签**：[自由生成 3-6 个贴合的标签，如 战后、正剧向、相互救赎]

${sections}

阅读报告（仅供参考，不要复述细节）：
\n${state.readReport}

风格指南：
${styleGuide}

要求：
- 全文控制在 1500 字左右（含信息卡），不要写成 4000-5000 字长文
- 每章 1-3 段短段落，不要复述大量剧情，只保留最能支撑标题角度的 1-2 个细节/名场面
- 标题党但真诚，不要夸张到失实
- 文案口语化，像 HP磕学家 的推文风格
- 结尾固定放「所有荣誉与利益属于作者和创作者，Fanst 只是同人文的搬运工。」和「💬 非常需要你的推荐留言或观后感！」
- 不要在文中出现小说文件编码或乱码`;
  try {
    const res = await deepSeekChat(CONFIG.WRITE_MODEL, prompt, 6000, 180000);
    state.draftMd = res;
    state.finalMd = res;
    showRevise();
  } catch (e) {
    $('#main').innerHTML = `<div class="loading">初稿失败：${e.message}</div><button class="btn btn-primary btn-block" onclick="showAttributeSelector()">重试</button>`;
  }
}

async function loadStyleGuide() {
  try {
    return await ossGet(CONFIG.OSS_STYLE_GUIDE) || '无';
  } catch (e) {
    return await seedStyleGuide();
  }
}

async function seedStyleGuide() {
  // 初始风格，从项目已有推文风格提炼
  return `风格基调：克制编辑部风。标题用悬念式，正文口语真诚。多用细节和名场面引用，少空泛形容词。强调作者和原作荣誉。`;
}

/* ===== Revise / Manual edit ===== */
function showRevise() {
  state.previewMode = false;
  state.editingMd = state.draftMd || '';
  const title = state.selectedTitle || (state.currentBook?.title || '推文标题');
  $('#main').innerHTML = `
    <div class="screen" style="padding-bottom:120px;">
      <div class="title-card">
        <div class="title-label">文章标题</div>
        <div class="title-value">${escapeHtml(title)}</div>
        <button class="btn btn-ghost btn-block" id="btn-copy-title-revise" style="margin-top:8px;">复制标题</button>
      </div>
      <div class="chat-bubble ai">这是初稿。你可以直接编辑 Markdown，也可以告诉我改哪里。点击下方切换可预览渲染效果。</div>
      <div class="editor-tabs">
        <button class="editor-tab active" id="tab-edit" type="button">编辑</button>
        <button class="editor-tab" id="tab-preview" type="button">预览</button>
      </div>
      <div id="editor-area">
        <textarea class="editor-textarea" id="md-editor">${escapeHtml(state.draftMd)}</textarea>
      </div>
      <div class="setting-group">
        <div class="setting-label">告诉 AI 怎么改（可选）</div>
        <input type="text" id="revise-input" placeholder="例如：第二段太啰嗦，第三段加一段名场面">
      </div>
      <button class="btn btn-primary btn-block" id="btn-ai-revise" style="margin-bottom:10px;">让 AI 按上面意见改</button>
      <button class="btn btn-pink btn-block" id="btn-finalize" style="margin-bottom:10px;">定稿并渲染</button>
      <button class="btn btn-ghost btn-block" onclick="showAttributeSelector()">返回改属性</button>
    </div>`;
  $('#btn-copy-title-revise').onclick = () => copyText(title);
  $('#btn-ai-revise').onclick = aiRevise;
  $('#btn-finalize').onclick = () => {
    state.finalMd = $('#md-editor').value;
    showFinal();
  };
  $('#tab-edit').onclick = () => switchEditorTab(false);
  $('#tab-preview').onclick = () => switchEditorTab(true);
}

function switchEditorTab(preview) {
  state.previewMode = preview;
  $$('.editor-tab').forEach(t => t.classList.toggle('active', t.id === (preview ? 'tab-preview' : 'tab-edit')));
  const area = $('#editor-area');
  if (preview) {
    state.editingMd = $('#md-editor').value;
    area.innerHTML = `<div class="editor-preview">${renderMarkdown(state.editingMd)}</div>`;
  } else {
    area.innerHTML = `<textarea class="editor-textarea" id="md-editor">${escapeHtml(state.editingMd || state.draftMd || '')}</textarea>`;
  }
}

async function aiRevise() {
  const instruction = $('#revise-input').value.trim();
  if (!instruction) { showToast('请先写修改意见'); return; }
  const current = $('#md-editor') ? $('#md-editor').value : (state.editingMd || state.draftMd || '');
  $('#btn-ai-revise').textContent = '修改中...';
  const prompt = `请根据以下要求修改推文初稿。只返回修改后的完整 Markdown，不要解释。

要求：${instruction}

当前初稿：\n${current}`;
  try {
    const res = await deepSeekChat(CONFIG.WRITE_MODEL, prompt, 6000, 180000);
    state.editingMd = res;
    state.draftMd = res;
    state.finalMd = res;
    if (state.previewMode) {
      switchEditorTab(true);
    } else {
      $('#md-editor').value = res;
    }
    $('#btn-ai-revise').textContent = '让 AI 按上面意见改';
    showToast('已修改');
  } catch (e) {
    $('#btn-ai-revise').textContent = '让 AI 按上面意见改';
    alert('修改失败：' + e.message);
  }
}

/* ===== Final ===== */
function showFinal() {
  const html = renderMagazineInline(state.finalMd, state.selectedTitle);
  const title = state.selectedTitle || (state.currentBook?.title || '推文标题');
  $('#main').innerHTML = `
    <div class="screen" style="padding-bottom:120px;">
      <div class="title-card">
        <div class="title-label">文章标题</div>
        <div class="title-value" id="article-title">${escapeHtml(title)}</div>
        <button class="btn btn-ghost btn-block" id="btn-copy-title" style="margin-top:8px;">复制标题</button>
      </div>
      <div class="preview-wrap" id="preview-box">${html}</div>
      <button class="btn btn-primary btn-block" id="btn-copy" style="margin-bottom:10px;">一键复制全文（去订阅号助手粘贴）</button>
      <button class="btn btn-ghost btn-block" id="btn-edit" style="margin-bottom:10px;">返回修改文字</button>
      <button class="btn btn-pink btn-block" id="btn-publish" style="margin-bottom:12px;">保存为成品并发布</button>
      <button class="btn btn-ghost btn-block" style="margin-top:4px;" onclick="navTo('library')">返回书库</button>
    </div>`;
  $('#btn-copy').onclick = () => copyHtml($('#preview-box'));
  $('#btn-copy-title').onclick = () => copyText($('#article-title').textContent);
  $('#btn-edit').onclick = showRevise;
  $('#btn-publish').onclick = publishArticle;
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('标题已复制'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showToast('标题已复制');
  }
}

function renderMagazineInline(md, overrideTitle) {
  // 从 markdown 提取字段；标题优先用外部传入（selectedTitle）
  const lines = md.split('\n').map(s => s.trim()).filter(Boolean);
  const titleMatch = md.match(/^#\s*(.+)/m) || md.match(/\*\*(.+?)\*\*/);
  const title = overrideTitle || (titleMatch ? titleMatch[1] : '推文标题');
  // 解析字段：作者、分级、属性、CP、标签
  const author = md.match(/作者\s*[:：]\s*(.+)/)?.[1] || '未知';
  const rating = md.match(/分级\s*[:：]\s*(.+)/)?.[1] || '';
  const attr = md.match(/属性\s*[:：]\s*(.+)/)?.[1] || '';
  const cp = md.match(/CP\s*[:：]\s*(.+)/)?.[1] || '';
  const tags = (md.match(/标签\s*[:：]\s*(.+)/)?.[1] || '').split(/[,，\/]/).map(s => s.trim()).filter(Boolean);

  // 分章节
  const sections = md.split(/\n##\s+/).slice(1);
  const renderSection = (n, label, body) => {
    const bodyHtml = simpleMarkdownToHtml(body);
    return `<section style="padding:28px 16px;border-top:1px solid #e5dfe2;">
      <p style="margin:0 0 20px;"><span style="font-family:'Noto Serif SC','Songti SC','SimSun',serif;font-size:40px;font-weight:700;line-height:1;color:#3B82C5;vertical-align:middle;">${n}</span>
      <span style="font-family:'Noto Serif SC','Songti SC','SimSun',serif;font-size:22px;font-weight:700;color:#1a1a1a;margin-left:12px;vertical-align:middle;">${label}</span></p>
      ${bodyHtml}
    </section>`;
  };

  let tagsHtml = tags.map(t => `<span style="display:inline-block;padding:4px 12px;background:#dcecf8;color:#2d72ad;border-radius:999px;font-size:12px;font-weight:500;margin:0 8px 6px 0;">${escapeHtml(t)}</span>`).join('');

  let sectionHtml = '';
  const labels = ['小说哪里看','文案推荐','Fanst 碎碎念','名场面预警','最戳我的一个细节','综合评价'];
  labels.forEach((label, i) => {
    const sec = sections.find(s => s.startsWith(label) || s.includes(label));
    if (sec) {
      const body = sec.replace(new RegExp(`^${label}\\s*`), '').trim();
      sectionHtml += renderSection(String(i).padStart(2,'0'), label, body);
    }
  });

  return `
    <div style="max-width:100%;margin:0 auto;background:#fafcfd;">
      <div style="width:100%;height:180px;background:linear-gradient(135deg,#c8ddf5 0%,#a8cdf0 30%,#f5d8e2 60%,#fad2e0 100%);text-align:center;">
        <p style="margin:0;padding-top:80px;font-size:14px;color:rgba(59,130,197,0.6);letter-spacing:1px;">📷 在此插入 CP 角色图</p>
      </div>
      <div style="height:3px;background:#3B82C5;opacity:0.7;font-size:0;line-height:0;">&nbsp;</div>
      <section style="background:#ffffff;padding:20px 16px;">
        <h1 style="font-family:'Noto Serif SC','Songti SC','SimSun',serif;font-size:26px;font-weight:700;line-height:1.35;color:#1a1a1a;margin:0 0 20px;">${escapeHtml(title)}</h1>
        ${author ? rowHtml('作者', author) : ''}
        ${rating ? rowHtml('分级', rating, true) : ''}
        ${attr ? rowHtml('属性', attr) : ''}
        ${cp ? rowHtml('CP', cp, true) : ''}
        <p style="margin:14px 0 0;padding-top:14px;border-top:1px solid #e0e0e0;font-size:0;line-height:1.8;">${tagsHtml}</p>
      </section>
      ${sectionHtml}
      <section style="padding:28px 16px;background:linear-gradient(180deg,#fdf2f5 0%,#eef5fb 100%);text-align:center;border-top:1px solid #e5dfe2;">
        <p style="font-size:12px;line-height:2;color:#888888;margin:0 0 20px;">所有荣誉与利益属于作者和创作者，Fanst 只是同人文的搬运工。<br>即使你不了解这些角色，也不用担心，该书完全可以当成一部独立小说看待。</p>
        <div style="display:inline-block;padding:12px 28px;background:#ffffff;border:2px solid #E8739A;border-radius:8px;">
          <p style="font-size:14px;font-weight:600;line-height:1.6;color:#E8739A;margin:0;">💬 非常需要你的推荐留言或观后感！</p>
          <p style="font-size:12px;color:#888888;margin:4px 0 0;">读完这篇文你有什么感受？在评论区告诉我们～</p>
        </div>
        <p style="margin:18px 0 0;font-family:'Noto Serif SC','Songti SC','SimSun',serif;font-size:12px;color:#b8c8d5;letter-spacing:2px;">Fanst 推文杂志 · 哈利波特特辑</p>
      </section>
    </div>`;
}

function rowHtml(label, value, sky=false) {
  return `<p style="margin:0 0 8px;font-size:14px;line-height:1.7;color:#3a3a3a;"><span style="font-size:12px;color:#888888;letter-spacing:1px;margin-right:8px;">${escapeHtml(label)}</span><span style="font-weight:500;${sky ? 'color:#3B82C5;' : 'color:#1a1a1a;'}">${escapeHtml(value)}</span></p>`;
}

function simpleMarkdownToHtml(md) {
  // 用于推文正文的轻量解析
  return renderMarkdown(md);
}

function copyHtml(el) {
  const done = () => showToast('已复制，去订阅号助手粘贴');
  if (navigator.clipboard && window.ClipboardItem) {
    const html = el.innerHTML;
    const item = new ClipboardItem({
      'text/html': new Blob([html], {type:'text/html'}),
      'text/plain': new Blob([el.innerText], {type:'text/plain'})
    });
    navigator.clipboard.write([item]).then(done).catch(() => legacyCopy(el, done));
  } else legacyCopy(el, done);
}
function legacyCopy(el, done) {
  const range = document.createRange(); range.selectNodeContents(el);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  document.execCommand('copy'); sel.removeAllRanges(); done();
}

async function publishArticle() {
  if (!CONFIG.OSS_KEY_ID || !CONFIG.OSS_KEY_SECRET) { alert('请填 OSS Key 才能保存成品'); openSettings(); return; }
  const b = state.currentBook;
  const title = b.title;
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const slug = `${date}-${title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g,'_')}`;
  const mdBlob = new Blob([state.finalMd], {type:'text/markdown'});
  const html = renderMagazineInline(state.finalMd);
  const htmlBlob = new Blob([html], {type:'text/html'});
  try {
    const client = getOssClient();
    await client.put(`${CONFIG.OSS_ARTICLE_PREFIX}${slug}.md`, mdBlob);
    await client.put(`${CONFIG.OSS_ARTICLE_PREFIX}${slug}.html`, htmlBlob);
    state.progress[title] = 'recommended';
    saveProgress();
    await updateStyleGuide();
    showToast('已保存成品和风格更新');
    navTo('articles');
  } catch (e) {
    alert('保存失败：' + e.message);
  }
}

async function updateStyleGuide() {
  try {
    const styleGuide = await loadStyleGuide();
    const prompt = `对比以下"初稿"和"终稿"，提炼 1-3 条写作风格规则（要具体、可执行），追加到风格指南末尾。

现有风格指南：\n${styleGuide}

初稿：\n${state.draftMd}

终稿：\n${state.finalMd}

请直接返回更新后的完整风格指南。`;
    const updated = await deepSeekChat(CONFIG.WRITE_MODEL, prompt, 4000);
    const client = getOssClient();
    await client.put(CONFIG.OSS_STYLE_GUIDE, new Blob([updated], {type:'text/plain'}));
  } catch (e) { console.error('style guide update fail', e); }
}

/* ===== Upload ===== */
function renderUpload() {
  $('#main').innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="card-title">上传本地小说</div>
        <div class="card-meta">上传到 OSS 备份，并进入推荐流程</div>
      </div>
      <input type="file" id="upload-file" accept=".txt,.md,.epub,.zip">
      <div class="tip">支持 txt / md / epub / 标准 zip。rar / 7z / 伪 zip 手机端无法解压，请先用手机解压 App（如 ZArchiver / iZip）转成 txt。</div>
      <button class="btn btn-primary btn-block" id="btn-upload" style="margin-top:12px;">上传并推荐</button>
    </div>`;
  $('#btn-upload').onclick = doUpload;
}

async function doUpload() {
  const file = $('#upload-file').files[0];
  if (!file) { showToast('请选择文件'); return; }
  if (!CONFIG.OSS_KEY_ID || !CONFIG.OSS_KEY_SECRET) { alert('请先填 OSS Key'); openSettings(); return; }
  $('#btn-upload').textContent = '解析中...';
  let title = file.name.replace(/\.[^.]+$/, '');
  let text = '';
  let ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'txt' || ext === 'md') {
      text = await file.text();
    } else if (ext === 'epub') {
      text = await parseEpub(file);
    } else if (ext === 'zip') {
      text = await parseZipText(file);
    } else {
      throw new Error('不支持的格式：' + ext);
    }
  } catch (e) {
    $('#btn-upload').textContent = '上传并推荐';
    alert('解析失败：' + e.message);
    return;
  }
  if (!text || text.length < 200) {
    $('#btn-upload').textContent = '上传并推荐'; showToast('文件内容为空或无法解析'); return;
  }
  $('#btn-upload').textContent = '上传中...';
  try {
    const client = getOssClient();
    const key = `${CONFIG.OSS_UPLOAD_PREFIX}${Date.now()}-${title}.txt`;
    await client.put(key, new Blob([text], {type: 'text/plain'}));
    const book = { title, cp: '待分类', file: key, chars: text.length, bytes: new Blob([text]).size, recommended: false };
    state.currentBook = { ...book, text };
    state.uploaded.unshift(book);
    showToast('上传成功');
    $('#btn-upload').textContent = '上传并推荐';
    showBookMenu();
  } catch (e) {
    $('#btn-upload').textContent = '上传并推荐';
    alert('上传失败：' + e.message);
  }
}

async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const container = await zip.file('META-INF/container.xml')?.async('text');
  if (!container) throw new Error('不是标准 EPUB');
  const rootfile = container.match(/full-path=\"([^\"]+)\"/);
  if (!rootfile) throw new Error('EPUB 结构异常');
  const opfPath = rootfile[1];
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = await zip.file(opfPath)?.async('text');
  if (!opf) throw new Error('内容索引缺失');
  const ids = [...opf.matchAll(/<itemref idref=\"([^\"]+)\"/g)].map(m => m[1]);
  const items = [...opf.matchAll(/<item[^>]*id=\"([^\"]+)\"[^>]*href=\"([^\"]+)\"[^>]*media-type=\"([^\"]+)\"/g)]
    .map(m => ({ id: m[1], href: m[2], type: m[3] }));
  let parts = [];
  for (const id of ids) {
    const item = items.find(i => i.id === id);
    if (!item || !item.type.includes('html')) continue;
    const path = opfDir + item.href;
    const html = await zip.file(path)?.async('text');
    if (!html) continue;
    const t = htmlToText(html);
    if (t.trim()) parts.push(t);
  }
  return parts.join('\n\n');
}

async function parseZipText(file) {
  const head = await readFirstBytes(file, 4);
  const hex = Array.from(head).map(b => b.toString(16).padStart(2,'0')).join('');
  if (hex.startsWith('52617221')) throw new Error('这是 RAR 文件（可能被改名成 .zip），手机端无法解压，请先用电脑或手机解压 App 转成 txt 再上传');
  if (hex.startsWith('377abcaf')) throw new Error('这是 7z 文件，手机端无法解压，请先用电脑或手机解压 App 转成 txt 再上传');
  if (!hex.startsWith('504b')) throw new Error('不是标准 ZIP 文件，无法解压，请转成 txt 再上传');
  const zip = await JSZip.loadAsync(file);
  const candidates = [];
  zip.forEach((path, obj) => {
    if (path.toLowerCase().endsWith('.txt') && !obj.dir) candidates.push({ path, obj });
  });
  if (!candidates.length) throw new Error('zip 里没找到 txt');
  candidates.sort((a, b) => (b.obj._data?.uncompressedSize || 0) - (a.obj._data?.uncompressedSize || 0));
  return await candidates[0].obj.async('text');
}

function readFirstBytes(file, n) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(new Uint8Array(e.target.result));
    reader.onerror = e => reject(e);
    reader.readAsArrayBuffer(file.slice(0, n));
  });
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const block = ['P','H1','H2','H3','H4','H5','H6','LI','DIV','SECTION','BR'];
  doc.querySelectorAll(block.join(',')).forEach(el => {
    if (el.tagName === 'BR') {
      el.after(doc.createTextNode('\n'));
    } else {
      el.appendChild(doc.createTextNode('\n'));
    }
  });
  return (doc.body.textContent || '').replace(/\n\s*\n+/g, '\n\n').trim();
}

/* ===== Articles ===== */
function renderArticles() {
  $('#main').innerHTML = `
    <div class="screen">
      <div class="card"><div class="card-title">成品区</div><div class="card-meta">这里是历史推文，可再次编辑、复制</div></div>
      <div id="article-list" class="book-list"></div>
    </div>`;
  loadArticlesList();
}

async function loadArticlesList() {
  const el = $('#article-list');
  el.innerHTML = '<div class="loading">加载中...</div>';
  if (!CONFIG.OSS_KEY_ID || !CONFIG.OSS_KEY_SECRET) { el.innerHTML = '<div class="loading">请先设置 OSS Key</div>'; return; }
  try {
    const client = getOssClient();
    const res = await client.list({ prefix: CONFIG.OSS_ARTICLE_PREFIX, 'max-keys': 100 });
    const items = (res.objects || []).filter(o => o.name.endsWith('.md')).sort((a,b) => b.name.localeCompare(a.name));
    if (!items.length) { el.innerHTML = '<div class="loading">暂无成品</div>'; return; }
    el.innerHTML = items.map(o => {
      const name = o.name.replace(CONFIG.OSS_ARTICLE_PREFIX, '').replace('.md', '');
      return `<div class="book-item" data-key="${o.name}"><div class="book-title">${escapeHtml(name)}</div></div>`;
    }).join('');
    el.onclick = async (e) => {
      const item = e.target.closest('.book-item');
      if (!item) return;
      try {
        const client = getOssClient();
        const md = await client.get(item.dataset.key);
        state.draftMd = state.finalMd = md.content.toString();
        showRevise();
      } catch (e) { alert('读取失败：' + e.message); }
    };
  } catch (e) { el.innerHTML = `<div class="loading">加载失败：${e.message}</div>`; }
}

/* ===== Settings ===== */
function openSettings() {
  const prev = $('#main').innerHTML;
  $('#main').innerHTML = `
    <div class="screen" id="settings-screen">
      <h3 style="margin-top:0;">设置</h3>
      <div class="setting-group"><div class="setting-label">DeepSeek API Key</div><input type="password" id="set-api-key" value="${escapeHtml(CONFIG.API_KEY)}"></div>
      <div class="setting-group"><div class="setting-label">阅读模型（省钱）</div><input type="text" id="set-read-model" value="${escapeHtml(CONFIG.READ_MODEL)}"></div>
      <div class="setting-group"><div class="setting-label">写作模型（质量）</div><input type="text" id="set-write-model" value="${escapeHtml(CONFIG.WRITE_MODEL)}"></div>
      <div class="setting-group"><div class="setting-label">OSS AccessKey ID</div><input type="text" id="set-oss-id" value="${escapeHtml(CONFIG.OSS_KEY_ID)}"></div>
      <div class="setting-group"><div class="setting-label">OSS AccessKey Secret</div><input type="password" id="set-oss-secret" value="${escapeHtml(CONFIG.OSS_KEY_SECRET)}"></div>
      <div class="tip">Key 只存在手机本地，不会上传到我们服务器。</div>
      <button class="btn btn-primary btn-block" id="btn-save-settings">保存设置</button>
      <button class="btn btn-ghost btn-block" style="margin-top:12px;" id="btn-back-from-settings">返回</button>
    </div>`;
  $('#btn-save-settings').onclick = () => {
    CONFIG.API_KEY = $('#set-api-key').value.trim();
    CONFIG.READ_MODEL = $('#set-read-model').value.trim();
    CONFIG.WRITE_MODEL = $('#set-write-model').value.trim();
    CONFIG.OSS_KEY_ID = $('#set-oss-id').value.trim();
    CONFIG.OSS_KEY_SECRET = $('#set-oss-secret').value.trim();
    saveUserConfig();
    showToast('设置已保存');
    navTo('library');
  };
  $('#btn-back-from-settings').onclick = () => { $('#main').innerHTML = prev; };
}

/* ===== Init ===== */
$('#btn-settings').onclick = openSettings;
$$('#nav button').forEach(b => b.onclick = () => navTo(b.dataset.tab));

(async function init() {
  if (!CONFIG.API_KEY || !CONFIG.OSS_KEY_ID) {
    $('#main').innerHTML = '<div class="screen"><div class="card"><div class="card-title">欢迎使用磕学家推文APP</div><div class="card-meta">第一次使用请先在右上角「设置」里填入 DeepSeek API Key 和 OSS AccessKey。</div></div><button class="btn btn-primary btn-block" onclick="openSettings()">去设置</button></div>';
  } else {
    await loadBooks();
  }
})();
