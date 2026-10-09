// dashboard.js — 管理面板：统计 / 搜索筛选 / 公司分组卡片 / 截止提醒 / 编辑 / JD / 导入导出 / 云同步
import * as S from '../shared.js';
import * as SY from '../sync.js';
import * as AI from '../ai.js';
import * as T from '../transfer.js';
import * as CT from '../company-type.js';
import * as MODELS from '../model.js';
// 两个自己画的控件：类型下拉（每一项右边一个 🗑）与日期时间（改完「分」就算选完）
import { attachTypeSelect, attachDateInput, closePicker } from '../pickers.js';

const state = {
  data: null, query: '', filter: 'all', editId: null, jdId: null, jdEditing: false,
  typeFilter: '',       // 企业类型筛选：'' / 'none'（未填）/ 'n:央企' / 'i:汽车/新能源'
  typeRun: null,        // 批量识别那一次的结果（预览表 + 撤销快照都在里面，见 runTypeClassify）
  ivId: null,           // 面经弹窗当前打开的是哪条记录
  ivEditing: null,      // null = 阅读态；{mode:'new'} 或 {mode:'edit', key} = 编辑态
  editDeadlines: [],    // 打开编辑面板那一刻的 rec.deadlines 快照（提交时判断哪些节点被删了）
  editUpdatedAt: null,  // 快照记录的 updatedAt：老节点没有自己的时间戳时退回到它
  view: localStorage.getItem('tracker.view') === 'board' ? 'board' : 'list',
  sort: localStorage.getItem('tracker.sort') === 'deadline' ? 'deadline' : 'updated',
  batchMode: false,     // 批量选择模式：卡片操作按钮让位，点卡片本体＝选中/取消
  batchSel: new Set(),  // 选中的记录 id（每次重绘后靠它回填选中态，见 renderBatchState）
  batchUndo: null,      // 上一次批量设置的撤销快照，一次性（{snap:[...]}）
};

const $ = (id) => document.getElementById(id);
const statsEl = $('stats'), chipsEl = $('filterChips'), upcomingEl = $('upcoming'),
  upcomingListEl = $('upcomingList'), groupsEl = $('groups'), boardEl = $('board'),
  emptyStateEl = $('emptyState'),
  footInfoEl = $('footInfo'), searchInput = $('searchInput');

// ---------- 数据与过滤 ----------
// 仅按搜索词过滤（chip 计数用：各状态计数不受当前选中状态影响）
function queryFilteredRecords() {
  const q = state.query.toLowerCase();
  if (!q) return state.data.records;
  return state.data.records.filter((r) => {
    if ([r.company, r.position, r.jd, r.sourceTitle].some((v) => (v || '').toLowerCase().includes(q))) return true;
    // 面经的题目与复盘也参与搜索：「上次被问到的那个题在哪」是它最主要的用法。
    // 现拼 + some 短路（不预先拼成一坨大字符串）：记录一多，省下的是绝大多数比较
    return (r.interviews || []).some((iv) =>
      `${iv.stage || ''} ${iv.question || ''} ${iv.review || ''}`.toLowerCase().includes(q));
  });
}

// 企业类型的筛选判据。值域刻意做成「前缀 + 值」而不是两个字段名：
// 性质与行业的取值绝不会有交集（枚举是两份），一个下拉就够，也不用记"这个值是性质还是行业"。
// 'none' 只看「两个字段都空」—— 只填了一半的记录在按「未填」筛时不该出现（它已经有类型了）
function matchTypeFilter(rec, key) {
  if (!key) return true;
  if (key === 'none') return !rec.nature && !rec.industry;
  if (key.startsWith('n:')) return rec.nature === key.slice(2);
  if (key.startsWith('i:')) return rec.industry === key.slice(2);
  return true;
}

// 完整过滤：搜索词 + 当前选中的状态筛选 + 企业类型筛选（列表/看板/批量计数共用这一个漏斗）
function filteredRecords() {
  let recs = queryFilteredRecords();
  if (state.filter === 'active') recs = recs.filter((r) => S.ACTIVE_STATUSES.includes(r.status));
  else if (state.filter.startsWith('status:')) {
    const s = state.filter.slice(7);
    recs = recs.filter((r) => r.status === s);
  }
  if (state.typeFilter) recs = recs.filter((r) => matchTypeFilter(r, state.typeFilter));
  return recs;
}

function findRecord(id) {
  return state.data.records.find((r) => r.id === id);
}

// ---------- 渲染：统计 ----------
function renderStats() {
  const { records } = state.data;
  const count = (fn) => records.filter(fn).length;
  const defs = [
    { label: '总投递', value: records.length, color: '#3B82F6' },
    { label: '进行中', value: count((r) => S.ACTIVE_STATUSES.includes(r.status)), color: '#0891B2' },
    { label: '面试中', value: count((r) => r.status === S.STATUS.INTERVIEW), color: '#4338CA' },
    { label: 'Offer已发', value: count((r) => r.status === S.STATUS.OFFER), color: '#16A34A' },
    { label: '待确认', value: count((r) => r.status === S.STATUS.PENDING), color: '#7C3AED' },
  ];
  statsEl.textContent = '';
  for (const d of defs) {
    const card = document.createElement('div');
    card.className = 'stat';
    card.innerHTML = `
      <div class="stat-label"><span class="stat-dot" style="background:${d.color}"></span>${d.label}</div>
      <div class="stat-value">${d.value}</div>`;
    statsEl.appendChild(card);
  }
}

// 看板模式：平滑滚动到对应状态列并闪烁提示
function scrollToBoardColumn(status) {
  const col = boardEl.querySelector(`.board-col[data-status="${CSS.escape(status)}"]`);
  if (!col) return;
  col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  col.classList.add('flash');
  setTimeout(() => col.classList.remove('flash'), 1800);
}

// ---------- 渲染：筛选 chips ----------
function renderChips() {
  // 计数基于"仅搜索过滤"的结果，各状态板块数量独立显示、不随当前选中状态变化
  const base = queryFilteredRecords();
  const defs = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    ...S.STATUS_LIST.map((s) => ({ key: 'status:' + s, label: s })),
  ];
  chipsEl.textContent = '';
  for (const d of defs) {
    const cnt = d.key === 'all' ? base.length
      : base.filter((r) =>
          d.key === 'active' ? S.ACTIVE_STATUSES.includes(r.status)
          : r.status === d.key.slice(7)).length;
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.filter === d.key ? ' active' : '');
    chip.innerHTML = `${S.escapeHtml(d.label)}<span class="cnt">${cnt}</span>`;
    chip.addEventListener('click', () => {
      if (state.view === 'board' && d.key.startsWith('status:')) {
        // 看板模式：清除筛选并自动跳到对应列（所有列保持可见）
        state.filter = 'all';
        renderAll();
        scrollToBoardColumn(d.key.slice(7));
        return;
      }
      state.filter = d.key;
      renderAll();
    });
    chipsEl.appendChild(chip);
  }
}

// ---------- 渲染：即将到期 ----------
function renderUpcoming() {
  const items = [];
  for (const rec of state.data.records) {
    for (const dl of rec.deadlines || []) {
      const meta = S.deadlineChipMeta(dl);
      if (meta && ['已过期', '今天', '明天'].includes(meta.label)) items.push({ rec, dl, meta });
    }
  }
  items.sort((a, b) => Date.parse(a.dl.datetime) - Date.parse(b.dl.datetime));
  upcomingEl.hidden = items.length === 0;
  upcomingListEl.textContent = '';
  for (const { rec, dl, meta } of items) {
    const chip = document.createElement('button');
    chip.className = 'upcoming-chip';
    chip.style.cssText = `color:${meta.color};background:${meta.bg}`;
    chip.innerHTML = `<span>${meta.label}</span><span>${S.escapeHtml(rec.company)} · ${S.escapeHtml(rec.position)}</span>` +
      `<span class="uc-time">${S.escapeHtml(dl.label)} ${S.fmtDateTime(dl.datetime)}</span>`;
    chip.addEventListener('click', () => scrollToCard(rec.id));
    upcomingListEl.appendChild(chip);
  }
}

