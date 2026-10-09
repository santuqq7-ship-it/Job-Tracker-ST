// popup.js — 一键导入：读取当前页 → 注入抓取 → 预填表单 → 保存
import * as S from '../shared.js';
import * as AI from '../ai.js';
import * as SYNC from '../sync.js';
import * as MODELS from '../model.js';
import * as CT from '../company-type.js';
// 下拉不用原生那层皮：自建的列表里每一项右边才能挂一个 🗑（原生 <select> 塞不进按钮）
import { attachTypeSelect } from '../pickers.js';

const form = document.getElementById('importForm');
const positionInput = document.getElementById('position');
const companyInput = document.getElementById('company');
const natureSelect = document.getElementById('nature');     // 可能不存在（半新半旧的 popup.html）
const industrySelect = document.getElementById('industry');
const typeHint = document.getElementById('typeHint');
const typeAiBtn = document.getElementById('typeAiBtn');   // 同上：缺了就当这个按钮不存在
const natureCustomInput = document.getElementById('natureCustom');     // 选了「＋ 自定义…」才展开
const industryCustomInput = document.getElementById('industryCustom'); // 同上：缺了就当它不存在
// 一栏要用到的两个控件（下拉 / 自定义输入框）在这里就绑好，下面只按 field 取。
// 「删掉某一项」的 🗑 不在这一层 —— 它画在下拉面板里每一项的右边（pickers.js 的 .picker-del）
const TYPE_EDIT_IDS = {
  nature: { sel: natureSelect, custom: natureCustomInput },
  industry: { sel: industrySelect, custom: industryCustomInput },
};
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
  // 这一句也得兜住：它是**异步启动路径上的第一句**，一旦拒绝就是一条 unhandled rejection，
  // 会原样记进「扩展 → 错误」那个列表里。拿不到当前标签页不是"出错了"，是"这一页没法自动读"，
  // 该走的是降级提示，跟下面注入失败那条路一样。
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    degradeBanner.hidden = false;
    return;
  }
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
  // 企业类型：公司名一确定就先本地判，再（只在还空着时）问一次模型。与上面那一轮并行
  refreshCompanyType('fill');
}

// ---------- 企业类型（两个下拉 + 本地识别 + AI 补空） ----------
// 三层，与 README 写的一致：本地映射库 → 关键词规则 → 模型；三层都给不出就留空（「待确认」）。
// 界面上的两个下拉**永远是最终裁决**：自动填的只是初值，用户改过就再也不会被自动值覆盖。
const typeDirty = { nature: false, industry: false };   // 用户动过哪一栏
let typeSeq = 0;      // 与 aiSeq 同一个用途：晚回来的分类响应认不出自己那一轮就丢掉

function fillTypeOptions(sel, list) {   // 取值集合由 CT.typeValues 给全（枚举 + 自定义 + 记录里用过的），别在这里另抄
  if (!sel) return;
  sel.textContent = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '（未填）';
  sel.appendChild(blank);
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
  // 末项「＋ 自定义…」：选中它就在下拉下面展开一个输入框（哨兵值用 CT.CUSTOM_OPT，
  // 与主面板同一个）。放在最后一项，是因为前面那批都是"现成可挑的"，这一项是"我要写新的"
  const custom = document.createElement('option');
  custom.value = CT.CUSTOM_OPT;
  custom.textContent = '＋ 自定义…';
  sel.appendChild(custom);
}

// 两个下拉的取值：**不能只喂枚举** —— 主面板里加过的自定义值（如「银行」）也得在，
// 否则就是"主面板加得出、小窗口却选不到"。取值集合的实现只有一份，在 CT.typeChoices。
// 读库是异步的，所以把"铺好了"这件事做成一个 Promise：往下拉里写值的那两处都 await 它 ——
// 选项还没铺进去时 `sel.value = x` 是静默写不进去的，那次识别就白跑了
let typeData = null;   // 最近一次读到的库：只给"这个选项是不是我自己加的"这个判断用，别拿它当数据源往回写
// 保存后要拿**刚记进去**的自定义值重铺一遍（同一次打开里立刻能再选到），所以是 let 不是 const
async function fillTypeSelects() {
  let data = null;
  try { data = await S.loadData(); } catch { data = null; }   // 读不到库就退回枚举，不许让下拉空着
  typeData = data;
  fillTypeOptions(natureSelect, CT.typeChoices('nature', data));
  fillTypeOptions(industrySelect, CT.typeChoices('industry', data));
}
let typeOptionsReady = fillTypeSelects();

