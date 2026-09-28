// popup.js — 一键导入：读取当前页 → 注入抓取 → 预填表单 → 保存
import * as S from '../shared.js';
import * as AI from '../ai.js';
import * as SYNC from '../sync.js';

const form = document.getElementById('importForm');
const positionInput = document.getElementById('position');
const companyInput = document.getElementById('company');
const urlInput = document.getElementById('url');
const jdInput = document.getElementById('jd');
const jdDetails = document.getElementById('jdDetails');
const jdSummary = document.getElementById('jdSummary');
const degradeBanner = document.getElementById('degradeBanner');
const saveBtn = document.getElementById('saveBtn');
const saveHint = document.getElementById('saveHint');
const recentList = document.getElementById('recentList');
const recentEmpty = document.getElementById('recentEmpty');
const recentCount = document.getElementById('recentCount');
const toast = document.getElementById('toast');
const aiLine = document.getElementById('aiLine');   // 可能不存在：整个 AI 段落都要容得下它缺席（见 maybeAiSuggest）
const $ = (id) => document.getElementById(id);
document.getElementById('todayLabel').textContent = S.todayLabel();

let extracted = null; // { jd, company, position, url, title } | null

// ---------- 最近投递 ----------
async function renderRecent() {
  const { records } = await S.loadData();
  const recent = [...records].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 5);
  recentList.textContent = '';
  recentEmpty.hidden = recent.length > 0;
  recentCount.textContent = recent.length > 0 ? `${recent.length} 条` : '';
  for (const rec of recent) {
    const li = document.createElement('li');
    const [fg, bg] = S.statusColor(rec.status);
    li.innerHTML = `
      <span class="r-pos" title="${S.escapeHtml(rec.position)}">${S.escapeHtml(rec.position)}</span>
      <span class="r-co" title="${S.escapeHtml(rec.company)}">${S.escapeHtml(rec.company)}</span>
      <span class="pill" style="color:${fg};background:${bg}">${S.escapeHtml(rec.status)}</span>
      <span class="r-time">${S.fmtRelative(rec.createdAt)}</span>`;
    li.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') + '#rec-' + rec.id });
    });
    recentList.appendChild(li);
  }
}