// 按截止时间排序：有截止的按最早优先（已过期自然排最前），无截止的按最近更新排在最后
function sortByDeadline(recs) {
  return [...recs].sort((a, b) => {
    const da = S.nextDeadline(a), db = S.nextDeadline(b);
    const ta = da ? Date.parse(da.datetime) : Infinity;
    const tb = db ? Date.parse(db.datetime) : Infinity;
    if (ta !== tb) return ta - tb;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

// 企业类型徽标：性质与行业合成一枚（「央企 · 能源/化工」），只填了一半就只显示那一半。
// 两样都空 = 还没认过，给一枚灰的「类型待确认」—— 它正是「未填」筛选要抓的那些，
// 不标出来用户就只能一条条点开看（与「无 JD」同一个做法）
function typeBadgeHtml(rec) {
  const label = CT.typeLabel(rec.nature, rec.industry);
  // 两态都挂 badge-type：这是同一枚标签的"有值 / 没值"两种样子，badge-type-none 只负责换颜色
  if (label) return `<span class="badge badge-type">${S.escapeHtml(label)}</span>`;
  return `<span class="badge badge-type badge-type-none" title="企业类型还没填：工具栏的「🏷 识别企业类型」可以批量补">类型待确认</span>`;
}

// ---------- 渲染：公司分组整行卡片（每条投递一行，展示岗位/公司/状态/轮次/全部截止节点） ----------
function cardHtml(rec) {
  const [fg, bg] = S.statusColor(rec.status);
  const badges = [];
  if (rec.status === S.STATUS.INTERVIEW && rec.stage && rec.stage !== '未定') badges.push(`<span class="badge badge-stage">${S.escapeHtml(rec.stage)}</span>`);
  if (rec.status === S.STATUS.ENDED && rec.result) badges.push(`<span class="badge badge-result">${S.escapeHtml(rec.result)}</span>`);
  badges.push(typeBadgeHtml(rec));
  if (!rec.jd) badges.push(`<span class="badge badge-muted">无 JD</span>`);

  const deadlines = (rec.deadlines || []);
  const pending = deadlines.map((dl) => ({ dl, meta: S.deadlineChipMeta(dl) })).filter((x) => x.meta)
    .sort((a, b) => Date.parse(a.dl.datetime) - Date.parse(b.dl.datetime));
  const doneCount = deadlines.filter((d) => d.done).length;
  let dlHtml;
  if (pending.length === 0) {
    dlHtml = `<span class="dl-none">${deadlines.length ? '节点已全部完成' : '无截止节点'}</span>`;
  } else {
    dlHtml = pending.map(({ dl, meta }) => {
      const suffix = meta.label !== '远期' ? ` · ${meta.label}` : '';
      return `<span class="dl-chip" style="color:${meta.color};background:${meta.bg}">${S.escapeHtml(dl.label)} ${S.fmtDateTime(dl.datetime)}${suffix}</span>`;
    }).join('');
    if (doneCount) dlHtml += `<span class="dl-done-count">✓${doneCount} 已完成</span>`;
  }

  // 岗位名为空时：公司名顶上主行加粗展示，配"待补岗位"提醒，避免整卡灰白
  const mainLine = rec.position ? S.escapeHtml(rec.position) : (S.escapeHtml(rec.company) || '未填公司');
  const subLine = rec.position
    ? `<span class="co-name">${S.escapeHtml(rec.company || '未填公司')}</span>`
    : `<span class="tag-warn">${rec.company ? '待补岗位' : '待补公司与岗位'}</span>`;
  // 行内投递链接：只渲染 http(s) 链接，点击新标签页打开
  const host = S.hostOf(rec.url);
  const linkHtml = rec.url && /^https?:\/\//i.test(rec.url) && host
    ? `<a class="card-link" href="${S.escapeHtml(rec.url)}" target="_blank" rel="noreferrer" title="打开投递链接">↗ ${S.escapeHtml(host)}</a>`
    : '';
  const truncated = rec.notes && rec.notes.length > 18 ? rec.notes.slice(0, 18) + '…' : rec.notes;
  const noteInd = rec.notes
    ? `<span class="note-ind" data-note="${S.escapeHtml(rec.notes)}">📝</span><span class="note-txt">${S.escapeHtml(truncated)}</span>`
    : '';
  // 面经只显示条数，绝不把正文塞进 title/data-*：正文往往几千字，塞进 DOM 会让列表变卡
  const ivCount = (rec.interviews || []).length;

  const sel = state.batchMode && state.batchSel.has(rec.id);
  return `
    <article class="card${sel ? ' sel' : ''}" id="rec-${rec.id}" data-id="${rec.id}">
      ${state.batchMode ? '<span class="batch-check" aria-hidden="true"></span>' : ''}
      <div class="card-main">
        <h3 class="card-pos">${mainLine}</h3>
        <div class="card-co">${subLine}${linkHtml}${noteInd}</div>
      </div>
      <div class="card-status">
        <span class="pill" style="color:${fg};background:${bg}">${S.escapeHtml(rec.status)}</span>
        <div class="card-badges">${badges.join('')}</div>
      </div>
      <div class="card-date">投递于 ${S.fmtDate(rec.appliedAt)}</div>
      <div class="card-deadline">${dlHtml}</div>
      <div class="card-actions">
        <button class="btn-ghost iv-btn${ivCount ? '' : ' iv-btn-empty'}" data-action="iv" type="button" title="面经 / 复盘：按轮次记面试题目与经验">🎤${ivCount ? ` ${ivCount}` : ''}</button>
        <button class="btn-ghost" data-action="jd" type="button">JD</button>
        <button class="btn-ghost" data-action="edit" type="button">编辑</button>
        <button class="btn-danger" data-action="delete" type="button">删除</button>
      </div>
    </article>`;
}

function renderGroups() {
  const recs = filteredRecords();
  groupsEl.textContent = '';
  if (recs.length === 0) {
    groupsEl.innerHTML = `<div class="empty-state" style="padding:40px 20px"><div class="empty-title" style="font-size:15px">没有符合条件的记录</div></div>`;
    return;
  }
  // 截止时间排序：平铺展示（每条行已含公司名），最早截止优先
  if (state.sort === 'deadline') {
    const sorted = sortByDeadline(recs);
    groupsEl.innerHTML = `
      <div class="sort-note">⏰ 已按截止时间排序：最早的排最前（已过期 → 今天/明天 → 更远），无截止节点的排最后</div>
      <div class="group-cards">${sorted.map(cardHtml).join('')}</div>`;
    return;
  }
  const groups = new Map();
  for (const rec of recs) {
    const key = rec.company || '未填公司';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const entries = [...groups.entries()].sort((a, b) => {
    const la = Math.max(...a[1].map((r) => Date.parse(r.updatedAt) || 0));
    const lb = Math.max(...b[1].map((r) => Date.parse(r.updatedAt) || 0));
    return lb - la;
  });
  for (const [company, list] of entries) {
    list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const section = document.createElement('section');
    // 批量模式下分组头多一个「全选本组」：同一家公司的多个岗位正好是一组，一次勾完
    const groupPick = state.batchMode
      ? `<button class="btn-ghost btn-mini group-pick" type="button">${list.every((r) => state.batchSel.has(r.id)) ? '取消本组' : '全选本组'}</button>`
      : '';
    section.innerHTML = `
      <div class="group-head">
        <span class="group-name">${S.escapeHtml(company)}</span>
        <span class="group-count">${list.length} 个岗位</span>
        ${groupPick}
      </div>
      <div class="group-cards">${list.map(cardHtml).join('')}</div>`;
    const pickBtn = section.querySelector('.group-pick');
    if (pickBtn) {
      pickBtn.addEventListener('click', () => {
        const all = list.every((r) => state.batchSel.has(r.id));
        for (const r of list) { if (all) state.batchSel.delete(r.id); else state.batchSel.add(r.id); }
        renderAll();
      });
    }
    groupsEl.appendChild(section);
  }
}

function renderFoot() {
  const kb = (JSON.stringify(state.data).length / 1024).toFixed(1);
  footInfoEl.textContent = `${state.data.records.length} 条记录 · 本地存储约 ${kb} KB · 数据仅保存在本机 Chrome`;
}

// ---------- 渲染：看板视图 ----------
function boardCardHtml(rec) {
  const nd = S.nextDeadline(rec);
  const meta = nd ? S.deadlineChipMeta(nd) : null;
  const stage = rec.status === S.STATUS.INTERVIEW && rec.stage && rec.stage !== '未定'
    ? `<span class="badge badge-stage">${S.escapeHtml(rec.stage)}</span>` : '';
  const dl = nd && meta
    ? `<span class="dl-chip" style="color:${meta.color};background:${meta.bg}">${S.escapeHtml(nd.label)} ${S.fmtDateTime(nd.datetime)}</span>` : '';
  const bHost = S.hostOf(rec.url);
  const bLink = rec.url && /^https?:\/\//i.test(rec.url) && bHost
    ? `<a class="card-link" href="${S.escapeHtml(rec.url)}" target="_blank" rel="noreferrer" title="打开投递链接">↗ ${S.escapeHtml(bHost)}</a>`
    : '';
  // 看板卡也要有面经入口，否则切到看板就彻底找不到它了
  const bIv = (rec.interviews || []).length;
  const bType = CT.typeLabel(rec.nature, rec.industry);
  const sel = state.batchMode && state.batchSel.has(rec.id);
  return `
    <div class="board-card${sel ? ' sel' : ''}" draggable="${state.batchMode ? 'false' : 'true'}" data-id="${rec.id}">
      ${state.batchMode ? '<span class="batch-check" aria-hidden="true"></span>' : ''}
      <div class="board-card-pos">${rec.position ? S.escapeHtml(rec.position) : (S.escapeHtml(rec.company) || '未填公司')}</div>
      <div class="board-card-co">${rec.position ? S.escapeHtml(rec.company || '未填公司') : `<span class="tag-warn">${rec.company ? '待补岗位' : '待补公司'}</span>`}${bLink}</div>
      <div class="board-card-meta">${stage}${bType ? `<span class="badge badge-type">${S.escapeHtml(bType)}</span>` : ''}${dl}</div>
      <div class="board-card-actions">
        <button class="mini" data-action="iv" type="button" title="面经 / 复盘">🎤${bIv ? ` ${bIv}` : ''}</button>
        <button class="mini" data-action="jd" type="button">JD</button>
        <button class="mini" data-action="edit" type="button">编辑</button>
      </div>
    </div>`;
}

function renderBoard() {
  const recs = filteredRecords();
  boardEl.textContent = '';
  if (recs.length === 0) {
    boardEl.innerHTML = `<div class="empty-state" style="padding:40px 20px"><div class="empty-title" style="font-size:15px">没有符合条件的记录</div></div>`;
    return;
  }
  for (const status of S.STATUS_LIST) {
    const list = recs.filter((r) => r.status === status);
    const [fg] = S.statusColor(status);
    const col = document.createElement('div');
    col.className = 'board-col';
    col.dataset.status = status;
    col.innerHTML = `
      <div class="board-col-head">
        <span class="board-dot" style="background:${fg}"></span>
        <span class="board-col-name">${S.escapeHtml(status)}</span>
        <span class="board-col-cnt">${list.length}</span>
      </div>
      <div class="board-col-body">${list.map(boardCardHtml).join('')}</div>`;
    boardEl.appendChild(col);
  }
}

// ---------- 看板拖拽 ----------
let dragId = null;
boardEl.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.board-card');
  if (!card) return;
  dragId = card.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragId); } catch { /* 合成事件可能不支持 */ }
  card.classList.add('dragging');
});
boardEl.addEventListener('dragend', () => {
  dragId = null;
  boardEl.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
});
boardEl.addEventListener('dragover', (e) => {
  if (!e.target.closest('.board-col')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
boardEl.addEventListener('drop', async (e) => {
  const col = e.target.closest('.board-col');
  if (!col) return;
  e.preventDefault();
  const id = (e.dataTransfer.getData('text/plain') || dragId || '').trim();
  if (!id) return;
  // 读-改-写：以存储最新数据为准
  const data = await S.loadData();
  const rec = data.records.find((r) => r.id === id);
  if (!rec || rec.status === col.dataset.status) return;
  S.applyStatusChange(rec, col.dataset.status, '看板拖拽');
  try { await S.saveData(data); } catch (err) { alert('保存失败：' + err?.message); return; }
  state.data = data;
  renderAll();
});

// ---------- 视图切换 ----------
function setView(view) {
  state.view = view;
  localStorage.setItem('tracker.view', view);
  syncViewToggle();
  renderAll();
}

function renderAll() {
  pruneBatchSel();
  // 在 renderChips/renderGroups 之前：它可能在"选中的取值已经不存在了"时把筛选退回「全部」，
  // 退得晚一步，这一帧就会显示成"下拉写着全部、列表却空着"
  renderTypeFilter();
  renderStats();
  renderChips();
  renderUpcoming();
  const isBoard = state.view === 'board';
  const totalEmpty = state.data.records.length === 0;
  emptyStateEl.hidden = !totalEmpty;
  groupsEl.hidden = isBoard || totalEmpty;
  boardEl.hidden = !isBoard || totalEmpty;
  if (isBoard) renderBoard(); else renderGroups();
  renderFoot();
  renderBatchBar();
  // 放在最后：顶栏里那排按钮（含随内容变长的同步状态）折行与否会改变它的高度，
  // 而批量条就停在这个高度下面（CSS 的 --topbar-h）
  syncTopbarHeight();
}

function scrollToCard(id) {
  const el = document.getElementById('rec-' + id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

// ---------- 编辑模态框 ----------
// 保存失败的提示语（编辑面板与 JD 模态框共用）。分两种：
//   · 扩展刚重载过 → 这个面板页是旧页面，chrome.storage 已经失效，提示刷新（最常见的一种）
//   · 其它（含存储配额）→ 照原样报出来，别吞
function saveFailMessage(err) {
  const msg = String(err?.message || err);
  if (/context invalidated|Extension context|message channel closed/i.test(msg)) {
    return '保存失败：扩展刚刚更新过，这个面板页还是旧页面。\n\n请按 ⌘/Ctrl+R 刷新本页（页面顶部也有刷新提示），然后重新保存 —— 你填的内容不会丢，刷新前可以先复制一份。';
  }
  if (/QUOTA|quota|空间不足/i.test(msg)) {
    return '保存失败：存储空间不足。请先在面板导出备份，再清理不再需要的旧记录。';
  }
  return '保存失败：' + msg;
}

const editModal = $('editModal'), editForm = $('editForm');
const bmStatus = $('bmStatus'), bmStage = $('bmStage'), bmResult = $('bmResult'), bmShortcuts = $('bmShortcuts');
const efCompany = $('efCompany'), efPosition = $('efPosition'), efUrl = $('efUrl'),
  efAppliedAt = $('efAppliedAt'), efStatus = $('efStatus'), efStageWrap = $('efStageWrap'),
  efStage = $('efStage'), efResultWrap = $('efResultWrap'), efResult = $('efResult'),
  efDeadlineHint = $('efDeadlineHint'), efDeadlines = $('efDeadlines'),
  efNote = $('efNote'), efChangeNote = $('efChangeNote');

function initSelects() {
  for (const s of S.STATUS_LIST) efStatus.add(new Option(s, s));
  for (const s of S.STAGES) efStage.add(new Option(s, s));
  for (const r of S.RESULTS) efResult.add(new Option(r, r));
  // 面经的轮次比 STAGES 多「笔试 / 测评 / 其他」：那两个是独立状态，不是面试的轮次
  for (const s of S.INTERVIEW_STAGES) ivStage.add(new Option(s, s));
  // 批量设置：状态多一项「不修改」（值空＝这一项不动），节点名给 4 个常用快捷名
  bmStatus.add(new Option('不修改', ''));
  for (const s of S.STATUS_LIST) bmStatus.add(new Option(s, s));
  for (const s of S.STAGES) bmStage.add(new Option(s, s));
  for (const r of S.RESULTS) bmResult.add(new Option(r, r));
  for (const name of new Set(Object.values(S.STATUS_DEADLINE_HINTS))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-ghost btn-mini';
    b.dataset.dl = name;
    b.textContent = name;
    bmShortcuts.appendChild(b);
  }
}

// 编辑面板里的节点行 → 原节点对象。行的身份靠这份登记表，不靠 data-id：
// 提交时 rec 会从存储重读（可能已被后台同步换过一批），拿 DOM 里的 id 反查会认错节点。
let editRows = [];

// 截止节点行：时间为空 → 编辑态（datetime 输入 + ✓确定）；已设时间 → 确认态（时间 chip + 修改）
// 注意 data-id 只写节点**真实**的 id：渲染时现编一个 uid 会让老节点每次保存都换 id，
// 于是"同一个节点"在另一台设备上变成两个。老节点的 id 由 deadlineId 在保存那刻按内容算出来。
function deadlineRowHtml(dl = {}) {
  const hasTime = Boolean(dl.datetime);
  return `
    <div class="dl-row"${dl.id ? ` data-id="${S.escapeHtml(dl.id)}"` : ''}>
      <input class="dl-label" type="text" placeholder="节点名称，如：笔试截止" value="${S.escapeHtml(dl.label || '')}" autocomplete="off">
      <input class="dl-datetime" type="datetime-local" value="${dl.datetime ? S.isoToLocalInput(dl.datetime) : ''}" ${hasTime ? 'hidden' : ''}>
      <span class="dl-time-chip" ${hasTime ? '' : 'hidden'}>${dl.datetime ? S.fmtDateTime(dl.datetime) : ''}</span>
      <button class="dl-ok" type="button" title="${hasTime ? '修改时间' : '确认时间'}">${hasTime ? '修改' : '✓ 确定'}</button>
      <label class="dl-done"><input type="checkbox" ${dl.done ? 'checked' : ''}> 完成</label>
      <button class="dl-remove" type="button" title="删除节点">×</button>
    </div>`;
}

// 往面板里加一行，并登记「行 → 原节点」。
// isNew = 这一行是用户新加的（原节点为空）→ 提交时给它随机 id；
// 老节点带 id 或由内容物化出 id（见 collectDeadlineRows），两者不能混。
// **所有**加行的入口都必须走这里：直接 insertAdjacentHTML 的行不在登记表里，
// 提交时会被整行丢掉（用户填完保存就没了）。
function addDeadlineRow(dl, isNew = false) {
  const wrap = document.createElement('div');
  wrap.innerHTML = deadlineRowHtml(dl || {});
  const row = wrap.firstElementChild;
  editRows.push({ row, node: isNew ? null : (dl || null) });
  efDeadlines.appendChild(row);
  // 时间框走自建日历：选完「分」就把值写进来并收起输入框（与点行尾那个「✓ 确定」同一条收尾路）
  attachDateInput(row.querySelector('.dl-datetime'), { onCommit: () => toggleDeadlineTime(row) });
  return row;
}

// 确认/修改截止时间：确定后收起输入框显示时间 chip，符合常规交互习惯
function toggleDeadlineTime(row) {
  const input = row.querySelector('.dl-datetime');
  const chip = row.querySelector('.dl-time-chip');
  const btn = row.querySelector('.dl-ok');
  if (input.hidden) {
    // 修改态：重新展开输入框
    input.hidden = false;
    chip.hidden = true;
    btn.textContent = '✓ 确定';
    btn.title = '确认时间';
    input.focus();
  } else if (input.value) {
    const iso = S.localInputToIso(input.value);
    if (!iso) return;
    input.hidden = true;
    chip.textContent = S.fmtDateTime(iso);
    chip.hidden = false;
    btn.textContent = '修改';
    btn.title = '修改时间';
  } else {
    // 未选时间：闪烁提示
    input.classList.add('dl-error');
    setTimeout(() => input.classList.remove('dl-error'), 900);
  }
}

function refreshDeadlineHint() {
  const hintLabel = S.STATUS_DEADLINE_HINTS[efStatus.value];
  const already = [...efDeadlines.querySelectorAll('.dl-label')].some((i) => i.value === hintLabel);
  if (hintLabel && !already) {
    efDeadlineHint.hidden = false;
    efDeadlineHint.innerHTML = `<span>建议添加节点：「${hintLabel}」，到点自动提醒</span><button type="button" id="addHintBtn">+ 一键添加</button>`;
    document.getElementById('addHintBtn').addEventListener('click', () => {
      addDeadlineRow({ label: hintLabel }, true);   // 新节点：给随机 id，别和别处的同名节点撞成一个
      efDeadlineHint.hidden = true;
    });
  } else {
    efDeadlineHint.hidden = true;
  }
}

function openEditModal(id) {
  const rec = findRecord(id);
  if (!rec) return;
  state.editId = id;
  $('editModalTitle').textContent = `${rec.company || '未填公司'} · ${rec.position || '未填岗位'}`;
  efCompany.value = rec.company || '';
  efPosition.value = rec.position || '';
  efUrl.value = rec.url || '';
  efAppliedAt.value = S.isoToLocalInput(rec.appliedAt);
  efStatus.value = S.STATUS_LIST.includes(rec.status) ? rec.status : S.STATUS.PENDING;
  efStage.value = rec.stage || '未定';
  efResult.value = rec.result || '其他';
  efNote.value = rec.notes || '';
  efChangeNote.value = '';
  fillTypeEditors(rec);
  // 「AI 再认一次」的状态跟着弹窗一起重置：上一次开窗时动过的那两栏不该影响这一次
  efTypeDirty.nature = false;
  efTypeDirty.industry = false;
  $('efTypeHint').hidden = true;
  $('efTypeAiBtn').disabled = false;
  $('historyBtn').textContent = `🕘 查看状态历史（${(rec.history || []).length} 条）`;
  refreshIvBtn();
  // 快照：提交时用它判断"哪些节点是被 × 掉的"，而不是拿提交那刻重读的数据反推
  state.editDeadlines = (rec.deadlines || []).slice();
  state.editUpdatedAt = rec.updatedAt;
  editRows = [];
  efDeadlines.innerHTML = '';
  for (const d of state.editDeadlines) addDeadlineRow(d);
  efStageWrap.hidden = efStatus.value !== S.STATUS.INTERVIEW;
  efResultWrap.hidden = efStatus.value !== S.STATUS.ENDED;
  refreshDeadlineHint();
  editModal.hidden = false;
}

/**
 * 把编辑面板的节点行收成新的节点数组：增 / 改 / 删都要能传到另一台设备。
 *   · 动过的行 → 顶新该节点的 updatedAt（节点级 LWW 的"这次是我改的"）
 *   · 没动过的行 → 时间戳原样带着（于是"打开面板什么都没改就保存"不会把节点伪装成刚改过）
 *   · 快照里有、面板里没有的 → 写墓碑（删除在协议里唯一的表达方式）
 *   · 最后与本机存储那份按同一套规则合并：编辑期间别处新加的节点被并进来（不能当成被删了），
 *     别处改过而本机没动过的节点以对方为准
 * @param {object[]} baseline 打开面板时的 rec.deadlines 快照
 * @param {object} fresh      提交时从存储重读的那条记录
 * @param {string} baselineAt 快照记录的 updatedAt（老节点没有自己的时间戳时退回到它）
 */
function collectDeadlineRows(baseline, fresh, baselineAt) {
  const panel = [];
  const kept = new Set();
  for (const { row, node } of editRows) {
    if (!row.isConnected) continue;                 // 这一行被 × 掉了
    const datetime = S.localInputToIso(row.querySelector('.dl-datetime').value);
    // 没填时间的行不算节点（与旧行为一致：它本来就进不了记录，别为它写墓碑）
    if (!datetime) { if (node) kept.add(node); continue; }
    const label = row.querySelector('.dl-label').value.trim() || '截止节点';
    const done = row.querySelector('.dl-done input').checked;
    if (node) kept.add(node);
    const changed = !node || node.label !== label || node.datetime !== datetime || Boolean(node.done) !== done;
    panel.push(changed
      // 老节点（没有 id）在第一次被改动时按**改动前**的内容物化一个确定性 id：
      // 对端手里那份还是老内容，算出来的 key 正是同一个，于是"改过的那一个"在对方那里
      // 还是同一个节点、而不是多出一条。全新节点用随机 id —— 内容相同的两个节点该是两条。
      ? { ...node, id: node ? (node.id || S.deadlineId(node)) : S.uid(), label, datetime, done,
          updatedAt: S.nextStamp(node?.updatedAt || baselineAt) }
      : node);
  }
  const alive = new Set();
  for (const d of panel) for (const a of S.deadlineAliases(d)) alive.add(a);
  const tombstones = [];
  for (const node of baseline || []) {
    if (kept.has(node)) continue;
    if ([...S.deadlineAliases(node)].some((a) => alive.has(a))) continue;   // 同一个节点又加回来了
    tombstones.push({ key: S.deadlineKey(node), at: S.nextStamp(node.updatedAt || baselineAt) });
  }
  const m = S.mergeDeadlineState(
    { deadlines: panel, deadlineTombstones: tombstones, updatedAt: baselineAt },
    { deadlines: fresh?.deadlines || [], deadlineTombstones: fresh?.deadlineTombstones || [],
      updatedAt: fresh?.updatedAt || baselineAt },
    { prefer: 'a' });   // 两边都没有节点时间戳（老数据）时以面板里这份为准
  return { deadlines: m.deadlines, deadlineTombstones: m.deadlineTombstones };
}

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.editId) return;
  // 先读取表单值（防止异步期间表单变化）
  const company = efCompany.value.trim();
  const position = efPosition.value.trim();
  const nextStatus = efStatus.value;
  const stageVal = efStage.value;
  const resultVal = efResult.value;
  const notes = efNote.value.trim();
  const changeNote = efChangeNote.value.trim();
  const url = efUrl.value.trim();
  const applied = S.localInputToIso(efAppliedAt.value);
  const nature = readTypeEditor('efNature', 'efNatureCustom');
  const industry = readTypeEditor('efIndustry', 'efIndustryCustom');
  if (nature.bad || industry.bad) {
    alert('企业类型选了「＋ 自定义…」，但没填内容。\n\n请输入自定义的写法，或把那一栏改回「（未填）」再保存。');
    return;   // 保持面板打开，别的地方填的东西一点都不丢
  }

  // 读-改-写：以存储中最新的数据为准，避免多标签页/旧页面内存数据相互覆盖。
  // 读也在 try 里：扩展重载后没刷新的旧面板页，chrome.storage 会抛 Extension context invalidated，
  // 放在外面会变成"点了保存没反应"（见 JD 保存那段同样的处理）
  let data;
  try {
    data = await S.loadData();
  } catch (err) {
    alert(saveFailMessage(err));
    return;   // 保持面板打开，用户填的内容不丢
  }
  const rec = data.records.find((r) => r.id === state.editId);
  if (!rec) { editModal.hidden = true; state.data = data; renderAll(); return; }

  rec.company = company;
  rec.position = position;
  rec.url = url;
  rec.notes = notes;
  // 企业类型：手动编辑是最高优先 —— 批量识别、导入识别都不会再改它（它们只填空）
  rec.nature = nature.value;
  rec.industry = industry.value;
  CT.rememberCustomType(data, 'nature', nature.value);
  CT.rememberCustomType(data, 'industry', industry.value);
  if (applied) rec.appliedAt = applied;
  // 状态变更记录历史；状态未变但写了变更说明时也留一条记录
  if (nextStatus !== rec.status || changeNote) S.applyStatusChange(rec, nextStatus, changeNote);
  rec.stage = nextStatus === S.STATUS.INTERVIEW ? (stageVal || null) : null;
  rec.result = nextStatus === S.STATUS.ENDED ? (resultVal || null) : null;
  // 节点：以打开面板时的快照为基准收行（rec 是刚重读的，节点可能已经被后台同步换过一批）
  {
    const collected = collectDeadlineRows(state.editDeadlines || [], rec, state.editUpdatedAt);
    rec.deadlines = collected.deadlines;
    rec.deadlineTombstones = collected.deadlineTombstones;
  }
  rec.updatedAt = S.nextStamp(rec.updatedAt);

  try {
    await S.saveData(data);
  } catch (err) {
    alert(saveFailMessage(err));
    return;
  }
  state.data = data;
  editModal.hidden = true;
  renderAll();
});

efStatus.addEventListener('change', () => {
  efStageWrap.hidden = efStatus.value !== S.STATUS.INTERVIEW;
  efResultWrap.hidden = efStatus.value !== S.STATUS.ENDED;
  refreshDeadlineHint();
});

efDeadlines.addEventListener('click', (e) => {
  if (e.target.classList.contains('dl-remove')) { e.target.closest('.dl-row').remove(); return; }
  if (e.target.classList.contains('dl-ok')) toggleDeadlineTime(e.target.closest('.dl-row'));
});
$('swapBtn').addEventListener('click', () => {
  const c = efCompany.value;
  efCompany.value = efPosition.value;
  efPosition.value = c;
});

// ---------- 状态历史弹窗 ----------
function renderHistoryModal(rec) {
  $('historyModalTitle').textContent = `${rec.company || '未填公司'} · ${rec.position || '未填岗位'}`;
  const body = $('historyBody');
  body.textContent = '';
  if (!rec.history || rec.history.length === 0) {
    body.innerHTML = `<div class="history-empty">暂无状态历史</div>`;
    return;
  }
  for (const h of [...rec.history].reverse()) {
    const entry = document.createElement('div');
    entry.className = 'h-entry';
    const [toFg] = S.statusColor(h.to || '');
    entry.innerHTML = `
      <div class="h-time">${S.fmtDateTime(h.at)}</div>
      <div class="h-flow">
        ${h.from ? S.escapeHtml(h.from) : '<span class="muted">初始</span>'}
        <span class="h-arrow">→</span>
        <span class="h-to" style="color:${toFg}">${S.escapeHtml(h.to || '')}</span>
      </div>
      ${h.note ? `<div class="h-note">${S.escapeHtml(h.note)}</div>` : ''}`;
    body.appendChild(entry);
  }
}

$('historyBtn').addEventListener('click', () => {
  const rec = findRecord(state.editId);
  if (!rec) return;
  renderHistoryModal(rec);
  $('historyModal').hidden = false;
});
$('addDeadlineBtn').addEventListener('click', () => {
  addDeadlineRow(null, true);
});

// ---------- JD 模态框 ----------
const jdModal = $('jdModal'), jdView = $('jdView'), jdEdit = $('jdEdit');
const jdEditToggle = $('jdEditToggle'), jdSaveBtn = $('jdSaveBtn'), jdCancelBtn = $('jdCancelBtn');

function openJdModal(id) {
  const rec = findRecord(id);
  if (!rec) return;
  state.jdId = id;
  state.jdEditing = false;
  $('jdModalTitle').textContent = `${rec.company || '未填公司'} · ${rec.position || '未填岗位'}`;
  jdView.textContent = rec.jd || '暂无 JD。点击下方"编辑 JD"粘贴岗位描述。';
  jdView.classList.toggle('jd-empty', !rec.jd);
  jdView.hidden = false; jdEdit.hidden = true;
  jdEditToggle.hidden = false; jdSaveBtn.hidden = true; jdCancelBtn.hidden = true;
  const openLink = $('jdOpenLink');
  openLink.hidden = !rec.url;
  openLink.onclick = () => { if (rec.url) chrome.tabs.create({ url: rec.url }); };
  jdModal.hidden = false;
}

jdEditToggle.addEventListener('click', () => {
  const rec = findRecord(state.jdId);
  if (!rec) return;
  state.jdEditing = true;
  jdEdit.value = rec.jd || '';
  jdView.hidden = true; jdEdit.hidden = false;
  jdEditToggle.hidden = true; jdSaveBtn.hidden = false; jdCancelBtn.hidden = false;
  jdEdit.focus();
});

jdCancelBtn.addEventListener('click', () => openJdModal(state.jdId));

jdSaveBtn.addEventListener('click', async () => {
  const text = jdEdit.value.trim();
  // 整段（含读）都在 try 里：读那一步也会失败 —— 典型是"扩展重载后没刷新面板页"，
  // 旧页面的 chrome.storage 已经失效，会抛 Extension context invalidated。
  // 以前失败点在 try 之外 → 点了保存没反应、没有任何提示，用户以为存上了（JD 其实没写进本机）。
  try {
    // 读-改-写（与编辑面板同一个套路）：JD 模态框可能开着很久，期间后台同步/别的标签页会换掉这份数据
    const data = await S.loadData();
    const rec = data.records.find((r) => r.id === state.jdId);
    if (!rec) {
      state.data = data;
      renderAll();
      jdModal.hidden = true;
      alert('这条记录已经不在了（可能被另一端删除、或被同步合并掉了）。\n刚才的修改没有保存。');
      return;
    }
    rec.jd = text;
    // 改 JD 就是一次记录改动，必须顶新 updatedAt —— JD 没有自己的时间戳，同步时整条按这个时间戳
    // 判胜负（见 sync.js 的 applyRemoteRecords）。顶到 max(现在, 已知版本 + 1ms) 而不是直接取现在：
    // 本机时钟比对方慢时，"刚改的"会输给"本机已经见过的"那一版，表现就是改完同步又被盖回来。
    rec.updatedAt = S.nextStamp(rec.updatedAt);
    await S.saveData(data);
    state.data = data;
  } catch (err) {
    alert(saveFailMessage(err) + '\n（JD 没有写进本机；你写的内容还在编辑框里）');
    return;   // 保持编辑态：内容不丢，用户可以直接重试/复制
  }
  renderAll();
  openJdModal(state.jdId);
});

// ---------- 面经 / 复盘模态框 ----------
// 一条面经 = 一次笔试或一轮面试。阅读态给的是全宽可滚动的长文 ——
// 备注栏只有 rows=2 的一小块，长文在那儿没法看，这正是要做这个弹窗的原因。
// 条目在设备之间按「条目级 LWW + 条目墓碑」收敛（见 shared.js 的 mergeInterviewState）：
// 电脑记一条、手机记一条，是并集，不会互相覆盖。
const ivModal = $('ivModal'), ivList = $('ivList'), ivEditBox = $('ivEdit'),
  ivStage = $('ivStage'), ivAt = $('ivAt'), ivQuestion = $('ivQuestion'), ivReview = $('ivReview'),
  ivAddBtn = $('ivAddBtn'), ivSaveBtn = $('ivSaveBtn'), ivCancelBtn = $('ivCancelBtn'), ivHint = $('ivHint');

function showIvHint(msg) {
  ivHint.textContent = msg;
  ivHint.hidden = false;
}

// 新建时的默认轮次：跟着这条投递当前的位置走，省一次手选
function defaultIvStage(rec) {
  if (rec.status === S.STATUS.INTERVIEW && rec.stage && rec.stage !== '未定') return rec.stage;
  if (rec.status === S.STATUS.WRITTEN) return '笔试';
  if (rec.status === S.STATUS.ASSESSMENT) return '测评';
  return '一面';
}

function ivItemHtml(iv) {
  const k = S.interviewKey(iv);
  return `
    <div class="iv-item">
      <div class="iv-head">
        <span class="iv-badge">${S.escapeHtml(iv.stage || '其他')}</span>
        <span class="iv-at">${S.escapeHtml(S.fmtDate(iv.at))}</span>
        <span class="iv-spacer"></span>
        <button class="iv-act" type="button" data-iv-edit="${S.escapeHtml(k)}">编辑</button>
        <button class="iv-act iv-del" type="button" data-iv-del="${S.escapeHtml(k)}">删除</button>
      </div>
      ${iv.question ? `<div class="iv-q">${S.escapeHtml(iv.question)}</div>` : ''}
      ${iv.review ? `<div class="iv-r">${S.escapeHtml(iv.review)}</div>` : ''}
    </div>`;
}

function renderIvList(rec) {
  // 倒序：最近一轮排最前（复盘时最常看的就是刚面完的那场）
  const list = (rec.interviews || []).slice().sort((a, b) =>
    String(b.at || '').localeCompare(String(a.at || ''))
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  ivList.innerHTML = list.length
    ? list.map(ivItemHtml).join('')
    : `<div class="iv-empty">还没有记录。面完一轮就点右下角「+ 记录一次」，<br>把题目和复盘写在这里 —— 它会跟着这条投递一起同步、一起备份。</div>`;
}

function renderIvModal() {
  const rec = findRecord(state.ivId);
  if (!rec) { ivModal.hidden = true; return; }
  const editing = Boolean(state.ivEditing);
  ivList.hidden = editing;
  ivEditBox.hidden = !editing;
  ivAddBtn.hidden = editing;
  ivSaveBtn.hidden = !editing;
  ivCancelBtn.hidden = !editing;
  if (editing) ivHint.hidden = true;
  else renderIvList(rec);
}

function openIvModal(id) {
  const rec = findRecord(id);
  if (!rec) return;
  state.ivId = id;
  state.ivEditing = null;
  $('ivModalTitle').textContent = `${rec.company || '未填公司'} · ${rec.position || '未填岗位'} · 面经`;
  renderIvModal();
  ivModal.hidden = false;
}

// 编辑面板里那个入口按钮上的条数（面经增删后要跟着变）
function refreshIvBtn() {
  const rec = state.editId ? findRecord(state.editId) : null;
  $('ivBtn').textContent = `🎤 面经 / 复盘（${(rec?.interviews || []).length} 条）`;
}

// 进入编辑态：iv 为空 = 新记一次，否则是改既有那一条
function startIvEdit(iv) {
  const rec = findRecord(state.ivId);
  if (!rec) return;
  state.ivEditing = { mode: iv ? 'edit' : 'new', key: iv ? S.interviewKey(iv) : '' };
  ivStage.value = iv ? (iv.stage || '其他') : defaultIvStage(rec);
  ivAt.value = S.isoToLocalInput(iv ? iv.at : new Date().toISOString());
  ivQuestion.value = iv ? (iv.question || '') : '';
  ivReview.value = iv ? (iv.review || '') : '';
  renderIvModal();
  ivQuestion.focus();
}

// 面经的增 / 改 / 删都走这里：读-改-写 + 顶记录时间戳。
// 顶戳是必须的 —— 自动同步按「updatedAt >= 上次同步水位」筛要推的记录（sync.js），
// 不顶的话这次改动永远上不了云，另一台设备看不到。
async function mutateInterviews(fn) {
  let data;
  try {
    data = await S.loadData();
  } catch (err) {
    alert(saveFailMessage(err));
    return false;
  }
  const rec = data.records.find((r) => r.id === state.ivId);
  if (!rec) {
    state.data = data;
    state.ivEditing = null;
    ivModal.hidden = true;
    renderAll();
    alert('这条记录已经不在了（可能被另一端删除、或被同步合并掉了）。');
    return false;
  }
  // 老记录（本次升级前建的）可能还没有这两个键
  if (!Array.isArray(rec.interviews)) rec.interviews = [];
  if (!Array.isArray(rec.interviewTombstones)) rec.interviewTombstones = [];
  fn(rec);
  rec.updatedAt = S.nextStamp(rec.updatedAt);
  try {
    await S.saveData(data);
  } catch (err) {
    alert(saveFailMessage(err));
    return false;
  }
  state.data = data;
  renderAll();
  refreshIvBtn();
  return true;
}

ivAddBtn.addEventListener('click', () => startIvEdit(null));
ivCancelBtn.addEventListener('click', () => { state.ivEditing = null; renderIvModal(); });

ivSaveBtn.addEventListener('click', async () => {
  const stage = ivStage.value;
  const at = S.localInputToIso(ivAt.value) || new Date().toISOString();
  const question = ivQuestion.value.trim();
  const review = ivReview.value.trim();
  if (!question && !review) { showIvHint('题目和复盘至少写一项'); return; }
  const editing = state.ivEditing;
  const ok = await mutateInterviews((rec) => {
    if (editing?.mode === 'edit') {
      const iv = (rec.interviews || []).find((x) => S.interviewKey(x) === editing.key);
      if (!iv) return;
      // 老条目（没有 id）第一次被改动时按**改动前**的内容物化 id：对端手里那份还是老内容，
      // 算出来的 key 正是同一个，于是"改过的那条"在对方那里还是同一条、而不是多出一条
      iv.id = iv.id || S.interviewId(iv);
      Object.assign(iv, { stage, at, question, review, updatedAt: S.nextStamp(iv.updatedAt) });
    } else {
      rec.interviews.push({ id: S.uid(), stage, at, question, review, updatedAt: new Date().toISOString() });
    }
  });
  if (!ok) return;   // 失败时保持编辑态：写的内容还在框里
  state.ivEditing = null;
  renderIvModal();
});

ivList.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-iv-edit]');
  if (editBtn) {
    const rec = findRecord(state.ivId);
    const iv = (rec?.interviews || []).find((x) => S.interviewKey(x) === editBtn.dataset.ivEdit);
    if (iv) startIvEdit(iv);
    return;
  }
  const delBtn = e.target.closest('[data-iv-del]');
  if (!delBtn) return;
  const key = delBtn.dataset.ivDel;
  if (!confirm('删除这条面经？删掉后其他设备也会跟着删。')) return;
  const done = await mutateInterviews((rec) => {
    const i = rec.interviews.findIndex((x) => S.interviewKey(x) === key);
    if (i < 0) return;
    const [iv] = rec.interviews.splice(i, 1);
    // 删除在协议里唯一的表达方式：墓碑。没有它，另一台设备下次同步就把这条又带回来了
    rec.interviewTombstones.push({ key: S.interviewKey(iv), at: S.nextStamp(iv.updatedAt || rec.updatedAt) });
  });
  // mutateInterviews 只负责重画卡片（renderAll），弹窗里的列表得自己再画一次
  if (done) renderIvModal();
});