// 下拉里选了「＋ 自定义…」就把下面那个输入框展开并聚焦；选回别的值就收起来。
// 主面板同一套动作（dashboard.js 的 syncTypeCustom），两边手感保持一致
function syncTypeCustom(field) {
  const { sel, custom: input } = TYPE_EDIT_IDS[field];
  if (!sel || !input) return;
  const custom = sel.value === CT.CUSTOM_OPT;
  input.hidden = !custom;
  if (custom) { input.value = ''; input.focus(); }
}

// 输入框里按回车 = 确认这一栏的写法：记进清单、选中它、收起输入框。**不提交整张表单** ——
// 小面板里回车默认是"保存投递"，一次回车只该完成一项确认（用户明确提过）。
// 保存这条投递仍旧归「保存投递」按钮，或者焦点挪开之后再按一次回车
async function commitCustomType(field) {
  const { sel, custom: input } = TYPE_EDIT_IDS[field];
  if (!sel || !input || sel.value !== CT.CUSTOM_OPT) return;
  const v = (input.value || '').trim().slice(0, CT.CUSTOM_MAX_LEN);   // 上限与候选集清洗同一口径
  if (!v) {
    showTypeHint(`企业类型：「${S.TYPE_FIELDS[field]}」这一栏还空着 —— 先写上你的写法，或者改选一个已有的。`);
    return;
  }
  const data = await S.loadData();
  CT.rememberCustomType(data, field, v);
  await S.saveData(data);
  typeOptionsReady = fillTypeSelects();   // 重铺：新写法立刻能选到（下一行就选中它）
  await typeOptionsReady;
  sel.value = v;
  typeDirty[field] = true;               // 这是用户自己定的，自动识别不许再动这一栏
  input.value = '';
  input.hidden = true;
  input.blur();                          // 焦点挪走：再按回车就是"保存投递"，不会再在这里兜一圈
  showTypeHint(`企业类型：「${S.escapeHtml(v)}」已记进你的类型列表并选中，保存后两处都能直接选到。`);
}

// 下拉面板里那一项右边的 🗑（pickers.js 调过来）：删的只是**我自己加进清单的那个写法**
// （内置的 7 个性质 / 14 个行业不给删）。判据用 CT.isCustomType —— 与主面板同一个函数，
// 两边能删的东西必须一模一样。删除本身只动清单，CT.forgetCustomType 不碰任何记录
async function deleteCustomType(field, v) {
  const data = await S.loadData();
  const r = CT.forgetCustomType(data, field, v);
  if (!r.removed) { showTypeHint(`企业类型：「${S.escapeHtml(v)}」不在你的清单里（内置分类删不掉，也可能已经删过了）。`); return; }
  await S.saveData(data);
  typeOptionsReady = fillTypeSelects();   // 重铺下拉：删掉的写法从选项里消失
  await typeOptionsReady;
  showTypeHint(`企业类型：已把「${S.escapeHtml(v)}」从你的清单里删掉，下拉里不再有它（模型也不会再答它）。`
    + (r.stillUsed ? `还有 ${r.stillUsed} 条记录在用这个写法 —— 记录里的值一个都没动。` : ''));
}

// 读一栏的最终值：选了「＋ 自定义…」时以那个输入框为准，其余情况就是下拉自身。
// 选了自定义却空着 → bad：那不能当成"清空"（用户点它的意图是"我要写一个自己的值"，
// 静默存成空会让他以为写进去了），保存时拦下并指回去
function readTypeSelect(field) {
  const sel = field === 'nature' ? natureSelect : industrySelect;
  if ((sel?.value || '') !== CT.CUSTOM_OPT) return { value: sel?.value || '', bad: false };
  const input = field === 'nature' ? natureCustomInput : industryCustomInput;
  const v = (input?.value || '').trim().slice(0, CT.CUSTOM_MAX_LEN);   // 上限与候选集清洗同一口径
  return { value: v, bad: !v };
}