// ---------- 页面抓取 ----------
async function extractCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  urlInput.value = tab.url || '';

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ['content/extract.js'],
    });
    extracted = res?.result ?? null;
  } catch (e) {
    // chrome://、Chrome 商店、PDF 等页面无法注入
    degradeBanner.hidden = false;
    return;
  }

  if (!extracted) { degradeBanner.hidden = false; return; }

  // JD 状态提示
  if (extracted.jd) {
    jdInput.value = extracted.jd;
    jdSummary.textContent = `岗位 JD：已抓取 ${extracted.jd.length} 字，点击展开核对/编辑`;
  } else {
    jdSummary.textContent = '岗位 JD：未抓到，展开可手动粘贴';
  }

  // ---- 评分融合：候选提取器结果 + 已知公司字典加权 ----
  const { records } = await S.loadData();
  const knownCompanies = [...new Set(records.map((r) => r.company).filter(Boolean))];
  const guessFromHint = S.guessCompanyPosition(extracted.titleHint || '', extracted.url, knownCompanies);
  const guessFromTitle = S.guessCompanyPosition(extracted.title || '', extracted.url, knownCompanies);

  const SOURCE_LABELS = {
    jsonld: 'JSON-LD', dom: '页面元素', page: '页面标题线索', selector: '页面标题',
    json: '页面数据', heading: '页面标题', keyword: '页面关键词', keywords: '页面关键词',
    copyright: '版权声明', meta: '页面信息', url: '投递链接',
  };

  // 候选择优：基础分 + 已知公司命中加权（用户数据越用越准）
  const pickBest = (cands, isCompany) => {
    let best = null, bestScore = -Infinity;
    for (const c of cands || []) {
      let s = c.score || 0;
      const v = String(c.value || '').trim();
      if (!v) continue;
      let matched = null;
      if (isCompany) {
        matched = knownCompanies.find((k) => k && (v.includes(k) || k.includes(v)));
        if (matched) s += 60;
        else if (S.looksLikeCompany(v, knownCompanies)) s += 25;
      }
      if (s > bestScore) { bestScore = s; best = { value: matched || v, source: c.source, score: s }; }
    }
    return best;
  };

  // 公司：结构化/页面信号候选 > 页面标题解析 > 页面内线索 > 投递链接租户
  // 标题/线索解析出的公司须通过"公司特征"守卫（避免"公司直属/创新业务"等岗位串垃圾段入选）
  const guard = (v) => v && S.looksLikeCompany(v, knownCompanies);

  // 岗位：评分候选 > 页面标题线索解析 > 页面标题解析
  let positionPick = pickBest(extracted.positionCandidates, false);
  // 候选含修饰成分（方括号/分隔符/校招/届/城市…）：走启发式解析清洗并顺带提取公司
  let bracketCompany = null;
  if (positionPick && /【[^】]{2,30}】|[-—–·（(]|校招|社招|秋招|春招|届/.test(positionPick.value)) {
    const rawPos = positionPick.value;
    const g = S.guessCompanyPosition(positionPick.value, extracted.url, knownCompanies);
    if (g.position) positionPick = { ...positionPick, value: g.position };
    if (g.company && guard(g.company) && /^【/.test(rawPos)) bracketCompany = { value: g.company, source: 'page', score: 85 };
  }

  // 公司：岗位自身的【公司】声明 > 结构化候选 > 品牌词典 URL > 标题 > 页面线索 > 租户 slug
  let companyPick = null;
  if (bracketCompany) companyPick = bracketCompany;
  if (!companyPick) companyPick = pickBest(extracted.companyCandidates, true);
  const titleCo = guessFromTitle.company;
  const bareTitleOk = titleCo && titleCo.length >= 2 && titleCo.length <= 12
    && !/招聘|校招|社招|官网|首页|^\d+$|登录|注册/.test(titleCo);
  // ① 品牌词典 URL（恒生电子/欣旺达/360集团…精确中文名）
  if (!companyPick) {
    const g0 = S.guessCompanyFromUrl(urlInput.value || extracted.url, knownCompanies);
    if (g0 && g0.confidence === 'high') companyPick = { value: g0.company, source: 'url', score: 85 };
  }
  // ② 带公司后缀（集团/公司/网络…）的标题公司
  if (!companyPick && guard(titleCo)) companyPick = { value: titleCo, source: 'title', score: 35 };
  // ③ 裸品牌标题（搜狐/虎扑…）
  if (!companyPick && bareTitleOk) companyPick = { value: titleCo, source: 'title', score: 35 };
  // ④ 页面线索（【公司】岗位 模式）
  if (!companyPick && guard(guessFromHint.company)) companyPick = { value: guessFromHint.company, source: 'page', score: 40 };
  // ⑤ 兜底：URL 租户 slug
  if (!companyPick) {
    // 用地址栏 URL（更权威，可能经历重定向）
    const g = S.guessCompanyFromUrl(urlInput.value || extracted.url, knownCompanies);
    if (g) companyPick = { value: g.company, source: 'url', score: g.confidence === 'high' ? 85 : 30 };
  }
  // 尾部残缺括号清理（"服务器开发工程师（AFK" → "服务器开发工程师"）
  if (positionPick) {
    const cleaned = positionPick.value.replace(/[（(【\[][^）)】\]]*$/, '').trim();
    if (cleaned && cleaned !== positionPick.value) positionPick = { ...positionPick, value: cleaned };
  }
  if (!positionPick && guessFromHint.position) positionPick = { value: guessFromHint.position, source: 'page', score: 40 };
  if (!positionPick && guessFromTitle.position) positionPick = { value: guessFromTitle.position, source: 'title', score: 35 };

  const company = companyPick?.value || '';
  const position = positionPick?.value || '';
  companyInput.value = company;
  positionInput.value = position;
  const companySource = companyPick ? (SOURCE_LABELS[companyPick.source] || '页面信号') : '未识别（可手动填写）';
  const positionSource = positionPick ? (SOURCE_LABELS[positionPick.source] || '页面信号') : '未识别（可手动填写）';
  $('guessSource').textContent = `识别来源：公司 = ${companySource} · 岗位 = ${positionSource}`;

  // 低置信度提示：高亮未填或待确认字段（公司名/岗位名允许留空，稍后可在面板补充）
  if (!company) companyInput.classList.add('low-confidence');
  if (!position) positionInput.classList.add('low-confidence');
  if (companyPick?.score < 40 || positionPick?.score < 40) {
    if (company) companyInput.classList.add('low-confidence');
    if (position) positionInput.classList.add('low-confidence');
  }

  // 规则已经填完了，再去问一次 AI（异步、不阻塞：慢就慢，用户看不到等待）
  maybeAiSuggest();
}