// 关闭面经弹窗：编辑到一半先问一句，免得白写一场
function closeIvModal() {
  if (state.ivEditing && (ivQuestion.value.trim() || ivReview.value.trim())) {
    if (!confirm('这条面经还没保存，确定关掉吗？（关掉后写的内容就没了）')) return;
  }
  state.ivEditing = null;
  ivModal.hidden = true;
  refreshIvBtn();
}

$('ivBtn').addEventListener('click', () => {
  if (state.editId) openIvModal(state.editId);
});

// ---------- 卡片操作（事件委托，列表与看板共用） ----------
async function handleCardAction(e) {
  if (state.batchMode) return;  // 批量模式下卡片按钮已隐藏，点卡片本体走选中逻辑（onCardClick）
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const holder = btn.closest('[data-id]');
  const id = holder?.dataset.id;
  if (!id) return;
  const rec = findRecord(id);
  if (!rec) return;
  const action = btn.dataset.action;
  if (action === 'jd') openJdModal(id);
  else if (action === 'iv') openIvModal(id);
  else if (action === 'edit') openEditModal(id);
  else if (action === 'delete') {
    if (!confirm(`删除「${rec.company || '未填公司'} · ${rec.position || '未填岗位'}」这条记录？此操作不可恢复。`)) return;
    // 读-改-写 + 写墓碑：墓碑用于把"删除"同步到其他设备，避免被旧数据复活
    const data = await S.loadData();
    SY.tombstone(data, id);
    try { await S.saveData(data); } catch (err) { alert('保存失败：' + err?.message); return; }
    state.data = data;
    renderAll();
  }
}
groupsEl.addEventListener('click', handleCardAction);
boardEl.addEventListener('click', handleCardAction);

// ---------- 批量设置（一次改多条：状态 / 轮次 / 结果 / 截止节点，或批量删除） ----------
// 纯客户端功能：批量只是同一套字段的多次写入，每条都照单条编辑的规矩办
// （S.applyStatusChange 写历史并顶戳、节点自己的 updatedAt 也顶戳），
// 所以同步、服务端、手机页那一侧一行都不用改。
const batchBarEl = $('batchBar'), batchModalEl = $('batchModal');

function setBatchMsg(text) { $('batchMsg').textContent = text || ''; }

// 选中集合只保留"此刻看得见"的记录：搜索或筛选一变，被藏起来的自动退出选中。
// 这样计数永远与眼睛看到的一致，也不可能改到没显示出来的记录。
function pruneBatchSel() {
  if (!state.batchMode || state.batchSel.size === 0) return;
  const visible = new Set(filteredRecords().map((r) => r.id));
  for (const id of [...state.batchSel]) if (!visible.has(id)) state.batchSel.delete(id);
}

function renderBatchBar() {
  document.body.classList.toggle('batch-mode', state.batchMode);
  batchBarEl.hidden = !state.batchMode;
  $('batchBtn').classList.toggle('on', state.batchMode);
  if (!state.batchMode) return;
  const visible = filteredRecords().length;
  const n = state.batchSel.size;
  $('batchCount').textContent = `已选 ${n} 条`;
  $('batchAllBtn').textContent = `全选当前 ${visible} 条`;
  $('batchAllBtn').disabled = visible === 0;
  $('batchClearBtn').disabled = n === 0;
  $('batchApplyBtn').disabled = n === 0;
  $('batchDelBtn').disabled = n === 0;
  $('batchUndoBtn').hidden = !state.batchUndo;
  if (state.batchUndo) $('batchUndoBtn').textContent = `撤销（${state.batchUndo.snap.length} 条）`;
}

function toggleBatchMode(on = !state.batchMode) {
  state.batchMode = on;
  state.batchSel.clear();
  state.batchUndo = null;
  setBatchMsg('');
  renderAll();
}

// 批量模式下点卡片本体＝选中 / 取消。各按钮与链接照旧走自己的路。
function onCardClick(e) {
  if (!state.batchMode) return;
  if (e.target.closest('a')) return;
  if (e.target.closest('.group-pick')) return;
  const holder = e.target.closest('[data-id]');
  if (!holder) return;
  const id = holder.dataset.id;
  if (state.batchSel.has(id)) state.batchSel.delete(id); else state.batchSel.add(id);
  renderAll();
}
groupsEl.addEventListener('click', onCardClick);
boardEl.addEventListener('click', onCardClick);

$('batchBtn').addEventListener('click', () => toggleBatchMode());
$('batchExitBtn').addEventListener('click', () => toggleBatchMode(false));
$('batchClearBtn').addEventListener('click', () => { state.batchSel.clear(); setBatchMsg(''); renderAll(); });
$('batchAllBtn').addEventListener('click', () => {
  for (const r of filteredRecords()) state.batchSel.add(r.id);
  renderAll();
});
$('batchUndoBtn').addEventListener('click', () => undoBatch());
$('batchDelBtn').addEventListener('click', () => deleteBatch());
$('batchApplyBtn').addEventListener('click', () => openBatchModal());
$('bmStatus').addEventListener('change', syncBmVisibility);
$('bmShortcuts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dl]');
  if (b) $('bmLabel').value = b.dataset.dl;
});
$('bmApplyBtn').addEventListener('click', () => applyBatchModal());

function syncBmVisibility() {
  const st = $('bmStatus').value;
  $('bmStageWrap').hidden = st !== S.STATUS.INTERVIEW;
  $('bmResultWrap').hidden = st !== S.STATUS.ENDED;
}