function showTypeHint(html) {
  if (!typeHint) return;
  typeHint.innerHTML = html;   // 只由本文件拼，值一律过 S.escapeHtml
  typeHint.hidden = false;
}

// 把某一栏设成自动识别出来的值；用户动过的、或已经有值的，一律不动。
// 返回是否真的写了（用来决定要不要提示）
function autoFillType(field, value, from) {
  const sel = field === 'nature' ? natureSelect : industrySelect;
  if (!sel || !value) return false;
  if (typeDirty[field] || sel.value) return false;
  sel.value = value;
  sel.classList.add('ai-filled');
  from.push(field);
  return true;
}

/**
 * 公司名变了（或刚抓完页）就调一次：先本地（映射库 + 规则，瞬时、离线），
 * 本地给不出的那一半再问一次模型 —— 只在这一半**仍然空着**且用户没动过时才写。
 * @param {'fill'|'company'} reason  'company' = 公司名被改了（AI 修正或用户手输），先把上一轮自动填的作废
 */
async function refreshCompanyType(reason = 'fill') {
  if (!natureSelect || !industrySelect) return;
  await typeOptionsReady;   // 选项还没铺进下拉时写 sel.value 是写不进去的（等于这次识别白跑）
  const seq = ++typeSeq;
  // 公司名换了，上一轮**自动**填的那两份就是旧公司的了，必须作废 ——
  // 但用户自己选过的那一份不动（那是我手改的，凭什么给我清掉）
  if (reason === 'company') {
    for (const [field, sel] of [['nature', natureSelect], ['industry', industrySelect]]) {
      if (!typeDirty[field] && sel.value) { sel.value = ''; sel.classList.remove('ai-filled'); }
    }
  }
  const name = companyInput.value.trim();
  if (!name) { if (typeHint) { typeHint.hidden = true; } return; }

  const local = CT.guessCompanyType(name);
  const filled = [];
  autoFillType('nature', local.nature, filled);
  autoFillType('industry', local.industry, filled);
  if (filled.length && reason === 'fill') {
    showTypeHint(`企业类型：${filled.map((f) => S.TYPE_FIELDS[f]).join('、')} 按本地企业库识别 —— 可以直接改`);
  }

  // 本地两层都没给出结论的那一半，才值得问模型（问出来是空也照旧留空）
  const missing = ['nature', 'industry'].filter((f) => {
    const sel = f === 'nature' ? natureSelect : industrySelect;
    return !typeDirty[f] && !sel.value;
  });
  if (!missing.length) return;

  const cfg = await AI.loadAiCfg();
  if (!cfg.enabled) return;
  const ch = await MODELS.resolveChannel();
  if (ch.mode === 'none') return;                   // 与岗位识别同一条通道，没通道就静默
  if (seq !== typeSeq) return;                      // 这中间用户又改了一次公司名

  showTypeHint('企业类型：正在识别…');
  const r = await AI.classifyCompanies([name], ch.sync);
  if (seq !== typeSeq) return;                      // 换页/保存/改名了：这一轮作废
  const hit = r.results[0];
  if (!hit) {
    // 与「🤖 AI 再认一次」同一套说法（从前这里只有一句"这家公司没认出来"，模型答了什么、
    // 是不是压根没配 key，用户一概看不到）：模型答了、只是写法不在候选清单里 → 把它的原话带出来；
    // 真没答（没配 key / 到额度 / 回答是空的 / 本机模型没调通）也直说哪一种
    const rej = (r.rejected || []).find((x) => AI.typeKey(x.name) === AI.typeKey(name));
    const said = AI.saidText(rej?.said);
    showTypeHint(said
      ? `企业类型：模型答的是${said}，不在候选清单里，所以没采用。想用这个写法，选「＋ 自定义…」把它加进清单`
      : `企业类型：${AI.failText(r.fail) || AI.AI_FAIL_TEXT.AI_EMPTY}。可以自己选（留空也可以）`);
    return;
  }
  const done = [];
  for (const f of missing) autoFillType(f, hit[f], done);
  const src = hit.from === 'cache' ? '本机缓存' : 'AI 识别';
  showTypeHint(done.length
    ? `企业类型：${done.map((f) => S.TYPE_FIELDS[f]).join('、')} 由${src}填上（<b>可改</b>）`
    : `企业类型：${src}结果与当前选择一致`);
}

