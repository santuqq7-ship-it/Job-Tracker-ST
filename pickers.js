// pickers.js — 两个自己画的表单控件。系统原生控件在这两处满足不了需求，各有一个具体理由：
//
// ① 类型下拉面板（attachTypeSelect）
//    原生 <select> 的选项行是浏览器画的，**塞不进任何按钮** —— 而用户要的是"每个自定义取值后面
//    直接一个 🗑，点它就把这个写法删掉"。所以打开时不再走原生弹层：拦掉原生那一下，改由这里
//    自己铺一份列表。`<select>` 元素本身留着当**值的容器**：`sel.value` / `sel.options` 的语义
//    一个字不变，别处（读写值、AI 填值、自测）照旧按原来那套走，自建的只是"点开时看到的那层皮"。
// ② 日期时间面板（attachDateInput）
//    系统那个日历/时间面板没有"确定"，选完只能点空白处把它收起来（用户明确抱怨过这一点）。
//    这里自己画一个：月历 + 时/分，**没有确认按钮** —— 改完「分」那一下就算选完（存下来并收起），
//    只改日期、时分不动的人点一下外面或按 Esc 也照样存（见 paintCal 上面那段）。
//
// 两者共用同一个浮层底座：挂在 body 上（弹窗里滚动、溢出都不会把它裁掉）、点浮层外面或 Esc
// 收起、锚点滚动/改尺寸时跟着走。任何时刻只开一个（开新的先关旧的）。
import { CUSTOM_OPT } from './company-type.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// 浮层底座
// ---------------------------------------------------------------------------
let host = null;   // 当前开着的浮层：{ box, anchorId, onDismiss, cleanup }（同时只允许一个）

/** 关掉当前浮层（没开就是空操作），**不**算一次"点外面收起"。 */
export function closePicker() {
  if (!host) return;
  host.cleanup();
  host.box.remove();
  host = null;
}

// 点浮层外面 / Esc：收起浮层。收起前先给 onDismiss 一次机会（日期面板靠它把"动过的选择"存下来）
function dismiss() {
  if (!host) return;
  const fn = host.onDismiss;
  if (fn) fn();          // 它可能顺手把面板也关了（选完就存那条路），所以关的动作放最后、且幂等
  closePicker();
}

function anchorId(el) {
  if (!el.dataset.pickerAnchor) el.dataset.pickerAnchor = 'p' + (anchorId.seq = (anchorId.seq || 0) + 1);
  return el.dataset.pickerAnchor;
}
const isOpenFor = (anchor) => Boolean(host) && host.anchorId === anchorId(anchor);   // 顺手给锚点编号

function openPop(anchor, build, onDismiss) {
  if (host && host.anchorId !== anchorId(anchor)) closePicker();   // 同一时刻只开一个
  const box = document.createElement('div');
  box.className = 'picker-pop';
  build(box);
  document.body.appendChild(box);
  place(anchor, box);

  // 点浮层外面收起；点在锚点上不收起 —— 那一下由锚点自己的处理器决定（再点一下＝收起）
  const onDown = (e) => {
    if (box.contains(e.target)) return;
    if (e.target === anchor || anchor.contains(e.target)) return;
    dismiss();
  };
  // Esc 同样收起，且**拦住它继续往下走**：面板里按 Esc 不该把整个编辑弹窗一起关掉
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    dismiss();
  };
  const onMove = () => { if (host && host.box === box) place(anchor, box); };   // 滚动时跟着锚点走
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  document.addEventListener('scroll', onMove, true);
  host = {
    box,
    anchorId: anchorId(anchor),
    onDismiss,
    cleanup: () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('scroll', onMove, true);
    },
  };
}

// 摆在锚点正下方；下面放不下就翻到上面；左右夹在窗口内（锚点靠近右边缘时不会顶出去）
function place(anchor, box) {
  const r = anchor.getBoundingClientRect();
  box.style.visibility = 'hidden';
  box.style.top = '0px';
  box.style.left = '0px';
  const h = box.offsetHeight, w = box.offsetWidth;
  const vh = window.innerHeight, vw = document.documentElement.clientWidth;
  let top = r.bottom + 4;
  if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
  if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
  const left = Math.max(8, Math.min(r.left, vw - w - 8));
  box.style.top = top + window.scrollY + 'px';
  box.style.left = left + window.scrollX + 'px';
  box.style.visibility = '';
}

// 开/关同一处（锚点上再点一下＝收起）
function togglePop(anchor, build) {
  if (isOpenFor(anchor)) { closePicker(); return; }
  openPop(anchor, build);
}