function openBatchModal() {
  const n = state.batchSel.size;
  if (!n) return;
  $('bmDesc').textContent = `将应用到选中的 ${n} 条记录；留空的项一律不动。`;
  $('bmStatus').value = '';
  $('bmStage').value = '未定';
  $('bmResult').value = S.RESULTS[0];
  $('bmLabel').value = '';
  $('bmDatetime').value = '';
  $('bmNote').value = '';
  $('bmApplyBtn').textContent = `应用到 ${n} 条`;
  bmTip('');
  syncBmVisibility();
  batchModalEl.hidden = false;
}

function bmTip(text) {
  const el = $('bmTip');
  el.textContent = text || '';
  el.hidden = !text;
  return false;
}

async function applyBatchModal() {
  if (batchModalEl.hidden) return;
  const status = $('bmStatus').value;
  const label = $('bmLabel').value.trim();
  const datetime = S.localInputToIso($('bmDatetime').value);
  const note = $('bmNote').value.trim();
  if (label && !datetime) return bmTip('填了节点名，却没有填节点时间。');
  if (!label && datetime) return bmTip('填了节点时间，却没有填节点名（如「笔试截止」）。');
  if (!status && !label && !note) return bmTip('什么都没选：请至少改一项（状态 / 截止节点 / 变更说明）。');
  batchModalEl.hidden = true;
  const n = await applyBatch({
    status, label, datetime, note,
    stage: $('bmStage').value,     // 只在状态 = 面试中时用得上
    result: $('bmResult').value,   // 只在状态 = 已结束时用得上
  });
  setBatchMsg(n ? `已更新 ${n} 条` : '没有记录被改动');
}

// 改动前的快照：撤销时按它还原。深拷贝，撤销期间页面上的对象不会再动到这份。
// 刻意不含 history：状态历史是两条设备**并集**合并的（mergeHistoryState），
// 回滚本地那份既留不住（对端那条会再并回来），又会让时间线跟当前状态对不上。
function snapshotRecord(rec) {
  return {
    id: rec.id,
    status: rec.status, stage: rec.stage ?? null, result: rec.result ?? null,
    deadlines: JSON.parse(JSON.stringify(rec.deadlines || [])),
    deadlineTombstones: JSON.parse(JSON.stringify(rec.deadlineTombstones || [])),
    updatedAt: rec.updatedAt,
  };
}

// 同名节点覆盖，而不是再追加一条：批量设「笔试截止 10-08」时，若某条上周已有同名节点，
// 追加会变成两条同名节点、过期那条还会一直提醒 —— 那是缺陷不是特性。
// 用户改完时间就该重新提醒一次，所以簿记字段一并清空（与单条编辑改时间同一条规则）。
function upsertDeadline(rec, label, datetime) {
  if (!Array.isArray(rec.deadlines)) rec.deadlines = [];
  const hit = rec.deadlines.find((d) => (d?.label || '') === label);
  const stamp = S.nextStamp(hit?.updatedAt || rec.updatedAt);
  if (hit) {
    hit.datetime = datetime;
    hit.done = false;
    hit.updatedAt = stamp;
    hit.notified24hFor = null;
    hit.notifiedOverdueFor = null;
  } else {
    rec.deadlines.push({
      id: S.uid(), label, datetime, done: false, updatedAt: stamp,
      notified24hFor: null, notifiedOverdueFor: null,
    });
  }
  rec.updatedAt = S.nextStamp(rec.updatedAt);
}

async function applyBatch(patch) {
  let data;
  try { data = await S.loadData(); } catch (err) { alert('读取数据失败：' + err?.message); return 0; }
  const snap = [];
  for (const id of [...state.batchSel]) {
    const rec = data.records.find((r) => r.id === id);
    if (!rec) continue;
    snap.push(snapshotRecord(rec));
    if (!Array.isArray(rec.history)) rec.history = [];
    // 状态没变又没填说明＝这条不用写历史（与单条编辑一致：不为"没改什么"留痕）
    if (patch.status && (patch.status !== rec.status || patch.note)) {
      S.applyStatusChange(rec, patch.status, patch.note || '批量设置');
    }
    if (patch.status) {  // 轮次/结果的清理规则与编辑面板一致：非面试清轮次、非结束清结果
      rec.stage = patch.status === S.STATUS.INTERVIEW ? (patch.stage || null) : null;
      rec.result = patch.status === S.STATUS.ENDED ? (patch.result || null) : null;
    }
    if (patch.label && patch.datetime) upsertDeadline(rec, patch.label, patch.datetime);
  }
  if (!snap.length) return 0;
  try { await S.saveData(data); } catch (err) { alert('保存失败：' + err?.message); return 0; }
  state.data = data;
  state.batchUndo = { snap };
  renderAll();
  return snap.length;
}

async function undoBatch() {
  const undo = state.batchUndo;
  if (!undo) return;
  state.batchUndo = null;
  let data;
  try { data = await S.loadData(); } catch (err) { alert('读取数据失败：' + err?.message); return; }
  let n = 0;
  for (const s of undo.snap) {
    const rec = data.records.find((r) => r.id === s.id);
    if (!rec) continue;
    // 顶戳的基准取"这条记录上所有节点里最新的那格"：还原后的节点一定要比批量那一版新。
    // 节点级 LWW 比的是**节点自己的 updatedAt**（deadlineTime），只顶记录时间戳救不了它：
    // 对端手里"批量改过"的那一版节点更新，下次同步会把撤销原样盖回来。
    let base = rec.updatedAt;
    for (const d of rec.deadlines || []) {
      if ((Date.parse(d?.updatedAt) || 0) > (Date.parse(base) || 0)) base = d.updatedAt;
    }
    for (const d of s.deadlines) d.updatedAt = S.nextStamp(base);
    // 被撤销掉的新增节点要写墓碑：否则对端手里那条还活着，下次同步会把它并集回来
    const back = new Set();
    for (const d of s.deadlines) for (const a of S.deadlineAliases(d)) back.add(a);
    const tombs = (s.deadlineTombstones || []).slice();
    for (const d of rec.deadlines || []) {
      if ([...S.deadlineAliases(d)].some((a) => back.has(a))) continue;
      tombs.push({ key: S.deadlineKey(d), at: S.nextStamp(d?.updatedAt || rec.updatedAt) });
    }
    // 状态变回去时留一条明账：状态历史在两端是按**并集**合并的（union），
    // 悄悄把批量那条抹掉也抹不干净，不如留一条"撤销批量设置"让时间线自洽。
    if (rec.status !== s.status) S.applyStatusChange(rec, s.status, '撤销批量设置');
    rec.status = s.status; rec.stage = s.stage; rec.result = s.result;
    rec.deadlines = s.deadlines;
    rec.deadlineTombstones = tombs.filter((t) => t?.key && !back.has(t.key));
    // 记录本身也要顶戳：否则服务端那份（批量改过、updatedAt 更新）会在下次同步把整条盖回去
    rec.updatedAt = S.nextStamp(rec.updatedAt);
    n++;
  }
  if (!n) { renderAll(); return; }
  try { await S.saveData(data); } catch (err) { alert('撤销失败：' + err?.message); return; }
  state.data = data;
  renderAll();
  setBatchMsg(`已撤销 ${n} 条`);
}

// 删除不做撤销（墓碑只增不删，真撤销要动墓碑，风险大于收益），用二次确认兜住
// ---------- 企业类型：筛选取值 / 编辑面板 / 批量识别 ----------
// 两套取值集合，别混（理由写在 company-type.js 那两个函数的注释里）：
//   · 编辑弹窗里**能选什么** = 枚举 ∪ 本机自定义清单（CT.typeChoices）—— 刻意不扫记录，
//     否则删掉一个自定义取值后它还在下拉里，用户看到的与"已删掉"这句话对不上
//   · 工具栏**能筛什么** = 上面那份 ∪ 记录里出现过的值（CT.typeValues）—— 别的设备填的写法也得筛得到
// 两份实现都在 company-type.js（扩展小窗口用的是同一份，抄两遍迟早会漂），这里只把 state.data 递进去
function typeChoices(field) {
  return CT.typeChoices(field, state.data);
}
function typeValues(field) {
  return CT.typeValues(field, state.data);
}

// 工具栏的类型筛选下拉。选项**动态重建**（要能收下自定义值），但只在取值集合真的变了才动 DOM ——
// 每次 renderAll 都重写一遍会把正开着的下拉关掉
function renderTypeFilter() {
  const sel = $('typeFilter');
  if (!sel) return;
  const natures = typeValues('nature'), industries = typeValues('industry');
  const sig = JSON.stringify([natures, industries]);
  if (sel.dataset.sig !== sig) {
    sel.textContent = '';
    sel.add(new Option('全部企业类型', ''));
    sel.add(new Option('（未填）', 'none'));
    const gNature = document.createElement('optgroup');
    gNature.label = '企业性质';
    for (const v of natures) gNature.appendChild(new Option(v, 'n:' + v));
    const gIndustry = document.createElement('optgroup');
    gIndustry.label = '行业赛道';
    for (const v of industries) gIndustry.appendChild(new Option(v, 'i:' + v));
    sel.append(gNature, gIndustry);
    sel.dataset.sig = sig;
  }
  // 选中的值可能已经不在了（自定义值被改掉、那条记录被删）：退回「全部」——
  // 否则下拉显示着「全部」、列表却一直是空的，用户只能靠刷新自救
  if (state.typeFilter && ![...sel.options].some((o) => o.value === state.typeFilter)) state.typeFilter = '';
  sel.value = state.typeFilter;
  sel.classList.toggle('on', Boolean(state.typeFilter));
}

// 编辑面板的两个下拉：首项「（未填）」，末项「＋ 自定义…」——选中它就在下面展开一个输入框。
// 不用 prompt()：它在无头测试里会把整页卡死，而且深色面板里弹一个系统框也很出戏
// （那个哨兵值 CT.CUSTOM_OPT 与展开逻辑两处共用，小窗口同款）
// 「删掉某一项」的 🗑 由 pickers.js 画在下拉面板里每一项的右边（原生 select 塞不进按钮）
function fillTypeEditors(rec) {
  for (const [field, selId, inputId] of [['nature', 'efNature', 'efNatureCustom'],
    ['industry', 'efIndustry', 'efIndustryCustom']]) {
    const sel = $(selId), input = $(inputId);
    sel.textContent = '';
    sel.add(new Option('（未填）', ''));
    const list = typeChoices(field);
    for (const v of list) sel.add(new Option(v, v));
    // 这条记录自己的旧值：清单里已经没有它了（那个自定义取值被删过）也必须能显示、能选回来，
    // 否则一打开这条记录就被静默改成「（未填）」，保存一下值就没了
    const cur = String(rec[field] || '').trim();
    if (cur && !list.includes(cur)) sel.add(new Option(`${cur}（旧值）`, cur));
    sel.add(new Option('＋ 自定义…', CT.CUSTOM_OPT));
    sel.value = cur;
    input.value = '';
    input.hidden = true;
  }
}

// 「这次打开的编辑弹窗里，用户动过哪一栏」。开弹窗时清零 —— 两栏里带着的记录旧值
// （可能是本地企业库填错的）不算"用户动过"，否则「AI 再认一次」永远改不动它
const efTypeDirty = { nature: false, industry: false };

// 把一栏设成 AI 给的答案。值一定是候选集内的（枚举 ∪ 本机自定义值，ai.js 已按它校验过），
// 万一不在下拉里就走「＋ 自定义…」那条输入框，别把它丢了
function setTypeEditor(field, value) {
  const selId = field === 'nature' ? 'efNature' : 'efIndustry';
  const inputId = field === 'nature' ? 'efNatureCustom' : 'efIndustryCustom';
  const sel = $(selId), input = $(inputId);
  if (!value) return false;
  if ([...sel.options].some((o) => o.value === value)) {
    sel.value = value;
    input.hidden = true;
    input.value = '';
    input.classList.remove('ai-filled');
  } else {
    sel.value = CT.CUSTOM_OPT;
    input.hidden = false;
    input.value = value;
    input.classList.add('ai-filled');
  }
  sel.classList.add('ai-filled');
  return true;
}

function efTypeHint(html) {
  const el = $('efTypeHint');
  if (!el) return;
  el.innerHTML = html;   // 只由本文件拼，值一律过 S.escapeHtml
  el.hidden = false;
}

// 「再认一次」失败时说清是哪一种：文案与「模型的原话」都住在 ai.js（与 popup 共用同一份 ——
// 从前两个面板各写一份，小面板那份停在把四种原因糊在一起的旧话上，改一处漏一处）。
const TYPE_AI_FAIL_TEXT = AI.AI_FAIL_TEXT;
const saidText = AI.saidText;

/**
 * 「识别能不能跑」只有一处判断（model.js 的 resolveChannel）：配了本机模型就走它，
 * 否则要有服务端地址 + 注册口令。三个地方问的是同一件事（设置面板 / 批量识别 / 编辑弹窗），
 * 所以说法也共用这一份 —— 从前各写一份，改一处漏一处。
 * @returns {Promise<{ok:boolean, why:string, ch:object|null}>} ok=false 时 why 是给用户看的原因
 */
async function aiChannel() {
  const cfg = await AI.loadAiCfg();
  if (!cfg.enabled) return { ok: false, why: '「AI 兜底识别」是关着的（设置 → 🤖 识别模型）', ch: null };
  const ch = await MODELS.resolveChannel();
  if (ch.mode === 'none') {
    return {
      ok: false,
      why: '还没有配识别用的模型（设置 → 🤖 识别模型：可以填你自己的模型，或填服务端地址 + 注册口令）',
      ch,
    };
  }
  return { ok: true, why: '', ch };
}