// ---------- 「🤖 AI 再认一次」（用户手动按的那一下）----------
// 为什么要有它：前两层（本地库 / 名称规则）认错时，自动那条路是**补不回来的** ——
// 它只填空着的那一半，一个错的「交通/物流」它会当成"已有值"绕过去。这里按钮的语义不同：
// 这是用户明确要求的重判，所以**覆盖本地层填的值**（用户自己动过的那栏仍然不动），
// 并且**绕开本机缓存**（缓存里那份很可能正是他刚否掉的那个答案）。
function setTypeField(field, value) {
  const sel = field === 'nature' ? natureSelect : industrySelect;
  if (!sel || !value) return false;
  if (sel.value === value) return false;
  sel.value = value;
  sel.classList.add('ai-filled');
  return true;
}

async function reclassifyByAi() {
  const name = companyInput.value.trim();
  if (!name) { showTypeHint('企业类型：先把公司名填上，再让 AI 认'); return; }
  await typeOptionsReady;                     // 同上：选项没铺好时 sel.value 写不进去
  const seq = ++typeSeq;                      // 与自动那一轮共用：晚回来的响应认不出自己就丢掉
  const cfg = await AI.loadAiCfg();
  if (!cfg.enabled) { showTypeHint('企业类型：「AI 兜底识别」是关着的（面板「⚙ 设置 → 🤖 识别模型」）'); return; }
  const ch = await MODELS.resolveChannel();
  if (ch.mode === 'none') {
    showTypeHint('企业类型：还没配识别用的模型（面板「⚙ 设置 → 🤖 识别模型」里可以填你自己的模型，或填服务端地址与注册口令） —— 现在只能自己选');
    return;
  }
  if (seq !== typeSeq) return;

  typeAiBtn.disabled = true;
  const label = typeAiBtn.textContent;
  typeAiBtn.textContent = '识别中…';
  showTypeHint('企业类型：正在问模型…');
  let r = null;
  try {
    r = await AI.classifyCompanies([name], ch.sync, { force: true });
  } catch { r = null; }   // 断网/超时都只是"这次没结果"，下面统一给一句人话
  typeAiBtn.disabled = false;
  typeAiBtn.textContent = label;
  if (seq !== typeSeq) return;                // 这中间换页/改名/保存了，这一轮作废
  const hit = r?.results?.[0];
  if (!hit) {
    // 与主面板同一套说法：模型答了、只是写法不在候选清单里 → 把它的原话带出来
    // （这家在 results 里整条都没有，所以去 rejected 里找）；真没答就直说"回答是空的"。
    // 从前这里是一句"这次没拿到结果（模型没认出这家，或服务端没配模型 key / 到今日上限）"，
    // 四种原因糊在一起，用户看不出 AI 到底跑没跑、答了什么
    const rej = (r?.rejected || []).find((x) => AI.typeKey(x.name) === AI.typeKey(name));
    const said = AI.saidText(rej?.said);
    showTypeHint(said
      ? `企业类型：模型答的是${said}，不在候选清单里，所以没采用。想用这个写法，选「＋ 自定义…」把它加进清单再点一次`
      : `企业类型：${AI.failText(r?.fail) || AI.AI_FAIL_TEXT.AI_EMPTY}。可以自己选，或选「＋ 自定义…」写一个`);
    return;
  }
  const done = [], kept = [], off = [], blank = [];
  for (const f of ['nature', 'industry']) {
    const label = S.TYPE_FIELDS[f];
    if (typeDirty[f]) { if (hit[f]) kept.push(f); continue; }
    if (!hit[f]) {
      const raw = hit.said?.[f];
      if (raw) off.push(`${label} 模型答的是「${S.escapeHtml(raw)}」，不在候选清单里，没采用`);
      else blank.push(label);
      continue;
    }
    if (setTypeField(f, hit[f])) done.push(f);
  }
  const parts = [];
  if (done.length) parts.push(`${done.map((f) => S.TYPE_FIELDS[f]).join('、')} 已按 AI 重填（<b>可改</b>）`);
  parts.push(...off);
  if (off.length) parts.push('想用模型说的那个写法，选「＋ 自定义…」把它加进清单，再点一次');
  if (blank.length) parts.push(`${blank.join('、')} 模型这次没给（它只看得到公司名，判不出就留空）`);
  if (kept.length) parts.push(`${kept.map((f) => S.TYPE_FIELDS[f]).join('、')} 是你自己选的，没动`);
  showTypeHint('企业类型：' + (parts.length ? parts.join('；') : '模型这次的结论与你已有的一致'));
}