// ---------------------------------------------------------------------------
// ① 类型下拉面板
// ---------------------------------------------------------------------------
/**
 * 把 <select> 的打开动作换成自建列表（选项仍从这个 select 现读，改选项照旧只改 select）。
 * @param {HTMLSelectElement} sel
 * @param {{isCustom?:(v:string)=>boolean, onDelete?:(v:string)=>Promise<void>|void}} cfg
 *   isCustom(v) 决定这一项后面出不出 🗑（内置的 7 性质 / 14 赛道永远不出）；
 *   onDelete(v) 由调用方执行删除（改清单、存库、重铺选项、说清结果），这里只管重画。
 */
export function attachTypeSelect(sel, cfg = {}) {
  if (!sel || sel.dataset.pickerType) return;
  sel.dataset.pickerType = '1';
  // mousedown 上 preventDefault：原生弹层是在这一下打开的，用 click 拦太晚（面板已经弹出来了）。
  // 代价是框拿不到焦点，所以自己补一下（键盘用户还要靠它接后续的 Enter/方向键）
  sel.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sel.focus({ preventScroll: true });
    togglePop(sel, (box) => buildTypePanel(box, sel, cfg));
  });
  sel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && !(e.altKey && e.key === 'ArrowDown')) return;
    e.preventDefault();
    togglePop(sel, (box) => buildTypePanel(box, sel, cfg));
  });
}

function buildTypePanel(box, sel, cfg) {
  box.classList.add('picker-list');
  box.setAttribute('role', 'listbox');
  const paint = () => {
    box.textContent = '';
    for (const opt of sel.options) {
      const v = opt.value;
      const row = document.createElement('div');
      row.className = 'picker-row';
      row.setAttribute('role', 'option');
      if (v === sel.value) { row.classList.add('on'); row.setAttribute('aria-selected', 'true'); }
      const label = document.createElement('span');
      label.className = 'picker-label';
      label.textContent = opt.textContent;
      row.appendChild(label);
      // 🗑 只长在"我自己加进清单的写法"后面。按下去只动清单，不动任何记录 —— 那句话由
      // onDelete 那边说（它才知道还有几条记录在用这个写法）
      if (v && v !== CUSTOM_OPT && cfg.isCustom?.(v)) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'picker-del';
        del.textContent = '🗑';
        del.title = `把「${v}」从你的清单里删掉（内置分类不给删；记录里的值一个都不动）`;
        del.setAttribute('aria-label', del.title);
        del.addEventListener('click', async (e) => {
          e.stopPropagation();               // 别让这一下顺带把整行选中
          del.disabled = true;
          const wasPicked = sel.value === v;  // 这一栏选中的正是它 → 删完这一栏清空（用户要的就是这个）
          await cfg.onDelete?.(v);
          if (wasPicked && sel.value) {
            sel.value = '';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          paint();                            // 选项已经重铺过，列表跟着重画（删掉的项就没了）
        });
        row.appendChild(del);
      }
      row.addEventListener('click', () => {
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));   // 让既有的选值逻辑照旧跑
        closePicker();
      });
      box.appendChild(row);
    }
  };
  paint();
}

// ---------------------------------------------------------------------------
// ② 日期时间面板
// ---------------------------------------------------------------------------
/**
 * 把 datetime-local 输入框改成"点开自建日历"。值仍然写回 `input.value`
 * （格式与原生一致：YYYY-MM-DDTHH:mm），所以读它的地方一行都不用改。
 * @param {HTMLInputElement} input
 * @param {{onCommit?:()=>void}} cfg  选完（改完「分」，或动过之后收起面板）叫一声
 *   —— 截止节点那行靠它把输入框收成时间 chip
 */
export function attachDateInput(input, cfg = {}) {
  if (!input || input.dataset.pickerDate) return;
  input.dataset.pickerDate = '1';
  input.readOnly = true;                  // 原生那个面板不再弹（它没有收尾动作，选完只能点空白处）
  input.classList.add('dt-input');
  input.addEventListener('click', () => openDatePanel(input, cfg));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openDatePanel(input, cfg);
  });
}

function openDatePanel(input, cfg) {
  if (isOpenFor(input)) { closePicker(); return; }
  const pend = parseLocalInput(input.value) || nowParts();
  const view = { y: pend.y, m: pend.m };
  // touched = 这次打开里用户到底动过没有：
  //   · 动过 → 收起（点外面 / Esc）就算选完，把选择存下来 —— 只改日期、时分不动的人也得有路可走
  //   · 没动过 → 收起就只是收起，不许顺手给空着的字段填一个"现在"
  const st = { touched: false };
  const doCommit = () => commit(input, pend, cfg);
  openPop(input, (box) => {
    box.classList.add('picker-cal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '选择日期与时间');
    paintCal(box, pend, view, st, doCommit);
  }, () => { if (st.touched) doCommit(); });
}

const nowParts = () => {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
};

/** 解析原生 datetime-local 的值（YYYY-MM-DDTHH:mm，本地时间）；认不出返回 null。 */
function parseLocalInput(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], m: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5] };
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function commit(input, pend, cfg) {
  input.value = `${pend.y}-${pad2(pend.m + 1)}-${pad2(pend.d)}T${pad2(pend.h)}:${pad2(pend.mi)}`;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  closePicker();
  cfg.onCommit?.();
}