// 编辑弹窗里的「🤖 AI 再认一次」：这家公司的类型本地认错了，重新问一次模型。
// 与批量识别那条路的区别（也是它存在的理由）：批量只填空，这里**覆盖本地层填的值** ——
// 用户按这个按钮的意图就是"屏幕上这个不对，重判"。但用户在这次弹窗里自己动过的那栏仍然不动。
async function reclassifyForEdit() {
  const name = efCompany.value.trim();
  if (!name) { efTypeHint('先把公司名填上，AI 才有判据。'); return; }
  const shown = $('efTypeHint');
  const g = await aiChannel();
  if (!g.ok) { efTypeHint(`AI 识别没启用：${g.why}。这一栏可以自己选，或选「＋ 自定义…」写。`); return; }

  const btn = $('efTypeAiBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '识别中…';
  efTypeHint('正在问模型…');
  let r = null;
  try {
    // force：用户要的是"重判"，命中本机缓存等于按钮点了没反应
    r = await AI.classifyCompanies([name], g.ch.sync, { force: true });
  } catch { r = null; }
  btn.disabled = false;
  btn.textContent = label;
  const hit = r?.results?.[0];
  // 模型答了、但没被采用的那些话：这家在 results 里可能整条都没有，于是单独从 rejected 里找
  const rej = (r?.rejected || []).find((x) => AI.typeKey(x.name) === AI.typeKey(name));
  if (!hit) {
    // 一句原因（按服务端给的 code）+ 模型的原话（如果有）。四种失败从前共用一句"没拿到结果"，
    // 用户分不清是自己没配、额度用完了、还是模型答了没对上 —— 这是他按的按钮，必须说清
    const why = AI.failText(r?.fail) || TYPE_AI_FAIL_TEXT.AI_EMPTY;
    const said = saidText(rej?.said);
    // 模型答了、只是写法不在候选清单里：这时候再念一遍"没给出可用的答案"是自相矛盾的
    // （用户明明看到它答了），直接说它答的是什么、为什么没用上、怎么才能用上
    efTypeHint(said
      ? `AI 识别：模型答的是${said}，不在候选清单里，所以没采用。`
        + '模型只从候选清单里挑写法 —— 想用这个写法，选「＋ 自定义…」把它加进清单再点一次；也可以自己选一个。'
      : `AI 识别：${why}。可以自己选一个，或选「＋ 自定义…」写一个。`);
    if (shown) shown.hidden = false;
    return;
  }
  const done = [], kept = [], same = [], blank = [], off = [];
  for (const f of ['nature', 'industry']) {
    // 字段名走 S.TYPE_FIELDS 那一份（与导入预览、CSV 表头同一处），别再手抄一遍
    const label = S.TYPE_FIELDS[f];
    if (efTypeDirty[f]) { if (hit[f]) kept.push(label); continue; }
    const cur = readTypeEditor(f === 'nature' ? 'efNature' : 'efIndustry',
      f === 'nature' ? 'efNatureCustom' : 'efIndustryCustom').value;
    if (!hit[f]) {
      const raw = hit.said?.[f];
      if (raw) off.push(`${label} 模型答的是「${S.escapeHtml(raw)}」，不在候选清单里，没采用`);
      else blank.push(label);
      continue;
    }
    if (hit[f] === cur) same.push(`${label} 模型也判成「${S.escapeHtml(hit[f])}」（与你已有的一致）`);
    else if (setTypeEditor(f, hit[f])) done.push(label);
  }
  const parts = [...done.length ? [`${done.join('、')} 已按 AI 重填（会随保存一起写入）`] : [],
    ...same, ...off,
    // 模型说的写法用不上时，给出能走通的那一步（把那个词加成自定义取值，它才进候选清单）
    ...off.length ? ['想用模型说的那个写法，选「＋ 自定义…」把它加进清单，再点一次'] : [],
    ...blank.length ? [`${blank.join('、')} 模型这次没给（它只看得到公司名，判不出就留空）`] : [],
    ...kept.length ? [`${kept.join('、')} 是你自己选的，没动`] : []];
  efTypeHint('AI 识别：' + (parts.length ? parts.join('；') : '模型这次的结论与当前一致'));
  if (shown) shown.hidden = false;
}

function syncTypeCustom(selId, inputId) {
  const sel = $(selId), input = $(inputId);
  const custom = sel.value === CT.CUSTOM_OPT;
  input.hidden = !custom;
  if (custom) { input.value = ''; input.focus(); }
}

// 下拉面板里那一项右边的 🗑（pickers.js 调过来）：只删**我自己加进清单的写法**，
// 内置的 7+14 项是分类体系、与服务端识别共用，删不动（见 company-type.js 的 forgetCustomType）。
// 删的只是清单项 —— 任何记录里的值都不动，想加回来再选一次「＋ 自定义…」就行。
// 「选中的正是它 → 把这一栏清空」那一步由 pickers.js 做（它才知道按下去之前选的是哪个）。
async function deleteCustomType(field, v) {
  const r = CT.forgetCustomType(state.data, field, v);
  // 走到这里多半是两个标签页抢着删：🗑 只在"清单里有这个值"时才画得出来
  if (!r.removed) { efTypeHint(`「${S.escapeHtml(v)}」不在你的清单里（内置分类删不掉，也可能已经删过了）。`); return; }
  await S.saveData(state.data);
  const rec = state.editId ? findRecord(state.editId) : null;
  if (rec) fillTypeEditors(rec);   // 重铺选项：删掉的那项从下拉里消失（这条记录自己的旧值仍留着一条）
  efTypeHint(`已把「${S.escapeHtml(v)}」从你的清单里删掉，下拉里不再有它（模型也不会再答它）。`
    + (r.stillUsed ? `还有 ${r.stillUsed} 条记录在用这个写法 —— 记录里的值一个都没动，需要的话挨条改。` : ''));
}

// 读一栏的最终值。选了「＋ 自定义…」却什么都没填 → 报错回去（不能当成"清空"：
// 用户点那个选项的意图是"我要写一个自己的值"，静默存成空会让他以为写进去了）
function readTypeEditor(selId, inputId) {
  const sel = $(selId);
  if (sel.value !== CT.CUSTOM_OPT) return { value: sel.value, bad: false };
  const v = $(inputId).value.trim().slice(0, CT.CUSTOM_MAX_LEN);   // 上限与候选集清洗同一口径
  return { value: v, bad: !v };
}

// —— 批量识别（主面板「🏷 识别企业类型」）——
// 只填空：已经有值的字段一律不碰（用户手填的最高优先，这一点由 apply 那一步二次确认）。
// 三步走，任何一步失败都不影响已经拿到的结果：① 本地库 + 规则（瞬时、离线、不花钱）
// ② 剩下的公司去重后分批问模型（≤12 家/批，与 server/src/core.js 的上限一致）
// ③ 用户点「应用」才落盘：一次 saveData + 一次 renderAll
const typeModalEl = $('typeModal');
let typeUndo = null;   // 上一次「应用」的快照（一次性撤销用）；放在模块级，关掉弹窗再打开也还能撤

function tmTip(text) {
  const el = $('tmTip');
  el.textContent = text || '';
  el.hidden = !text;
}

function tmProgress(html) {
  const el = $('tmProgress');
  if (html) { el.innerHTML = html; el.hidden = false; } else { el.innerHTML = ''; el.hidden = true; }
}

const SRC_LABEL = { lib: '本地企业库', rule: '名称规则', ai: '模型', cache: '模型（缓存）' };
const SRC_CLASS = { lib: 'src-lib', rule: 'src-rule', ai: 'src-ai', cache: 'src-ai' };

// 这一行会不会真的写进去（有一格是新的、且原值是空的）
function typeRowWrites(r) {
  return Boolean((r.nature && !r.was.nature) || (r.industry && !r.was.industry));
}

function renderTypePreview() {
  const run = state.typeRun;
  if (!run) return;
  const rows = run.rows;
  const writes = rows.filter(typeRowWrites);
  $('tmPreviewWrap').hidden = rows.length === 0;
  $('tmApplyBtn').disabled = writes.length === 0;
  $('tmApplyBtn').textContent = writes.length ? `应用（写入 ${writes.length} 条）` : '应用';
  if (!rows.length) { $('tmPreview').innerHTML = ''; return; }

  const shown = rows.slice(0, 200);
  // 模型说过话、但写法没对上候选集的那几行：来源格上加个说明，让"未识别"不至于看不出原因
  const saidRows = rows.filter((r) => !r.src && (r.said?.nature || r.said?.industry));
  $('tmPreview').innerHTML = '<table class="preview-table"><thead><tr>'
    + '<th>公司</th><th>企业性质</th><th>行业赛道</th><th>来源</th></tr></thead><tbody>'
    + shown.map((r) => {
      const cell = (v) => (v ? S.escapeHtml(v) : '<span class="t3">—</span>');
      const src = SRC_LABEL[r.src] || '未识别';
      const said = saidText(r.said);
      return `<tr${typeRowWrites(r) ? '' : ' class="dim"'}>`
        + `<td title="${S.escapeHtml(r.company)}">${S.escapeHtml(cut(r.company, 22))}</td>`
        + `<td>${cell(r.nature)}</td><td>${cell(r.industry)}</td>`
        + `<td class="src-cell ${SRC_CLASS[r.src] || 'src-none'}"`
        + `${said ? ` title="模型给的是${said}，不在候选清单里，所以没采用"` : ''}>${src}</td></tr>`;
    }).join('') + '</tbody></table>'
    + (rows.length > shown.length ? `<div class="report-sub">…… 还有 ${rows.length - shown.length} 条</div>` : '')
    + (saidRows.length ? `<div class="report-sub">另有 ${saidRows.length} 家，模型给了不在候选清单里的写法（把鼠标停在「未识别」上看原话）</div>` : '');
}

// 从记录里挑出「还缺类型」的那些，起一份可以反复改的草稿（was 记住原值，用来判断"要不要写"）
function typeDraft(retryOnly) {
  if (retryOnly && state.typeRun) return state.typeRun.rows.map((r) => ({ ...r, was: { ...r.was } }));
  return (state.data?.records || [])
    .filter((r) => !r.nature || !r.industry)
    .map((r) => ({
      id: r.id, company: String(r.company || '').trim(), src: '',
      nature: r.nature || '', industry: r.industry || '',
      was: { nature: r.nature || '', industry: r.industry || '' },
    }));
}

async function runTypeClassify({ retryOnly = false } = {}) {
  const rows = typeDraft(retryOnly);
  state.typeRun = { rows };
  $('tmRetryBtn').hidden = true;
  $('tmUndoBtn').hidden = !typeUndo;
  tmTip('');

  // 认不出来的先放下：没有公司名就没有任何判据（缩写、代号都救不了）
  const pending = () => rows.filter((r) => r.company && (!r.nature || !r.industry));
  const noName = rows.filter((r) => !r.company).length;

  // ① 本地：映射库 → 关键词规则。能定的当场定，这一轮不花一分钱
  for (const r of pending()) {
    const g = CT.guessCompanyType(r.company);
    if (!r.nature && g.nature) { r.nature = g.nature; r.src = g.src; }
    if (!r.industry && g.industry) { r.industry = g.industry; r.src = g.src; }
  }
  renderTypePreview();

  // ② 模型：剩下的公司去重后分批问（classifyCompanies 内部还会先查本机缓存）
  const rest = pending();
  const localDone = rows.filter(typeRowWrites).length;
  let aiDone = 0, aiFailed = 0, aiReady = false;
  if (rest.length) {
    const g = await aiChannel();
    const why = g.why;
    if (why) {
      tmProgress(`本机认出了 <b>${localDone}</b> 条，还有 <b>${rest.length}</b> 条要问模型 —— 但${why}。认不出的会留空，随时可以自己填。`);
    } else {
      aiReady = true;
      const names = [...new Set(rest.map((r) => r.company))];
      tmProgress(`本机认出了 <b>${localDone}</b> 条，正在问模型：<b>0</b>/${names.length} 家公司…`);
      const res = await AI.classifyCompanies(names, g.ch.sync, {
        onProgress: ({ done, total, from }) => {
          if (from === 'start' || from === 'ai') {
            tmProgress(`本机认出了 <b>${localDone}</b> 条，正在问模型：<b>${done}</b>/${total} 家公司…`);
          }
        },
      });
      const byKey = new Map();
      for (const it of res.results) byKey.set(AI.typeKey(it.name), it);
      const rejByKey = new Map((res.rejected || []).map((x) => [AI.typeKey(x.name), x]));
      for (const r of rest) {
        const key = AI.typeKey(r.company);
        const hit = byKey.get(key);
        if (!hit) {
          // 模型答了、但写法没对上候选集：把它的原话记在行上，预览表里说明（否则只显示"未识别"）
          const rej = rejByKey.get(key);
          if (rej) r.said = { ...(r.said || {}), ...rej.said };
          continue;
        }
        // 二次校验（ai.js 那边已经按本次候选集卡过一遍）：候选集 = 枚举 ∪ 本机自定义值，
        // 不能再用裸枚举 —— 用户自定义的「银行」会被这里挡掉，等于白加
        if (!r.nature && CT.isAllowedType('nature', hit.nature, state.data?.customTypes)) { r.nature = hit.nature; r.src = hit.from; }
        if (!r.industry && CT.isAllowedType('industry', hit.industry, state.data?.customTypes)) { r.industry = hit.industry; r.src = hit.from; }
        // 没被采用的那一栏的原话（说清"AI 答了什么、为什么没用上"）
        if (hit.said) r.said = { ...(r.said || {}), ...hit.said };
      }
      aiDone = rows.filter((r) => r.src === 'ai' || r.src === 'cache').length;
      aiFailed = rest.filter((r) => !r.src).length;
      tmProgress('');
    }
  } else {
    tmProgress(`本机就能认全：<b>${localDone}</b> 条都认出来了，没有需要问模型的。`);
  }

  renderTypePreview();
  const left = rows.filter((r) => !r.nature || !r.industry).length;
  // 「重试」只在"还有没认出来的、而且模型这条路当时是通的"时才给 ——
  // 没配模型时重试一百次也还是同样的空，那不该是个按钮
  $('tmRetryBtn').hidden = !(aiReady && left > 0);
  const parts = [`共 ${state.data.records.length} 条记录，其中 <b>${rows.length}</b> 条还缺企业类型（已经填过的一律不动）`];
  if (localDone) parts.push(`本地认了 <b>${localDone}</b> 条`);
  if (aiDone) parts.push(`模型补了 <b>${aiDone}</b> 条`);
  if (left) parts.push(`还有 <b>${left}</b> 条没认出来${noName ? `（其中 ${noName} 条没填公司名）` : ''}，可以自己填`);
  if (aiFailed) parts.push(`模型这轮没答上 <b>${aiFailed}</b> 条，可点「重试」`);
  $('tmDesc').innerHTML = parts.join(' · ') + '。';
  if (!$('tmApplyBtn').disabled) tmTip('点「应用」才会写入 —— 写进去的是上面这张表里新填的那些格。');
}

async function openTypeModal() {
  typeModalEl.hidden = false;
  $('tmApplyBtn').disabled = true;
  $('tmRetryBtn').hidden = true;
  $('tmUndoBtn').hidden = !typeUndo;
  $('tmPreviewWrap').hidden = true;
  $('tmPreview').innerHTML = '';
  tmProgress('');
  tmTip('');
  state.typeRun = null;
  await runTypeClassify();
}

async function applyTypeClassify() {
  const run = state.typeRun;
  if (!run) return;
  const want = new Map(run.rows.map((r) => [r.id, r]));
  let data;
  try { data = await S.loadData(); } catch (err) { alert('读取数据失败：' + err?.message); return; }
  const snap = [];
  for (const rec of data.records) {
    const row = want.get(rec.id);
    if (!row) continue;
    // 落盘前再查一遍"这一格还是空的吗"：面板打开期间用户可能已经手动填过了，
    // 而手动填的永远优先于识别结果
    const nature = rec.nature || row.nature || '';
    const industry = rec.industry || row.industry || '';
    if (nature === (rec.nature || '') && industry === (rec.industry || '')) continue;
    snap.push({ id: rec.id, nature: rec.nature || '', industry: rec.industry || '' });
    rec.nature = nature;
    rec.industry = industry;
    rec.updatedAt = S.nextStamp(rec.updatedAt);   // 顶戳：不顶的话这台机器的新值推不上去
  }
  if (!snap.length) { tmTip('没有要写入的改动。'); return; }
  try { await S.saveData(data); } catch (err) { alert(saveFailMessage(err)); return; }
  state.data = data;
  typeUndo = { snap };
  $('tmUndoBtn').hidden = false;
  $('tmApplyBtn').disabled = true;
  $('tmApplyBtn').textContent = '应用';
  // 表里那几格已经落盘了，草稿跟着挪一格，免得"再点一次应用"又写一遍
  for (const row of run.rows) {
    const hit = snap.find((s) => s.id === row.id);
    if (hit) row.was = { nature: row.nature, industry: row.industry };
  }
  renderTypePreview();
  tmTip(`已写入 ${snap.length} 条。可以点「撤销本次识别」一次性回滚。`);
  renderAll();
}

async function undoTypeClassify() {
  const undo = typeUndo;
  if (!undo) return;
  typeUndo = null;
  let data;
  try { data = await S.loadData(); } catch (err) { alert('读取数据失败：' + err?.message); return; }
  let n = 0;
  for (const s of undo.snap) {
    const rec = data.records.find((r) => r.id === s.id);
    if (!rec) continue;
    // 撤销也要顶戳：否则服务端那份（识别后已推上去、时间戳更新）会在下一轮把旧值又盖回来
    rec.nature = s.nature;
    rec.industry = s.industry;
    rec.updatedAt = S.nextStamp(rec.updatedAt);
    n++;
  }
  if (!n) { renderAll(); return; }
  try { await S.saveData(data); } catch (err) { alert('撤销失败：' + err?.message); return; }
  state.data = data;
  // 预览表跟着退回识别前的样子（不然界面上还写着"已写入 N 条"）
  if (state.typeRun) {
    for (const row of state.typeRun.rows) {
      const s = undo.snap.find((x) => x.id === row.id);
      if (!s) continue;
      row.nature = s.nature;
      row.industry = s.industry;
      row.src = '';
    }
    renderTypePreview();
  }
  $('tmUndoBtn').hidden = true;
  tmTip(`已撤销 ${n} 条：企业类型回到识别之前的样子。`);
  renderAll();
}

$('typeBtn').addEventListener('click', openTypeModal);
$('tmApplyBtn').addEventListener('click', applyTypeClassify);
$('tmRetryBtn').addEventListener('click', () => runTypeClassify({ retryOnly: true }));
$('tmUndoBtn').addEventListener('click', undoTypeClassify);
$('typeFilter').addEventListener('change', () => {
  state.typeFilter = $('typeFilter').value;
  renderAll();
});
for (const [field, selId, inputId] of [['nature', 'efNature', 'efNatureCustom'], ['industry', 'efIndustry', 'efIndustryCustom']]) {
  $(selId).addEventListener('change', () => {
    syncTypeCustom(selId, inputId);
    // 一改就归用户：AI 填过的高亮随之消失
    $(selId).classList.remove('ai-filled');
    $(inputId).classList.remove('ai-filled');
    efTypeDirty[field] = true;                // 并记下「这一栏是用户选的」→ 后面的 AI 重认不许动它
  });
  // 打开下拉时铺的是自建列表（原生 <select> 的选项行里塞不进 🗑）。
  // 只有**自己加进清单的写法**后面才长 🗑；点了它就删清单，选中的正是它时把这一栏清空
  attachTypeSelect($(selId), {
    isCustom: (v) => CT.isCustomType(state.data, field, v),
    onDelete: (v) => deleteCustomType(field, v),
  });
}
$('efTypeAiBtn').addEventListener('click', reclassifyForEdit);

// 三个固定的日期时间框改用自建日历（原生那份面板里没有"确定"，选完只能点别处把它收起来 ——
// 自己画的这份是"改完「分」就算选完"）。截止节点那几行是动态加的，各自在 addDeadlineRow 里挂
attachDateInput($('efAppliedAt'));
attachDateInput($('bmDatetime'));
attachDateInput($('ivAt'));

async function deleteBatch() {
  const recs = [...state.batchSel].map(findRecord).filter(Boolean);
  if (!recs.length) return;
  const names = recs.slice(0, 3).map((r) => `「${r.company || '未填公司'} · ${r.position || '未填岗位'}」`).join('、');
  const more = recs.length > 3 ? ` 等 ${recs.length} 条记录` : '';
  if (!confirm(`删除 ${names}${more}？删除后无法恢复，其他设备上也会一起消失。`)) return;
  let data;
  try { data = await S.loadData(); } catch (err) { alert('读取数据失败：' + err?.message); return; }
  for (const r of recs) SY.tombstone(data, r.id);
  try { await S.saveData(data); } catch (err) { alert('保存失败：' + err?.message); return; }
  state.data = data;
  state.batchSel.clear();
  state.batchUndo = null;
  renderAll();
  setBatchMsg(`已删除 ${recs.length} 条`);
}


// ---------- 导入 / 导出 ----------
// 文件名里的时间戳：实现搬到了 shared.js（手机端导出日历文件时要用同一份）
const stamp = S.fileStamp;

// 导出带上 meta（版本 / 时间 / 设备），导入时能告诉用户"这份备份来自哪台机器"
async function exportJson() {
  // 备份要从存储取最新的一份（后台云同步可能刚写过，页面里的 state 未必是最新的）
  let data = state.data;
  try { data = await S.loadData(); } catch { /* 读不到就退回页面里的数据 */ }
  const payload = T.exportPayload(data, { device: SY.deviceName() });
  S.download(`投递备份-${stamp()}.json`, JSON.stringify(payload, null, 2));
}

function exportCsv() {
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // 内容由 transfer.js 的 buildCsv 生成（纯函数、有单测）：表头与「导入表格」的别名表对得上，
  // 而且日期带年份 —— 导出的 CSV 必须能原样导回来。
  S.download(
    `投递记录-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}.csv`,
    T.buildCsv(state.data.records),
    'text/csv;charset=utf-8',
  );
}

$('exportJsonBtn').addEventListener('click', exportJson);
$('exportCsvBtn').addEventListener('click', exportCsv);
$('importJsonBtn').addEventListener('click', () => $('importJsonFile').click());

// 导入是**合并**而不是覆盖：同岗位按更新时间合并进度、节点与历史取并集。
// 合并规则全部在 transfer.js（纯函数，有单测）。
let undoImport = null;   // 本次导入前的本机数据，用于「撤销本次导入」

function reportNum(n, cls, text) {
  return n ? `<div><span class="rep-num ${cls}">${n}</span>${text}</div>` : '';
}

// extra：表格导入这类入口要额外说明的内容（可省略，JSON 那条路不传）
function renderImportReport(incoming, stats, extra = '') {
  const isTable = incoming.app === TABLE_IMPORT_APP;
  const src = [
    incoming.app || '',
    incoming.version ? 'v' + incoming.version : '',
    incoming.exportedAt ? S.fmtDateTime(incoming.exportedAt) + ' 导出' : '',
    incoming.device || '',
  ].filter(Boolean).join(' · ');
  const changed = stats.added + stats.updated + stats.restored + stats.dedupLocal;
  const body = [
    src ? `<div class="report-src">${isTable ? '表格来源' : '备份来源'}：${S.escapeHtml(src)}</div>` : '',
    reportNum(stats.added, 'rep-add', '条 新增'),
    reportNum(stats.updated, 'rep-merge', isTable ? '条 已按表格更新' : '条 合并更新（同岗位取较新进度）'),
    reportNum(stats.restored, 'rep-add', '条 恢复（本机曾删除）'),
    reportNum(stats.dedupLocal, 'rep-merge', '条 本机重复岗位已归并'),
    reportNum(stats.unchanged, 'rep-none', isTable ? '条 无变化（表里和本机一样）' : '条 无变化（两边一致）'),
    reportNum(stats.skipped, 'rep-skip', '条 跳过（无效记录）'),
    !changed && !stats.unchanged ? '<div class="report-src">这份内容里没有可导入的记录。</div>' : '',
    extra,
    isTable
      ? `<div class="report-sub">已按「以表格为准」处理：表里写了的值覆盖本机，表里空着的保留本机原值（备注、JD 不会被抹掉），本机没有的岗位变成新记录。整份导入可以用下面的按钮一键撤销。</div>`
      : `<div class="report-sub">已按「合并」处理：同一岗位（同链接 + 同岗位名）不会变成两条，进度以更新时间较新的一侧为准，截止节点与状态历史两边都会保留。</div>`,
  ].join('');
  $('reportBody').innerHTML = body;
  $('undoImportBtn').hidden = !undoImport;
}

$('undoImportBtn').addEventListener('click', async () => {
  if (!undoImport) return;
  const data = JSON.parse(undoImport);
  undoImport = null;
  $('undoImportBtn').hidden = true;
  try { await S.saveData(data); } catch (err) { alert('撤销失败：' + (err?.message || err)); return; }
  state.data = data;
  renderAll();
  $('reportModal').hidden = true;
});

$('importJsonFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let incoming;
  try {
    incoming = JSON.parse(await file.text());
  } catch {
    alert('导入失败：文件不是有效的 JSON。');
    return;
  }
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.records)) {
    alert('导入失败：缺少 records 数组，请确认这是本工具导出的备份文件。');
    return;
  }
  // 从存储重新读一份（后台的云同步可能刚写过），避免用页面里的旧快照去做读-改-写
  let local;
  try { local = await S.loadData(); } catch (err) { alert('读取本机数据失败：' + (err?.message || err)); return; }
  const before = JSON.stringify(local);
  const { data, stats } = T.mergeImport(local, incoming);
  try { await S.saveData(data); } catch (err) { alert('保存失败：' + (err?.message || err)); return; }
  undoImport = before;
  state.data = data;
  renderAll();
  renderImportReport(incoming, stats);
  $('reportModal').hidden = false;
});