if (typeAiBtn) typeAiBtn.addEventListener('click', reclassifyByAi);

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
  // 这次识别去哪儿问，由 model.js 一处决定（见它的文件头）：
  //   · 配了本机模型 → 浏览器直接问你填的那个接口，这条路上没有服务端的事
  //   · 没配 → 得有一条通往服务端的通道：**地址 + 注册口令**。同步口令不参与这个判断，
  //     也不是备选答案 —— 它只管"要不要把记录同步上去"：有同步口令但没注册口令时，
  //     这一行不出现（实测反馈：只删注册口令、留着同步口令时识别还能用，是错的）。
  // 两条都不成立 = 没有可以问的地方，这一行根本不出现（不是报错，用户什么都没做错）
  const ch = await MODELS.resolveChannel();
  if (ch.mode === 'none') return;
  const payload = {
    url: urlInput.value || extracted?.url || '',
    title: extracted?.title || '',
    companyCandidates: extracted?.companyCandidates || [],
    positionCandidates: extracted?.positionCandidates || [],
    pageText: pageTextForCheck(),   // 「答案在不在这一页上」由客户端判，判据需要整页文本
  };
  if (!payload.url) return;
  showAiLine('AI 识别中…');
  const ans = await AI.recognize(payload, ch.sync);
  if (seq !== aiSeq) return;   // 这中间用户又换了一页 / 已经保存过了
  if (!ans) { hideAiLine(); return; }   // 云端那条路没配模型、超时、断网：静默，什么都不说
  // 本机模型那条路的失败**要说出来**：那是用户自己刚配的东西，配错了得立刻看见；
  // 也要让他知道"这次没有偷偷改用云端"（不然只会以为配了没用）
  if (ans.failed) {
    // 「没跑通」与「跑通了、但模型说这一页上没有」是两件事：前者要用户改配置，
    // 后者要用户看这一页（抓没抓到内容）。混成同一句会让他在配置里白找（2026-10-09 实测反馈）
    const head = ans.failed.code === 'AI_EMPTY' ? 'AI 这次没给出建议：' : '本机模型没跑通：';
    showAiLine(`${head}${S.escapeHtml(AI.failText(ans.failed))}`);
    return;
  }
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
  // 公司名被 AI 改了，企业类型就得按新名字重判（本地库认的正是公司名）。
  // 上面那个循环只会往 applied 里塞「真改了值」的字段，这里跟着它走就不会白跑一遍
  if (applied.includes('company')) refreshCompanyType('company');

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
      // 名字改回去了，企业类型也跟着回到那个名字的判断上（不是回到"空"——本地能认出来的还是照认）
      if (aiOrigin.company !== undefined) refreshCompanyType('company');
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
  if (fields.includes('company')) refreshCompanyType('company');
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

  // 企业类型：下拉里的（或选「＋ 自定义…」后那个输入框里的）就是最终值。
  // 选了自定义却空着 → 拦下，不静默存空
  const nature = readTypeSelect('nature');
  const industry = readTypeSelect('industry');
  const badField = nature.bad ? 'nature' : (industry.bad ? 'industry' : '');
  if (badField) {
    showTypeHint(`企业类型：「${S.TYPE_FIELDS[badField]}」选了「＋ 自定义…」但没写内容。填一个你自己的写法，或把那一栏改回「（未填）」再保存。`);
    (badField === 'nature' ? natureCustomInput : industryCustomInput)?.focus();
    return;
  }

  const rec = S.makeRecord({
    company, position, url,
    jd: jdInput.value.trim(),
    sourceTitle: extracted?.title || '',
    // 空着就是「待确认」，面板里可以再改、也能批量识别补上
    nature: nature.value,
    industry: industry.value,
  });

  // 去重：同一 url + 同一岗位 已存在则确认
  const data = await S.loadData();
  const dup = data.records.find((r) => S.recordKey(r) === S.recordKey(rec));
  if (dup && !confirm(`该岗位已存在（${dup.company} · ${dup.position}，状态：${dup.status}）。\n仍要另存一条吗？`)) {
    return;
  }

  data.records.push(rec);
  // 刚刚手写的自定义值记进候选清单：与主面板**共用同一份** customTypes ——
  // 两边的下拉下次都能直接选到它，识别时也会随请求发给模型当候选集
  CT.rememberCustomType(data, 'nature', nature.value);
  CT.rememberCustomType(data, 'industry', industry.value);
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
    // 企业类型也要复位：表单已经清空，下一轮从干净状态开始（晚回来的分类响应靠 typeSeq 作废）
    typeSeq++;
    typeDirty.nature = false;
    typeDirty.industry = false;
    if (natureSelect) natureSelect.value = '';
    if (industrySelect) industrySelect.value = '';
    for (const sel of [natureSelect, industrySelect]) sel?.classList.remove('ai-filled');
    for (const input of [natureCustomInput, industryCustomInput]) {
      if (!input) continue;
      input.value = '';
      input.hidden = true;                 // form.reset() 清得掉值，清不掉 hidden，得自己收
      input.classList.remove('ai-filled');
    }
    // 下拉重铺一遍：刚记进去的自定义值（如果有）立刻可选，不用重开小窗口
    typeOptionsReady = fillTypeSelects();
    if (typeHint) { typeHint.hidden = true; typeHint.textContent = ''; }
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
// 公司名一改就得重判企业类型（本地库认的正是公司名）。这里管的是**手输/粘贴**那条路；
// AI 改公司名的那条路走不了 change 事件（那是在代码里赋的值），由上面的 applyAiSuggestion
// 与「采用」「撤销」三处在改完之后各手动调一次
companyInput.addEventListener('change', () => refreshCompanyType('company'));