// 画一次面板（翻年/翻月、点日期、点小时都重画）：表头（« 年 ‹ 月 › »）+ 月历 6 周 + 时/分格子。
// **没有确认按钮**：点「分」那一下就算选完（直接存下来并收起）；只改日期的人点一下外面/ Esc 也照样存。
function paintCal(box, pend, view, st, onOk) {
  box.textContent = '';

  const head = document.createElement('div');
  head.className = 'picker-head';
  // unit: 'y' 年 / 'm' 月。翻年只动年份（月份保持），翻月按 12 进制进位 ——
  // 光能一个月一个月地挪，跨年投递要按十几次，所以年份单独给一对按钮
  const nav = (step, text, title, unit) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'picker-nav' + (unit === 'y' ? ' picker-nav-y' : '');
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', () => {
      if (unit === 'y') {
        view.y += step;
      } else {
        const m = view.m + step;
        view.y += Math.floor(m / 12);
        view.m = ((m % 12) + 12) % 12;
      }
      paintCal(box, pend, view, st, onOk);
    });
    return b;
  };
  const title = document.createElement('span');
  title.className = 'picker-title';
  title.textContent = `${view.y} 年 ${view.m + 1} 月`;
  head.append(
    nav(-1, '«', '上一年', 'y'), nav(-1, '‹', '上一个月', 'm'),
    title,
    nav(1, '›', '下一个月', 'm'), nav(1, '»', '下一年', 'y'),
  );

  const wk = document.createElement('div');
  wk.className = 'picker-week';
  for (const w of WEEK) {
    const s = document.createElement('span');
    s.textContent = w;
    wk.appendChild(s);
  }

  // 从当月 1 号所在那一周的周日铺满 42 格。上下月的补位格淡化显示、点了也能选（视图跟着翻过去）
  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  const first = new Date(view.y, view.m, 1);
  const today = new Date();
  for (let i = 0; i < 42; i++) {
    const d = new Date(view.y, view.m, 1 - first.getDay() + i);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'picker-day';
    cell.textContent = String(d.getDate());
    if (d.getMonth() !== view.m) cell.classList.add('out');
    if (sameDay(d, today)) cell.classList.add('today');
    if (d.getFullYear() === pend.y && d.getMonth() === pend.m && d.getDate() === pend.d) cell.classList.add('on');
    cell.addEventListener('click', () => {
      pend.y = d.getFullYear();
      pend.m = d.getMonth();
      pend.d = d.getDate();
      st.touched = true;
      if (d.getMonth() !== view.m) { view.y = d.getFullYear(); view.m = d.getMonth(); }
      paintCal(box, pend, view, st, onOk);
    });
    grid.appendChild(cell);
  }

  // 时/分：铺成一片小格子，不再用 <select> —— 那个一展开就是 24 行 / 60 行的长列表，
  // 既难看又要滚。格子是「全都看得见、点一下就是它」，高度可控（时 6 列 × 4 行，分 10 列 × 6 行）。
  const time = document.createElement('div');
  time.className = 'picker-time';
  const section = (label, list, cur, set, done) => {
    const wrap = document.createElement('div');
    wrap.className = 'picker-time-field';
    const cap = document.createElement('span');
    cap.className = 'picker-chip-cap';
    cap.textContent = label;
    const grid = document.createElement('div');
    grid.className = 'picker-chip-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', label);
    for (const n of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'picker-chip';
      b.textContent = pad2(n);
      if (n === cur) { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); }
      b.addEventListener('click', () => {
        set(n);
        st.touched = true;
        // done=true 的是「分」：它是这一串选择的最后一步，点它＝选完（存下来并收起，没有确认按钮）
        if (done) onOk(); else paintCal(box, pend, view, st, onOk);
      });
      grid.appendChild(b);
    }
    wrap.append(cap, grid);
    return wrap;
  };
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const mins = Array.from({ length: 60 }, (_, i) => i);
  time.append(
    section('时', hours, pend.h, (n) => { pend.h = n; }, false),
    section('分', mins, pend.mi, (n) => { pend.mi = n; }, true),
  );

  box.append(head, wk, grid, time);
}