// ---------- 导入表格（粘贴为主，CSV / TSV 文件为辅） ----------
// 解析、列映射、合并语义全在 transfer.js（纯函数、有单测），这里只负责界面与落盘。
// 预览阶段一个字节都不写存储：取消 = 零副作用；「确认导入」走的是与 JSON 导入完全同构的那套流程。
const TABLE_IMPORT_APP = '表格导入';
const TABLE_FILE_MAX = 8 * 1024 * 1024;

let tablePending = null;   // { rows, source, encoding, fileName, now, local, mapping, columns }

function tableMsg(text) {
  const el = $('tablePasteMsg');
  el.hidden = !text;
  el.textContent = text || '';
}

function openTableImport() {
  tablePending = null;
  $('tablePasteStep').hidden = false;
  $('tablePreviewStep').hidden = true;
  $('tableBackBtn').hidden = true;
  $('tableConfirmBtn').disabled = true;
  $('tablePreviewBody').innerHTML = '';
  tableMsg('');
  $('tableImportModal').hidden = false;
  $('pasteZone').focus();
}

$('importTableBtn').addEventListener('click', openTableImport);
$('tablePickBtn').addEventListener('click', () => $('tableImportFile').click());
$('tableBackBtn').addEventListener('click', openTableImport);
$('tableImportFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) readTableFile(file);
});

// 粘贴监听绑在整个模态框上：焦点在框里任何地方按 ⌘/Ctrl+V 都算。
// 看板上另有卡片拖拽用的 dragover/drop，所以这里必须 stopPropagation 把两套隔开。
$('tableImportModal').addEventListener('paste', (e) => {
  if ($('tablePasteStep').hidden) return;   // 已经在预览这一步了，不重复吃粘贴
  e.preventDefault();
  e.stopPropagation();
  const cd = e.clipboardData;
  startTablePreview(T.readTableFromPaste({
    html: cd ? cd.getData('text/html') : '',
    text: cd ? cd.getData('text/plain') : '',
  }), '粘贴的表格');
});

const pasteZone = $('pasteZone');
pasteZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); pasteZone.classList.add('drag'); });
pasteZone.addEventListener('dragleave', () => pasteZone.classList.remove('drag'));
pasteZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  pasteZone.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (file) readTableFile(file);
});

async function readTableFile(file) {
  if (file.size > TABLE_FILE_MAX) {
    tableMsg(`这个文件有 ${(file.size / 1048576).toFixed(1)} MB，超过 8 MB 了。请先在表格软件里拆开，或改为选中区域后直接复制粘贴。`);
    return;
  }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch (err) { tableMsg('读文件失败：' + (err?.message || err)); return; }
  startTablePreview(T.readTableFromBytes(bytes), file.name);
}

async function startTablePreview(res, fileName) {
  if (!res || !res.rows || !res.rows.length) {
    tableMsg((res && res.error) || '这份内容里没有可识别的表格。');
    return;
  }
  if (res.rows.length > T.MAX_TABLE_ROWS + 1) {
    tableMsg(`这份表格有 ${res.rows.length} 行，超过 ${T.MAX_TABLE_ROWS} 行了。请分批导入（或者先删掉用不上的行）。`);
    return;
  }
  tableMsg('');
  // 预览要跟本机现有记录比一比（算得出有多少条是覆盖）：读不到就按「全是新增」预览，
  // 确认导入时会重新读一次，以那一刻的数据为准。
  let local = { version: S.SCHEMA_VERSION, records: [], tombstones: [] };
  try { local = await S.loadData(); } catch { /* 用空库预览 */ }
  const mapping = T.headerMapping(res.rows);
  tablePending = { ...res, fileName, local, now: Date.now(), mapping, columns: mapping.columns.slice() };
  $('tablePasteStep').hidden = true;
  $('tablePreviewStep').hidden = false;
  $('tableBackBtn').hidden = false;
  renderTablePreview();
}

function cut(s, n = 36) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 读出下拉里当前的映射（预览与落盘都以它为准）；还没渲染过就返回 null
function readColumnSelects() {
  const sels = $('tablePreviewBody').querySelectorAll('select[data-index]');
  if (!sels.length || !tablePending) return null;
  const head = tablePending.rows[tablePending.mapping.headerRow] || [];
  const out = [];
  sels.forEach((sel) => {
    if (!sel.value) return;
    const index = Number(sel.dataset.index);
    out.push({ index, header: String(head[index] ?? ''), field: sel.value });
  });
  return out;
}

function tableWarnings(p, res, columns) {
  const warns = [];
  if (!columns.length) {
    warns.push('一个表头都没认出来。<b>请回到表格里把表头改成本工具认得的名字</b>（公司 / 岗位 / 状态 / 轮次 / 结果 / 企业类型 / 投递日期 / 最近截止 / 链接 / 备注 / JD），或者连表头一起选中再复制；也可以在下面的下拉里逐列手动指定。');
  }
  if (columns.length && !res.records.length) warns.push('没有可导入的行 —— 请确认是否只复制了表头。');
  if (res.dupRows) warns.push(`有 ${res.dupRows} 行与前面的行是同一个岗位（同公司 + 同岗位 + 同链接），会合并成一条。`);
  if (res.unknownStatus.length) {
    const words = res.unknownStatus.map((x) => `「${S.escapeHtml(x.word)}」（${x.count} 行）`).join('、');
    warns.push(`状态没认出来：${words}。这些行里，本机已有的记录保留原来的进度，新增的按「筛选中」记，原词会写进备注 —— 你可以直接在表格里把状态改成「一面 / 已结束」这类写法再导一次。`);
  }
  if (res.badDates.length) {
    const cells = res.badDates.map((x) => `<code>${S.escapeHtml(x.value)}</code>`).join('、');
    warns.push(`日期没认出来：${cells}。这些格子会留空（本机已有的记录保留原来的日期）。想带进来请把表格里的写法改成 <code>2026-03-01</code> 或 <code>2026/3/1 18:11</code> 这样。`);
  }
  if (res.badTypes?.length) {
    const cells = res.badTypes.map((x) => `<code>${S.escapeHtml(x.value)}</code>`).join('、');
    warns.push(`企业类型没认出来：${cells}。这些格子会留空（本机已有的记录保留原来的企业类型，不会被抹掉）。写法请用「央企」「汽车/新能源」这类既定取值；也可以把「企业性质」与「行业赛道」分成两列来写。`);
  }
  if (res.droppedDeadlines) warns.push(`有 ${res.droppedDeadlines} 个截止节点本机已经标记完成，表格里的同名节点不会再导进来。`);
  if (p.truncated) warns.push(`这份表格太大，只读了前 ${p.rows.length} 行（还有 ${p.truncated} 行没读）。请分批导入。`);
  return warns;
}

function renderTablePreview() {
  const p = tablePending;
  if (!p) return;
  const columns = p.columns;
  const res = T.tableToRecords(p.rows, {
    columns, headerRow: p.mapping.headerRow, localByKey: T.indexByKey(p.local), now: p.now,
  });
  const dataRows = Math.max(0, p.rows.length - p.mapping.headerRow - 1);
  const srcLine = [
    p.fileName || '粘贴的表格',
    p.source === 'html' ? '读到的是 HTML 表格（最稳的那种）' : (p.encoding ? '编码 ' + p.encoding : '纯文本'),
    p.source !== 'html' && p.delimiter ? '分隔符 ' + (p.delimiter === '\t' ? 'Tab' : p.delimiter) : '',
    `共 ${dataRows} 行数据`,
  ].filter(Boolean).join(' · ');

  const head = p.rows[p.mapping.headerRow] || [];
  const mapTable = head.length ? '<table class="map-table"><thead><tr><th style="width:46%">表里这一列</th><th>导入成</th></tr></thead><tbody>'
    + head.map((h, i) => {
      const cur = columns.find((c) => c.index === i);
      const name = String(h ?? '').trim() || `第 ${i + 1} 列`;
      const ig = p.mapping.ignored.find((x) => x.index === i);
      const hint = !ig ? '' : (ig.reason === '未识别'
        ? '<span class="t3">（未识别）</span>'
        : `<span class="t3">（${S.escapeHtml(ig.reason)}）</span>`);
      return `<tr><td title="${S.escapeHtml(name)}">${S.escapeHtml(name)}${hint}</td><td><select data-index="${i}">`
        + '<option value="">（忽略这一列）</option>'
        + Object.entries(T.FIELD_LABELS).map(([f, label]) => `<option value="${f}"${cur && cur.field === f ? ' selected' : ''}>${label}</option>`).join('')
        + '</select></td></tr>';
    }).join('') + '</tbody></table>' : '';

  const warns = tableWarnings(p, res, columns);
  const rowsPreview = res.records.slice(0, 5);
  const previewTable = rowsPreview.length ? '<table class="preview-table"><thead><tr>'
    + '<th>公司</th><th>岗位</th><th>状态</th><th>轮次 / 结果</th><th>投递日期</th><th>截止</th><th>备注 / JD</th>'
    + '</tr></thead><tbody>'
    + rowsPreview.map((r) => {
      const dl = r.deadlines[0];
      return `<tr>`
        + `<td>${S.escapeHtml(cut(r.company)) || '<span class="t3">—</span>'}</td>`
        + `<td>${S.escapeHtml(cut(r.position)) || '<span class="t3">—</span>'}</td>`
        + `<td>${S.escapeHtml(r.status) || '<span class="t3">—</span>'}</td>`
        + `<td>${S.escapeHtml([r.stage, r.result].filter(Boolean).join(' / ')) || '<span class="t3">—</span>'}</td>`
        + `<td>${r.appliedAt ? S.escapeHtml(S.fmtDateTime(r.appliedAt)) : '<span class="t3">—</span>'}</td>`
        + `<td>${dl ? S.escapeHtml(cut(`${dl.label} ${S.fmtDateTime(dl.datetime)}`, 22)) : '<span class="t3">—</span>'}</td>`
        + `<td>${S.escapeHtml(cut([r.notes, r.jd].filter(Boolean).join(' · '))) || '<span class="t3">—</span>'}</td>`
        + `</tr>`;
    }).join('') + '</tbody></table>' : '';

  $('tablePreviewBody').innerHTML = [
    `<div class="tp-src">${S.escapeHtml(srcLine)}</div>`,
    `<div class="tp-num">新增 <b class="rep-add">${res.newCount}</b> 条 · 覆盖本机 <b class="rep-merge">${res.mergeCount}</b> 条`
      + (res.skipCount ? ` · 跳过 <b class="rep-skip">${res.skipCount}</b> 行（公司、岗位、链接都空着）` : '') + '</div>',
    res.mergeCount
      ? '<div class="tp-note">本机已有的这些岗位会按<b>「以表格为准」</b>更新：表里写了的值覆盖本机，表里空着的保留本机原值。整个导入可以一键撤销。</div>'
      : '',
    warns.length ? `<div class="tp-warn">${warns.map((w) => `<div>· ${w}</div>`).join('')}</div>` : '',
    rowsPreview.length ? '<div class="tp-h">前几行长这样</div>' : '',
    previewTable,
    res.records.length > rowsPreview.length ? `<div class="tp-src">…… 后面还有 ${res.records.length - rowsPreview.length} 条</div>` : '',
    head.length ? '<div class="tp-h">列对应关系</div>' : '',
    mapTable,
  ].join('');
  $('tableConfirmBtn').disabled = !columns.length || !res.records.length;
}

$('tablePreviewBody').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-index]');
  if (!sel || !tablePending) return;
  // 一个字段只对应一列：这一列选了某个字段，之前占着它的那一列自动回到「忽略」。
  // 否则两列映射到同一项时，只有最左那列生效，用户改了右边那列却看不出为什么没反应。
  if (sel.value) {
    $('tablePreviewBody').querySelectorAll('select[data-index]').forEach((other) => {
      if (other !== sel && other.value === sel.value) other.value = '';
    });
  }
  tablePending.columns = readColumnSelects() || [];
  renderTablePreview();
});