// ---------- AI 兜底识别 ----------
// 规则给的是"能从页面信号里拼出来的"，AI 给的是"页面上本来就有、但规则挑错的那条原串"
// （语料上岗位完整率 49% → 100%，见 README）。两者是接力，不是替代：
//   · 只在用户打开面板时问一次（不在页面加载时、不在后台轮询）—— 调用量与成本都靠这条守住
//   · 用户改过的字段一律不动；AI 自己改的字段旁边留一个「撤销」
//   · 答案必须能在这一页上找到才自动采用（AI.groundedIn），找不到的只作为建议显示
let aiSeq = 0;        // 每次抓取 +1：晚回来的响应认不出自己那一轮就丢掉（换页/保存后不许再改表单）
let aiOrigin = null;  // AI 改之前的值，供「撤销」
let aiAns = null;     // 这一轮 AI 的答案（原样留着：手动「采用」时要照着填）
let aiPending = [];   // 尚未采用、等着用户点「采用」的字段名
const dirty = { company: false, position: false };   // 用户手动改过的字段

const AI_ACTS = {
  company: 'use-company',
  position: 'use-position',
};

function showAiLine(html) {
  if (!aiLine) return;
  aiLine.innerHTML = html;   // 只由本文件拼，值一律过 S.escapeHtml
  aiLine.hidden = false;
}

function hideAiLine() {
  if (!aiLine) return;
  aiLine.hidden = true;
  aiLine.textContent = '';
}

// 「这一页上到底有没有这段文字」用的整页文本：标题 + 链接 + 两组候选 + JD。
// 判据与 bench-llm.mjs 的 inPage 同款（AI.groundedIn），够用于"能不能自动采用"
function pageTextForCheck() {
  return [
    extracted?.title || '', urlInput.value || '',
    ...(extracted?.companyCandidates || []).map((c) => c?.value || ''),
    ...(extracted?.positionCandidates || []).map((c) => c?.value || ''),
    jdInput.value || '',
  ].join('\n');
}

async function maybeAiSuggest() {
  if (!aiLine) return;   // 页面里没有这一行（半新半旧的 popup.html）：整段 AI 直接不做，别的地方照旧
  const seq = ++aiSeq;
  hideAiLine();
  aiOrigin = null;
  aiAns = null;
  aiPending = [];
  const cfg = await AI.loadAiCfg();
  if (!cfg.enabled) return;
  // AI 的 key 只待在云函数里，所以这条路必须有一条通往服务端的通道：**地址 + 注册口令**。
  // 同步口令不参与这个判断，也不是备选答案 —— 它只管"要不要把记录同步上去"：
  // 有同步口令但没注册口令时，这一行不出现（实测反馈：只删注册口令、留着同步口令时识别还能用，是错的）。
  // 注册口令也没填 = 没有可以问的服务端，这一行根本不出现（不是报错，用户什么都没做错）
  const sync = await SYNC.loadSync();
  if (!sync.endpoint || !sync.enrollKey) return;
  const payload = {
    url: urlInput.value || extracted?.url || '',
    title: extracted?.title || '',
    companyCandidates: extracted?.companyCandidates || [],
    positionCandidates: extracted?.positionCandidates || [],
    pageText: pageTextForCheck(),   // 「答案在不在这一页上」由客户端判，判据需要整页文本
  };
  if (!payload.url) return;
  showAiLine('AI 识别中…');
  const ans = await AI.recognize(payload, sync);
  if (seq !== aiSeq) return;   // 这中间用户又换了一页 / 已经保存过了
  if (!ans) { hideAiLine(); return; }   // 没配模型、超时、断网：静默，什么都不说
  applyAiSuggestion(ans);
}

function applyAiSuggestion(ans) {
  const page = pageTextForCheck();
  const before = { company: companyInput.value, position: positionInput.value };
  const applied = [];
  const suggest = [];
  for (const field of ['company', 'position']) {
    const input = field === 'company' ? companyInput : positionInput;
    const v = String(ans[field] || '').trim();
    if (!v || dirty[field] || input.value.trim() === v) continue;
    if (AI.groundedIn(page, v)) {
      input.value = v;
      input.classList.add('ai-filled');
      input.classList.remove('low-confidence');
      applied.push(field);
    } else {
      suggest.push(field);
    }
  }
  aiAns = ans;
  aiPending = suggest;

  if (applied.length) {
    aiOrigin = before;
    const parts = applied.map((f) => `${f === 'company' ? '公司' : '岗位'} <b>${S.escapeHtml(ans[f])}</b>`);
    showAiLine(
      `AI 已修正：${parts.join(' · ')}`
      + (suggest.length ? '；另有 <button class="ai-act" type="button" data-ai-act="use-all">一条建议</button>' : '')
      + ' <button class="ai-act" type="button" data-ai-act="undo">撤销</button>'
    );
    return;
  }

  if (suggest.length) {
    showAiLine('AI 建议（<b>这一页上没找到</b>，请核对）：' + suggest.map((f) => {
      const label = f === 'company' ? '公司' : '岗位';
      return `${label} <b>${S.escapeHtml(ans[f])}</b> <button class="ai-act" type="button" data-ai-act="${AI_ACTS[f]}">采用</button>`;
    }).join(' · '));
    return;
  }

  // 没什么可改的：明确说一句「和页面一致」—— 用户最想知道的正是"这条识别到底可不可信"
  showAiLine(`AI 复核：与页面一致${ans.from === 'cache' ? '（本机缓存，未再次调用模型）' : ''}`);
}