// 企业类型的两个下拉：用户一改就记成「用户自己选的」，之后自动识别一律不许再动它。
// （选项由上面的 fillTypeSelects 铺，这里只管"用户动过"这件事；打开下拉看到的是自建列表）
for (const [field, sel] of [['nature', natureSelect], ['industry', industrySelect]]) {
  attachTypeSelect(sel, {
    isCustom: (v) => CT.isCustomType(typeData, field, v),
    onDelete: (v) => deleteCustomType(field, v),
  });
  sel?.addEventListener('change', () => {
    sel.classList.remove('ai-filled');
    typeDirty[field] = true;
    syncTypeCustom(field);
    if (sel.value === CT.CUSTOM_OPT) {
      showTypeHint('企业类型：在下面的框里写上你的写法，写完按回车就是确定 —— 保存后它会记进你的类型列表，以后两处都能直接选到');
      return;
    }
    showTypeHint('企业类型：已按你的选择记下（自动识别不会再改这一栏）');
  });
}
// 自定义输入框里按回车：只确定这一栏，**不许顺手把这张表单提交了**（那会连着存一条投递记录）
for (const field of ['nature', 'industry']) {
  TYPE_EDIT_IDS[field].custom?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();          // 拦掉表单的隐式提交：一次回车只完成一项确认
    commitCustomType(field);
  });
}

renderRecent();
extractCurrentPage();