$('tableConfirmBtn').addEventListener('click', async () => {
  const p = tablePending;
  if (!p) return;
  const btn = $('tableConfirmBtn');
  btn.disabled = true;
  try {
    // 预览可能开了一会儿了，落盘前重新读一份本机数据（后台云同步随时可能刚写过）
    let local;
    try { local = await S.loadData(); } catch (err) { alert('读取本机数据失败：' + (err?.message || err)); return; }
    const columns = readColumnSelects() || p.columns;
    const res = T.tableToRecords(p.rows, { columns, headerRow: p.mapping.headerRow, localByKey: T.indexByKey(local), now: Date.now() });
    if (!res.records.length) { alert('没有可导入的行。'); return; }
    const incoming = {
      app: TABLE_IMPORT_APP, version: S.APP_VERSION,
      device: p.fileName || '粘贴的表格', records: res.records,
    };
    const before = JSON.stringify(local);
    const { data, stats } = T.mergeImport(local, incoming);
    try { await S.saveData(data); } catch (err) { alert('保存失败：' + (err?.message || err)); return; }
    undoImport = before;
    state.data = data;
    renderAll();
    const extra = [
      res.unknownStatus.length
        ? `<div class="report-src">状态没认出来的词：${res.unknownStatus.map((x) => S.escapeHtml(x.word)).join('、')}（已写进这几条的备注）</div>`
        : '',
      res.badDates.length
        ? `<div class="report-src">日期没认出来的格子：${res.badDates.map((x) => '「' + S.escapeHtml(x.value) + '」').join('、')}（这些格子留空了）</div>`
        : '',
    ].join('');
    renderImportReport(incoming, stats, extra);
    $('tableImportModal').hidden = true;
    $('reportModal').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 手机日历（导出 .ics 文件，手机导入后由系统日历到点提醒） ----------
let calPrev = null;   // 上次导出的快照：记录每个事件发到第几版（SEQUENCE）与内容指纹

async function loadCalendarSnapshot() {
  try {
    const raw = await chrome.storage.local.get(T.CALENDAR_KEY);
    return raw[T.CALENDAR_KEY] || null;
  } catch { return null; }
}

function renderCalStatus(extra = '', kind = '') {
  const n = calPrev ? Object.keys(calPrev.items || {}).length : 0;
  $('calStatus').textContent = calPrev
    ? `上次导出：${calPrev.at ? S.fmtDateTime(calPrev.at) : '—'}，手机里应有 ${n} 个投递提醒。`
    : '还没有导出过日历文件。导出后把文件发到手机导入，就能到点收到日历提醒（电脑关机也照样提醒）。';
  const hint = $('calHint');
  hint.className = 'cal-hint' + (kind ? ' ' + kind : '');
  hint.textContent = extra;
  $('calClearBtn').disabled = !n;
  $('calClearBtn').title = n ? '' : '还没有导出过，无需清空';
}

$('exportCalBtn').addEventListener('click', async () => {
  calPrev = await loadCalendarSnapshot();
  renderCalStatus();
  $('calModal').hidden = false;
});

// 导出日历文件：只含「未完成 + 填了截止时间」的节点；上次导出过、这次不在列表里的标记为取消
$('calExportBtn').addEventListener('click', async () => {
  const items = T.calendarItems(state.data.records);
  calPrev = await loadCalendarSnapshot();
  const prevCount = calPrev ? Object.keys(calPrev.items || {}).length : 0;
  if (!items.length && !prevCount) {
    renderCalStatus('当前没有「未完成 + 填了截止时间」的节点，导出的日历会是空的。先给岗位加一个截止时间再来。', 'err');
    return;
  }
  const { items: out, snapshot, stats } = T.diffCalendar(calPrev, items);
  S.download(`投递提醒-${stamp()}.ics`, T.buildCalendarIcs(out), 'text/calendar;charset=utf-8');
  try {
    await chrome.storage.local.set({ [T.CALENDAR_KEY]: snapshot });
  } catch (e) {
    // 文件已经下载了，但没记住这一版 → 下次导出会被当成第一次，手机上可能重复
    renderCalStatus('文件已导出，但导出记录没能保存（' + (e?.message || e) + '）。下次导出会被当成第一次，可能重复，建议清理手机上的「投递管家」日历后重新导入。', 'err');
    return;
  }
  calPrev = snapshot;
  const parts = [`已导出 ${stats.events} 个提醒节点`];
  if (stats.updated) parts.push(`${stats.updated} 个是更新已有事件`);
  if (stats.cancelled) parts.push(`${stats.cancelled} 个旧事件标记为取消`);
  // 「更新已有事件 / 标记取消」这两件事各手机系统并不可靠（iOS 可能静默跳过，部分安卓会新增重复），
  // 所以提示里给一条在所有机型上都成立的做法：先删掉「投递管家」日历再导入。
  renderCalStatus(parts.join('，') + '。文件已下载，发到手机导入即可。'
    + '若手机里已有旧的「投递管家」日历，建议先把它删掉再导入这份新文件。', 'ok');
});

// 清空文件：把上次导出过的事件全部标记为取消
$('calClearBtn').addEventListener('click', async () => {
  calPrev = await loadCalendarSnapshot();
  const n = calPrev ? Object.keys(calPrev.items || {}).length : 0;
  if (!n) { renderCalStatus('没有可以清空的记录。', 'err'); return; }
  if (!confirm(`把上次导入手机的 ${n} 个投递提醒标记为「已取消」？\n\n会生成一个清空文件，导入后这些提醒消失，你自己的其他日程不受影响。\n注意：实测只有 Mac 上的「日历」认这个「取消」标记，iPhone / 安卓 / Google 日历多半不认。\n手机端最稳妥的做法仍是：在手机日历里直接删掉「投递管家」这个日历。`)) return;
  const { items: out, snapshot, stats } = T.clearCalendar(calPrev);
  S.download(`投递提醒-清空-${stamp()}.ics`, T.buildCalendarIcs(out), 'text/calendar;charset=utf-8');
  calPrev = snapshot;
  try {
    await chrome.storage.local.set({ [T.CALENDAR_KEY]: snapshot });
  } catch { /* 快照没存上不影响清空文件本身 */ }
  renderCalStatus(`已导出清空文件（含 ${stats.cancelled} 条取消标记）。Mac「日历」导入后会消失；`
    + 'iPhone / 安卓 多数不认这个标记，请在手机日历里直接删掉「投递管家」日历。', 'ok');
});

// ========== 设置：云同步 / 手机提醒 / 日历订阅 ==========
const PUSH_TIPS = {
  pushplus: '① 电脑或手机打开 pushplus.plus → ② 微信扫码登录 → ③ 复制「token」粘贴到上方输入框 → ④ 点「发送测试推送」，微信收到即成功。免费额度每天 200 条，足够使用。',
  bark: '① iPhone 在 App Store 安装 Bark → ② 打开 App 首页会看到一条 https://api.day.app/xxxxxx 地址 → ③ 整条复制粘贴到上方 → ④ 点「发送测试推送」。',
  generic: '粘贴群机器人 Webhook 地址即可：飞书（群设置 → 群机器人 → 自定义机器人）、钉钉（群设置 → 智能群助手）、企业微信（群设置 → 群机器人）。也可填写自建服务地址。',
};

function setStatus(el, text, kind = '') {
  const node = $(el);
  node.textContent = text || '';
  node.classList.remove('ok', 'err');
  if (kind) node.classList.add(kind);
}

function onPushKindChange() {
  const kind = $('stPushKind').value;
  const needTarget = kind !== 'none';
  $('stPushTargetWrap').hidden = !needTarget;
  $('stFuzzyWrap').hidden = !needTarget;
  $('stPushTip').hidden = !needTarget;
  if (needTarget) {
    $('stPushTip').textContent = PUSH_TIPS[kind] || '';
    $('stPushTargetLabel').textContent = kind === 'pushplus' ? 'PushPlus Token' : '推送地址（Webhook URL）';
    $('stPushTarget').placeholder = kind === 'pushplus' ? '在 pushplus.plus 扫码后复制 token' : 'https://…';
  }
  $('stPushBadge').textContent = kind === 'none' ? '未配置' : '已配置';
  $('stPushBadge').className = 'set-badge' + (kind === 'none' ? '' : ' on');
}

function updateIcsUrl() {
  const url = SY.icsUrl({
    endpoint: $('stEndpoint').value,
    token: $('stToken').value,
  });
  $('stIcsUrl').value = url;
  $('stCopyIcs').disabled = !url;
}

// 配对串：手机页粘贴这一串即可完成配对，不用手抄地址与口令。
// 格式由 mobile/app.js 的 parsePair 定义：投递管家|版本|服务端地址|口令|注册口令
// （最后一段「是否同步JD」在 1.12 去掉了：JD 现在必同步。旧手机页读 parts[5] 得到 undefined，
//   `undefined !== '0'` 为真，所以老版本的手机页拿到新配对串也不会出问题。）
function pairString() {
  const endpoint = SY.normalizeEndpoint($('stEndpoint').value);
  const token = $('stToken').value.trim();
  if (!endpoint || !token) return '';
  return ['投递管家', 1, endpoint, token, $('stEnrollKey').value.trim()].join('|');
}

function updatePhoneSection() {
  const pair = pairString();
  $('stPairString').value = pair;
  $('stCopyPair').disabled = !pair;
  const badge = $('stPhoneBadge');
  if (!pair) { badge.textContent = '待配置'; badge.className = 'set-badge warn'; }
  else if (!$('stEnabled').checked) { badge.textContent = '未启用云同步'; badge.className = 'set-badge warn'; }
  else { badge.textContent = '可用'; badge.className = 'set-badge on'; }
}

function renderSyncStatus() {
  const badge = $('stSyncBadge');
  const on = $('stEnabled').checked;
  const hasCfg = $('stEndpoint').value.trim() && $('stToken').value.trim();
  if (!on) { badge.textContent = '未启用'; badge.className = 'set-badge'; }
  else if (!hasCfg) { badge.textContent = '待完善'; badge.className = 'set-badge warn'; }
  else { badge.textContent = '已启用'; badge.className = 'set-badge on'; }
}

// 设置面板里「存在本机」的那几项（云同步 + 手机页地址）。面板上另外两区不在这里：
// 推送设置存服务端，日历订阅是只读的。
function readPushForm() {
  return {
    pushKind: $('stPushKind').value,
    pushTarget: $('stPushTarget').value.trim(),
    fuzzy: $('stFuzzy').checked,
  };
}

// 设置面板的**唯一落盘入口**：把本机这几项一次存完。
// 「完成」和另两条关闭路径也走它 —— 用户点完成就是"我改完了"，不该再要求点一次保存。
// 服务端地址或口令变更时必须重置游标，否则会拿旧服务器的版本号去新服务器比对。
async function persistSettingsForm() {
  const prev = await SY.loadSync();
  const endpoint = SY.normalizeEndpoint($('stEndpoint').value);
  const token = $('stToken').value.trim();
  const rawPhone = $('stPhoneUrl').value.trim();

  // 护栏：地址被清空而原先非空时保留原值。自动保存会把"手滑清空"直接变成关掉同步，
  // 而这个字段本来没有任何校验。要停用请取消勾选「启用云同步」，别靠清空地址。
  const keptEndpoint = !endpoint && Boolean(prev.endpoint);
  const patch = {
    endpoint: keptEndpoint ? prev.endpoint : endpoint,
    token,
    enrollKey: $('stEnrollKey').value.trim(),
    enabled: $('stEnabled').checked,
    phoneUrl: rawPhone ? SY.normalizeEndpoint(rawPhone) : '',
  };
  if (prev.endpoint !== patch.endpoint || prev.token !== token) { patch.lastRev = 0; patch.lastSyncAt = null; }
  const cfg = await SY.saveSync(patch);
  // 归一化后的值回填输入框，免得框里一直留着 "sync.example.com/" 这种没补 https 的样子
  $('stEndpoint').value = patch.endpoint;
  $('stPhoneUrl').value = patch.phoneUrl;
  renderSyncStatus();
  refreshSyncPill();
  updatePhoneSection();
  renderAiSection();   // 地址/口令刚刚可能被填上 —— AI 那一段的徽标与提示跟着更新
  return { cfg, keptEndpoint };
}

// 推送设置存服务端（同一口令下所有设备共用），所以这是一次网络请求。
// 关闭面板时也会调用它，失败必须显示出来，不能静默吞掉。
async function persistPushForm(cfg) {
  const c = cfg || await SY.loadSync();
  if (!c.endpoint || !c.token) throw new Error('先填好服务端地址与同步口令');
  await SY.saveSettings(c, { ...readPushForm(), tzOffset: new Date().getTimezoneOffset() });
  return readPushForm();
}

async function openSettings() {
  const cfg = await SY.loadSync();
  enabledAtOpen = !!cfg.enabled;   // 「完成」时据此判断要不要立刻全量同步（与「保存」按钮一致）
  $('stEndpoint').value = cfg.endpoint || '';
  $('stToken').value = cfg.token || '';
  // 注册口令必须始终可见：之前按"已填过才显示"来隐藏，导致新设备永远没机会填
  // （服务端一旦设了 ENROLL_KEY，第一次同步只会报错，用户却找不到输入框）
  $('stEnrollKey').value = cfg.enrollKey || '';
  $('stEnabled').checked = !!cfg.enabled;
  $('stSyncStatus').textContent = cfg.lastError ? '' : '';
  setStatus('stSyncStatus', cfg.lastError ? `上次同步失败：${cfg.lastError}` : (cfg.lastResult ? `上次同步：推送 ${syncPushText(cfg.lastResult)} · 合并 ${cfg.lastResult.added + cfg.lastResult.updated} 条` : ''), cfg.lastError ? 'err' : 'ok');
  updateIcsUrl();
  renderSyncStatus();
  $('stPhoneUrl').value = cfg.phoneUrl || '';
  setStatus('stPhoneStatus', '');
  updatePhoneSection();
  await renderAiSection();
  $('stPushKind').value = 'none';
  $('stPushTarget').value = '';
  onPushKindChange();
  pushLoaded = null;   // 还没从服务端拉回来，"当前值"不算数；拉到才记录基线（见 closeSettings）
  settingsModal.hidden = false;
  // 上次同步失败 → 高亮到**该改的那一栏**并把光标放进去，省得用户自己找。
  // 优先信服务端给的机器可读 code（旧版服务端没有 code 才退回文案匹配）。
  const bad = lastErrorField(cfg);
  $('stEnrollKey').classList.toggle('need', bad === 'stEnrollKey');
  $('stToken').classList.toggle('need', bad === 'stToken');
  if (bad) $(bad).focus();
  // 推送设置存服务端（同一口令下所有设备共享）
  if (cfg.endpoint && cfg.token) {
    try {
      const s = await SY.fetchSettings(cfg);
      $('stPushKind').value = s.pushKind || 'none';
      $('stPushTarget').value = s.pushTarget || '';
      $('stFuzzy').checked = !!s.fuzzy;
      onPushKindChange();
      pushLoaded = readPushForm();
      setStatus('stPushStatus', s.lastPushError ? `上次推送失败：${s.lastPushError}` : (s.lastPushAt ? `上次推送：${S.fmtRelative(new Date(s.lastPushAt).toISOString())} 成功` : ''), s.lastPushError ? 'err' : 'ok');
    } catch (e) {
      setStatus('stPushStatus', `读取推送设置失败：${e.message}`, 'err');
    }
  }
}

// 同步失败该去改哪一栏：优先用服务端给的机器可读 code（sync.js 存下来的 lastErrorCode），
// 只有旧版服务端（没有 code 字段）才退回按中文文案猜。返回输入框 id，'' = 不用高亮。
// 分开高亮是有意义的：注册口令与同步口令是两把不同的钥匙，指错了用户怎么改都还是失败。
function lastErrorField(cfg) {
  if (!cfg.lastError) return '';
  const code = cfg.lastErrorCode || '';
  if (code === 'ENROLL') return 'stEnrollKey';
  if (code === 'TOKEN' || code === 'DISABLED') return 'stToken';
  if (/注册口令|ENROLL_KEY/i.test(cfg.lastError)) return 'stEnrollKey';
  if (/同步口令|还没有开通|已被管理员停用/.test(cfg.lastError)) return 'stToken';
  return '';
}

// ---------- AI 兜底识别（本机开关 + 本机缓存） ----------
// 开关是**每台设备各自的**（存在 chrome.storage.local，不进云同步）：它同时决定了"要不要把页面
// 候选串发出去"，这种决定不该被另一台设备的设置覆盖。缓存同理，是这台机器的、清掉重来不影响别人
// —— 服务端那边根本没有第二份（识别结果不落库，见 server/src/core.js 的 AI_MAX_CALLS_PER_DAY）。
// 「识别能不能跑」看两件事：开关开着 + 通道通着。通道只有一处判断（model.js 的 resolveChannel）：
//   local = 自己配了模型（默认就走它，请求由这台电脑直接发出）
//   cloud = 没配自己的模型，但服务端地址 + **注册口令**都在（原来的那条路）
//   none  = 两条都不成立 —— 这是"还没配"，不是错误，界面据此把人指到该去的地方
// 同步口令既不是必需的、也不是备选：识别只把这一页的候选串问一次模型，不上传也不拉取记录，
// 所以「同步口令填了、注册口令空着」时云端那条路照样不通；「启用云同步」那个勾选框更是无关
// （见 popup.js 的 maybeAiSuggest）。
// 徽标与状态行只在这里算一份，勾选框变化、保存云同步设置、改动模型配置、打开设置面板都走它，
// 免得四处各写一套判断
async function renderAiSection(note = '') {
  const cfg = await AI.loadAiCfg();
  const on = !!cfg.enabled;
  const ch = await MODELS.resolveChannel();
  const live = ch.mode !== 'none';
  $('stAiEnabled').checked = on;
  const badge = $('stAiBadge');
  // 四态：关着 / 走自己的模型 / 走云端 / 还没有可用的模型。
  // 「云端模型」这个写法是必要的：以前只认云端一条路，所以没填口令时一律显示"待配置"，
  // 现在填了自己的模型就通了，徽标得说实话 —— 用户分得清"走的是谁的额度"
  badge.textContent = !on ? '未启用' : (ch.mode === 'local' ? '本机模型' : (ch.mode === 'cloud' ? '云端模型' : '待配置'));
  badge.className = 'set-badge' + (on && live ? '' : ' warn');
  if (note) return setStatus('stAiStatus', note, on && live ? 'ok' : '');
  if (!on) return setStatus('stAiStatus', '已关闭：不会再把页面信息发给模型');
  // 两套缓存分开数、分开说：一个是"岗位页"的、一个是"公司"的，用途与键都不同（见 ai.js 里那两段）。
  // 两条路共用这两份缓存（键里带着"是哪个模型答的"，见 ai.js 的 mk），所以两种走法都报一下
  const n = await AI.cacheCount();
  const t = await AI.typeCacheCount();
  const cacheText = (n || t)
    ? `本机已缓存 ${[n ? `${n} 个岗位页` : '', t ? `${t} 家公司` : ''].filter(Boolean).join(' · ')} 的识别结果`
    : '本机还没有缓存（第一次识别后就有）';
  if (ch.mode === 'local') {
    return setStatus('stAiStatus', `走本机模型：${MODELS.normalizeBaseUrl(ch.cfg.baseUrl)} · ${ch.cfg.model}（由这台电脑直接发出，不经过云端）｜${cacheText}`);
  }
  if (ch.mode === 'cloud') {
    return setStatus('stAiStatus', `走云端模型：用「☁ 云同步」里的注册口令 —— 识别不需要同步口令，也不必勾选「启用云同步」｜${cacheText}`);
  }
  return setStatus('stAiStatus', '还没有可用的识别模型：点下面「配置模型」填一个你自己的模型（不需要任何口令），或在上面「☁ 云同步」里填好服务端地址 + 注册口令');
}

$('stAiEnabled').addEventListener('change', async () => {
  const on = $('stAiEnabled').checked;
  await AI.saveAiCfg({ enabled: on });
  await renderAiSection(on ? '' : '已关闭：不会再把页面信息发给模型');
});

$('stAiClear').addEventListener('click', async () => {
  // 两套缓存一起清：这个按钮叫「清空识别缓存」，用户心里没有"两种缓存"这回事
  const n = await AI.clearCache();
  const t = await AI.clearTypeCache();
  setStatus('stAiStatus', `已清空 ${n} 条岗位缓存、${t} 条企业类型缓存（下次会重新问一次模型）`, 'ok');
});

// ---------- 模型配置（识别请求发给谁） ----------
// 这个弹窗与设置面板的脾气不同：**显式保存**，脚注那个按钮写「关闭」而不是「完成」。
// 原因是它要动跨域授权 —— 浏览器的授权弹窗必须由一次明确的点击触发（用户手势），
// 所以"点保存/测试"和"存下配置"是同一个动作，不能像设置面板那样"关掉就算存了"。
const modelModal = $('modelModal');

function setKeyVisible(on) {
  $('mdApiKey').type = on ? 'text' : 'password';
  $('mdShowKey').textContent = on ? '隐藏' : '显示';
}

// 表单 → 配置。保存与测试共用这一份读法，免得两处对"地址该长什么样"的理解不一样
function readModelForm() {
  return {
    baseUrl: MODELS.normalizeBaseUrl($('mdBaseUrl').value),
    apiKey: $('mdApiKey').value.trim(),
    model: $('mdModel').value.trim(),
    enabled: $('mdEnabled').checked,
  };
}

// 「将调用：…」那一行。两件事要当场说清：① 那条整路径是你填的、工具把它接在了哪儿
// （填 …/v1 或整条 …/chat/completions 都行，最后跑的是同一个地址）；② 填的地址压根不是
// OpenAI 兼容路的（Anthropic 那种），现在就说，别等发出去、拿回一个看不懂的回包再猜
function renderModelCallUrl() {
  const raw = $('mdBaseUrl').value;
  const box = $('mdCallUrl');
  const warn = MODELS.endpointWarning(raw);
  const url = MODELS.callUrl(raw);
  box.className = 'mf-hint' + (warn ? ' warn' : '');
  if (warn) return void (box.textContent = warn);
  box.textContent = url ? `将调用：${url}` : '';
}

async function openModelModal() {
  const cfg = await MODELS.loadModelCfg();
  // Key 要回填：这里是"看看我当初填了什么、改一改"的地方。它只在这台机器上、这个输入框里
  // （type=password，要按「显示」才看得见），关掉弹窗时会被抹掉（见 closeModelModal）
  $('mdBaseUrl').value = cfg.baseUrl || '';
  $('mdApiKey').value = cfg.apiKey || '';
  $('mdModel').value = cfg.model || '';
  $('mdEnabled').checked = !!cfg.enabled;
  setKeyVisible(false);
  renderModelCallUrl();
  setStatus('mdStatus', '');
  modelModal.hidden = false;
}

// 关掉就把输入框里的 Key 抹掉，不在页面上留一串明文挂着（下次打开会重新读回来）
function closeModelModal() {
  if (modelModal.hidden) return;
  $('mdApiKey').value = '';
  setKeyVisible(false);
  setStatus('mdStatus', '');
  modelModal.hidden = true;
  renderAiSection();   // 徽标与状态行跟着这次改动更新
}

$('stModelBtn').addEventListener('click', openModelModal);
$('mdShowKey').addEventListener('click', () => setKeyVisible($('mdApiKey').type === 'password'));
$('mdBaseUrl').addEventListener('input', renderModelCallUrl);

$('mdSave').addEventListener('click', async () => {
  const next = readModelForm();
  // 一眼就不是 OpenAI 兼容路的地址，先别存：存下去只会让"配好了却不好用"更难查
  const warn = MODELS.endpointWarning($('mdBaseUrl').value);
  if (warn && next.enabled) return setStatus('mdStatus', `没法保存：${warn}`, 'err');
  // 授权申请必须是这个点击处理器里的第一件事：浏览器只认用户手势，前面只要 await 过一次，
  // 授权弹窗就不会出现（见 model.js 的 requestHostPermission）。已经授权过的话它立刻返回 true，不会再弹
  const asking = next.enabled && next.baseUrl ? MODELS.requestHostPermission(next.baseUrl) : null;
  if (asking) setStatus('mdStatus', '正在请求浏览器授权…');
  const granted = asking ? await asking : true;

  const saved = await MODELS.saveModelCfg(next);
  $('mdBaseUrl').value = saved.baseUrl;   // 归一回填（去掉尾部斜杠、去掉整条 /chat/completions）
  renderModelCallUrl();
  renderAiSection();
  if (!next.enabled) return setStatus('mdStatus', '已保存：本机模型没启用，识别照旧走云端（需要注册口令）', 'ok');
  if (!MODELS.modelReady(saved)) {
    return setStatus('mdStatus', '已保存，但还差内容：接口地址、API Key、模型名称三项都填上，识别才会走本机', 'err');
  }
  if (!granted) {
    return setStatus('mdStatus', `已保存，但浏览器没有允许访问 ${MODELS.hostLabel(saved.baseUrl)}：识别会停在这一步。再点一次「保存」可以重新申请`, 'err');
  }
  setStatus('mdStatus', '已保存：识别现在走你自己的模型，不经过云端', 'ok');
});

$('mdTest').addEventListener('click', async () => {
  const cfg = readModelForm();
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    return setStatus('mdStatus', '把接口地址、API Key、模型名称三项都填上再测', 'err');
  }
  const warn = MODELS.endpointWarning($('mdBaseUrl').value);
  if (warn) return setStatus('mdStatus', warn, 'err');
  // 同一次点击里先要授权，理由同上
  const granted = await MODELS.requestHostPermission(cfg.baseUrl);
  if (!granted) return setStatus('mdStatus', `浏览器没有允许访问 ${MODELS.hostLabel(cfg.baseUrl)}：先同意授权才能测`, 'err');
  setStatus('mdStatus', '正在问模型（最多等 60 秒）…');
  // 用的是**表单里现在填的**值，不是已保存的：改完地址想先试试，不该逼人先保存一遍
  const r = await MODELS.testLocal(cfg);
  const secs = `${(r.ms / 1000).toFixed(1)} 秒`;
  if (r.ok) return setStatus('mdStatus', `通了（${secs}）：${r.note} —— 保存后识别才会用它`, 'ok');
  setStatus('mdStatus', `没通（${secs}）：${r.error}`, 'err');
});

$('mdClear').addEventListener('click', async () => {
  if (!confirm('清除本机模型配置？\n\n清除后识别回到云端那条路（需要「☁ 云同步」里的注册口令）。\nAPI Key 会从这台电脑的浏览器里删掉。')) return;
  await MODELS.saveModelCfg({ ...MODELS.DEFAULT_MODEL });
  $('mdBaseUrl').value = '';
  $('mdApiKey').value = '';
  $('mdModel').value = '';
  $('mdEnabled').checked = false;
  setKeyVisible(false);
  renderModelCallUrl();
  renderAiSection();
  setStatus('mdStatus', '已清除：识别回到云端那条路', 'ok');
});

const settingsModal = $('settingsModal');
let pushLoaded = null;     // 打开面板时从服务端读回的推送设置；null = 没读到手，关闭时不回写
let enabledAtOpen = false; // 打开面板时的「启用云同步」勾选态，用来识别"这次刚启用"
$('settingsBtn').addEventListener('click', openSettings);
$('syncPill').addEventListener('click', openSettings);
['stEndpoint', 'stToken'].forEach((id) => $(id).addEventListener('input', () => {
  $(id).classList.remove('need');   // 一开始输入就撤掉「必须填这一栏」的红框
  updateIcsUrl(); renderSyncStatus(); updatePhoneSection();
}));
$('stEnrollKey').addEventListener('input', () => { $('stEnrollKey').classList.remove('need'); updatePhoneSection(); });
$('stEnabled').addEventListener('change', () => { renderSyncStatus(); updatePhoneSection(); });
$('stPushKind').addEventListener('change', onPushKindChange);

// 这里曾经有个「生成」按钮：本地生成一串口令就当账号用。现在口令必须由管理员创建后分发
// （服务端只认已开通的口令，见 server/src/protocol.js 的 accountGate），所以按钮和
// SY.generateToken 一起删掉了 —— 留着它只会让用户生成一串永远同步不上去的口令。

// selectId：剪贴板被拒时要选中哪个输入框，让用户手动复制（以前是按状态栏名字猜的，
// 猜错就会去选中口令框 —— 复制配对串失败却选中了口令，用户按 ⌘C 拿到的是另一串东西）
async function copyText(text, okMsg, el, selectId = '') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(el, okMsg, 'ok');
  } catch {
    const input = selectId ? $(selectId) : (el === 'stSyncStatus' ? $('stToken') : $('stIcsUrl'));
    input.select?.();
    setStatus(el, '无法自动复制，已为你选中文本，请按 ⌘/Ctrl+C', 'err');
  }
}
$('stCopyToken').addEventListener('click', () => copyText($('stToken').value.trim(), '口令已复制，请妥善保存', 'stSyncStatus'));
$('stCopyIcs').addEventListener('click', () => copyText($('stIcsUrl').value, '订阅地址已复制', 'stSyncStatus'));
$('stCopyPair').addEventListener('click', () => copyText($('stPairString').value, '配对串已复制 —— 发送到手机（微信「文件传输助手」等），在手机页粘贴即可', 'stPhoneStatus', 'stPairString'));