aiLine?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ai-act]');
  if (!btn || !aiAns) return;
  const act = btn.dataset.aiAct;

  if (act === 'undo') {
    if (aiOrigin) {
      companyInput.value = aiOrigin.company;
      positionInput.value = aiOrigin.position;
    }
    for (const input of [companyInput, positionInput]) input.classList.remove('ai-filled');
    aiOrigin = null;
    aiPending = [];
    showAiLine('已撤销 AI 的修改。');
    return;
  }

  // 手动采用：只在这里才动字段（用户自己点的），并记成"用户确认过"的字段
  const fields = act === 'use-all' ? [...aiPending] : [act === AI_ACTS.company ? 'company' : 'position'];
  const page = pageTextForCheck();
  const ungrounded = [];
  for (const field of fields) {
    const v = String(aiAns[field] || '').trim();
    if (!v) continue;
    const input = field === 'company' ? companyInput : positionInput;
    input.value = v;
    input.classList.add('ai-filled');
    if (!AI.groundedIn(page, v)) ungrounded.push(field);
  }
  aiPending = [];
  showAiLine(ungrounded.length
    ? `已填入 AI 建议：${ungrounded.map((f) => `<b>${S.escapeHtml(aiAns[f])}</b>`).join(' · ')} —— <b>这一页上没找到这段文字</b>，请核对后再保存`
    : '已填入 AI 建议。');
});

// ---------- 保存 ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 公司名与岗位名不强制：未抓取到时允许留空，稍后可在面板补充
  const company = companyInput.value.trim();
  const position = positionInput.value.trim();
  const url = urlInput.value.trim();

  const rec = S.makeRecord({
    company, position, url,
    jd: jdInput.value.trim(),
    sourceTitle: extracted?.title || '',
  });

  // 去重：同一 url + 同一岗位 已存在则确认
  const data = await S.loadData();
  const dup = data.records.find((r) => S.recordKey(r) === S.recordKey(rec));
  if (dup && !confirm(`该岗位已存在（${dup.company} · ${dup.position}，状态：${dup.status}）。\n仍要另存一条吗？`)) {
    return;
  }

  data.records.push(rec);
  saveBtn.disabled = true;
  try {
    await S.saveData(data);
    showToast(`已保存：${company} · ${position}`);
    saveHint.textContent = '已导入 ✓';
    setTimeout(() => { saveHint.textContent = ''; }, 3000);
    form.reset();
    urlInput.value = '';
    jdInput.value = '';
    jdSummary.textContent = '岗位 JD：等待抓取…';
    $('guessSource').textContent = '识别来源：等待抓取…';
    jdDetails.open = false;
    extracted = null;
    // AI 那一轮作废：晚回来的响应不许再往已经清空的表单里填东西
    aiSeq++;
    hideAiLine();
    aiOrigin = null;
    aiAns = null;
    aiPending = [];
    dirty.company = false;
    dirty.position = false;
    for (const input of [companyInput, positionInput]) input.classList.remove('ai-filled');
    renderRecent();
  } catch (err) {
    if (String(err?.message).includes('QUOTA')) {
      alert('存储空间不足，请打开面板导出备份后清理旧记录。');
    } else {
      alert('保存失败：' + (err?.message || err));
    }
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------- 打开面板 ----------
document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// ---------- 小工具 ----------
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

// 手动输入后清除低置信度高亮，并把这一栏记成「用户自己填的」：
// 之后回来的 AI 建议一律不许再动它 —— 用户输入永远优先于模型
for (const [field, input] of [['company', companyInput], ['position', positionInput]]) {
  input.addEventListener('input', () => {
    input.classList.remove('low-confidence');
    input.classList.remove('ai-filled');
    dirty[field] = true;
  });
}

renderRecent();
extractCurrentPage();