$('stSavePhone').addEventListener('click', async () => {
  // 走统一入口：以前这里只写 phoneUrl，会把正在编辑的地址/口令一起吞掉
  const { cfg } = await persistSettingsForm();
  setStatus('stPhoneStatus', cfg.phoneUrl ? '已保存手机页地址' : '已清空手机页地址', 'ok');
});

$('stTestConn').addEventListener('click', async () => {
  setStatus('stSyncStatus', '正在连接…');
  try {
    const cfg = { endpoint: $('stEndpoint').value, token: $('stToken').value };
    const r = await SY.ping(cfg);
    setStatus('stSyncStatus', `连接成功：${r.name}（v${r.version}）`, 'ok');
  } catch (e) {
    setStatus('stSyncStatus', `连接失败：${e.message}`, 'err');
  }
});

// 「上传 20 条」里的 20 是**条目**数：记录 + 删除标记（墓碑，本机删掉的记录靠它把删除同步出去）。
// 不分开说就会变成「删掉 5 条测试数据后仍然上传 20 条」，看着像删除没生效（其实那 5 条正是这 5 个标记）。
function syncPushText(r) {
  if (!r) return '';
  const n = Number(r.pushed) || 0;
  const d = Number(r.pushedDeletes) || 0;
  return d ? `${n} 项（${Number(r.pushedRecords) || 0} 条记录 + ${d} 条删除标记）` : `${n} 条`;
}

async function runSync(full) {
  await persistSettingsForm();
  setStatus('stSyncStatus', '同步中…');
  $('syncPill').classList.add('busy');
  try {
    // 回流补推：这一轮合并时若发现远端缺我们这边的节点/历史/JD 全文，记录会被顶新待推
    // （pushedBack > 0），必须立刻补一轮送上去。后台与手机页各有一层同样的循环，
    // 面板这边以前漏了 —— 于是「点了立即同步，另一端还是看不到」要等下一次自动同步（最多 30 分钟）。
    let r = null;
    let rounds = 0;
    do {
      r = await chrome.runtime.sendMessage({ type: 'sync-now', full: full && rounds === 0 });
      rounds++;
    } while (r?.ok && r.pushedBack > 0 && rounds < 5);
    if (r?.skipped) { setStatus('stSyncStatus', `未同步：${r.reason}`, 'err'); return; }
    if (!r?.ok) { setStatus('stSyncStatus', `同步失败：${r?.error || '未知错误'}`, 'err'); return; }
    state.data = await S.loadData();
    renderAll();
    setStatus('stSyncStatus', `同步完成：上传 ${syncPushText(r)}，新增 ${r.added} 条，更新 ${r.updated} 条，删除 ${r.removed} 条`, 'ok');
  } catch (e) {
    setStatus('stSyncStatus', `同步失败：${e.message}`, 'err');
  } finally {
    $('syncPill').classList.remove('busy');
    refreshSyncPill();
  }
}
$('stSyncNow').addEventListener('click', () => runSync(true));
// 首次启用云同步 → 立刻全量同步一次。同一次打开面板里只触发一次：
// 否则「先点保存、再点完成」会连跑两遍全量同步
async function maybeFirstEnableSync(cfg) {
  if (!cfg?.enabled || enabledAtOpen) return;
  enabledAtOpen = true;
  await runSync(true);
}

$('stSaveSync').addEventListener('click', async () => {
  const { cfg, keptEndpoint } = await persistSettingsForm();
  setStatus('stSyncStatus', keptEndpoint ? '服务地址为空，已保留原地址（要停用请取消勾选「启用云同步」）' : '已保存', keptEndpoint ? 'err' : 'ok');
  await maybeFirstEnableSync(cfg);
});

$('stSavePush').addEventListener('click', async () => {
  setStatus('stPushStatus', '保存中…');
  try {
    const { cfg } = await persistSettingsForm();
    pushLoaded = await persistPushForm(cfg);
    setStatus('stPushStatus', '已保存到服务端（同一口令的所有设备共用）', 'ok');
  } catch (e) {
    setStatus('stPushStatus', `保存失败：${e.message}`, 'err');
  }
});

$('stTestPush').addEventListener('click', async () => {
  setStatus('stPushStatus', '正在发送…');
  try {
    const { cfg } = await persistSettingsForm();
    pushLoaded = await persistPushForm(cfg);
    const r = await SY.testPush(cfg);
    if (r.ok) setStatus('stPushStatus', '已发送 —— 请查看手机是否收到（微信 / Bark / 群机器人）', 'ok');
    else setStatus('stPushStatus', `发送失败：${r.error || r.detail || '未知错误'}`, 'err');
  } catch (e) {
    setStatus('stPushStatus', `发送失败：${e.message}`, 'err');
  }
});

// 顶栏同步状态
async function refreshSyncPill() {
  const cfg = await SY.loadSync();
  const el = $('syncPill');
  const prev = el.className;
  el.classList.remove('on', 'err', 'busy');
  if (!cfg.enabled || !cfg.endpoint || !cfg.token) {
    el.textContent = '☁ 未启用';
    el.title = '点此开启多设备云同步与手机提醒';
  } else if (cfg.lastError) {
    el.textContent = '⚠ 同步失败';
    el.classList.add('err');
    el.title = cfg.lastError;
  } else if (cfg.lastSyncAt) {
    el.textContent = '☁ ' + S.fmtRelative(new Date(cfg.lastSyncAt).toISOString());
    el.classList.add('on');
    el.title = `上次同步：${S.fmtDateTime(new Date(cfg.lastSyncAt).toISOString())}`;
  } else {
    el.textContent = '☁ 待同步';
    el.title = '已启用，等待首次同步';
  }
  if (prev.includes('busy')) el.classList.add('busy');
  if (!settingsModal.hidden) renderSyncStatus();
}

// 关闭设置面板：**先落盘再关**。用户点「完成」就是"我改完了"，不该再要求点一次保存
// —— 之前三条关闭路径（完成 / 点背景 / Esc）都只做 hidden = true，改完直接关就全丢了。
async function closeSettings() {
  if (settingsModal.hidden) return;   // Esc 连按两次之类，别重复提交
  let cfg = null;
  try {
    const r = await persistSettingsForm();
    cfg = r.cfg;
    setStatus('stSyncStatus', r.keptEndpoint
      ? '服务地址为空，已保留原地址（要停用请取消勾选「启用云同步」）'
      : (cfg.lastError ? `上次同步失败：${cfg.lastError}` : '已保存'), r.keptEndpoint || cfg.lastError ? 'err' : 'ok');
  } catch (e) {
    setStatus('stSyncStatus', `保存失败：${e.message}`, 'err');
  }
  // 推送设置存在服务端：只有真的改过才回写。否则每次关面板都白打一次网络请求，
  // 还没配过推送的人会莫名其妙看到一条失败提示
  if (cfg && pushLoaded && JSON.stringify(readPushForm()) !== JSON.stringify(pushLoaded)) {
    try {
      pushLoaded = await persistPushForm(cfg);
      setStatus('stPushStatus', '已保存到服务端（同一口令的所有设备共用）', 'ok');
    } catch (e) {
      setStatus('stPushStatus', `保存失败：${e.message}`, 'err');
    }
  }
  settingsModal.hidden = true;
  // 与「保存」按钮保持一致：首次启用云同步就立刻全量同步一次。
  // 放在关闭之后、且不 await —— 同步要跑好几秒，不该让面板卡着不关
  maybeFirstEnableSync(cfg);
}

// ---------- 模态框通用 ----------
// 有「关闭前要收尾」的模态框走各自的关闭函数（设置弹窗要保存配置、面经弹窗要问一句别丢了没保存的内容），
// 其余的一律直接 hidden。两条关闭路径（×/关闭按钮、Escape）共用这一份判断。
// **点空白处不再关闭**：弹窗里往往填了一半，点一下旁边就没了比"多点一下 ×"糟得多（用户明确要求常驻）。
function closeBackdrop(bd) {
  closePicker();   // 弹窗上开着的下拉/日历浮层挂在 body 上，得跟着一起收，不然会孤零零留在屏幕上
  if (bd === modelModal) closeModelModal();
  else if (bd === settingsModal) closeSettings();
  else if (bd === ivModal) closeIvModal();
  else bd.hidden = true;
}
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => closeBackdrop(b.closest('.backdrop'))));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 模型配置是叠在设置面板上的（从设置面板里点开、设置面板不关）：Esc 只收上面那一层，
  // 不然按一下 Esc 连设置面板一起没了，像是什么都没保存就走了
  if (!modelModal.hidden) { closeBackdrop(modelModal); return; }
  let closed = false;
  document.querySelectorAll('.backdrop').forEach((bd) => {
    if (!bd.hidden) { closeBackdrop(bd); closed = true; }
  });
  // 没有弹窗可关时，Esc 退出批量模式（选中一并清空）。
  // 焦点在输入框里时不动：搜索框按 Esc 是"清空关键词"，顺手把选择也清掉太意外。
  if (closed || !state.batchMode) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  toggleBatchMode(false);
});

// ---------- 搜索 ----------
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = searchInput.value.trim(); renderAll(); }, 200);
});

// ---------- 排序切换 ----------
$('sortSelect').addEventListener('change', () => {
  state.sort = $('sortSelect').value;
  localStorage.setItem('tracker.sort', state.sort);
  renderAll();
});

// ---------- 视图切换（列表 / 看板） ----------
function syncViewToggle() {
  document.querySelectorAll('#viewToggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
}
document.querySelectorAll('#viewToggle button').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});

// ---------- 存储变化监听（其他窗口/弹窗写入后实时刷新，避免旧页面覆盖新数据） ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SY.SYNC_KEY]) refreshSyncPill();
  if (!changes[S.STORAGE_KEY]) return;
  S.loadData().then((data) => { state.data = data; renderAll(); });
});

// ---------- 启动 ----------
// 顶栏高度不是个常数：窗口一窄，右上角那排按钮会折成两行，顶栏立刻从 59 长到 101。
// 常驻的批量条停在这个高度下面（CSS 的 --topbar-h），写死 px 迟早对不上 —— 对不上的表现是
// 「批量条被顶栏压住一半」。所以量一次写进变量，窗口尺寸变了再量。
function syncTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const h = Math.ceil(bar.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
}

async function init() {
  state.data = await S.loadData();
  $('todayLabel').textContent = S.todayLabel();
  initSelects();
  syncViewToggle();
  $('sortSelect').value = state.sort;
  window.addEventListener('resize', syncTopbarHeight);   // renderAll 里也会量一次
  renderAll();
  // 版本横幅：扩展已更新但本页面还是旧代码时提示刷新
  try {
    const meta = await chrome.storage.local.get('appMeta');
    if (meta.appMeta?.codeVersion && meta.appMeta.codeVersion !== S.APP_VERSION) {
      const banner = $('updateBanner');
      if (banner) banner.hidden = false;
    }
  } catch { /* 忽略 */ }
  // 顶栏同步状态（每 30 秒刷新相对时间）
  await refreshSyncPill();
  setInterval(refreshSyncPill, 30_000);
  // 从 popup / 通知点击进入时定位到具体记录
  if (location.hash.startsWith('#rec-')) {
    const id = location.hash.slice(5);
    setTimeout(() => {
      scrollToCard(id);
      try { history.replaceState(null, '', location.pathname); } catch { /* 忽略 */ }
    }, 150);
  }
}
init();
