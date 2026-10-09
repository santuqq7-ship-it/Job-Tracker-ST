// calendar-ics.js — 手机日历的「文件版」：把记录里「未完成 + 有截止时间」的节点导成 .ics 文件
//
// 为什么单独一个文件：电脑端和手机端都要导出这份文件，而手机壳子（mobile/sw.js 的 SHELL）
// 是**整份缓存**的 —— 手机只做「看 + 改状态」，不该为了一个导出按钮把 transfer.js
// （导入导出 + 表格解析，56 KB）和它的依赖 company-type.js（44 KB 静态企业库）一起背上去。
// 抽出来之后两边 import 的是同一份实现：UID / SEQUENCE / 「取消」语义只有一处 ——
// 同一个节点在电脑和手机上导出的必定是同一个事件；一旦分叉，手机上会多出一条重复提醒
// （UID 不同就是两个事件）。transfer.js 仍原样转发这里的所有名字（dashboard.js 与
// tools/test-transfer.mjs 调的是它），两处不许分叉由 test-transfer 的「同一份实现」断言盯着。
//
// 与「日历订阅」（server/src/core.js 的 buildIcs）是两套语义：订阅版输出的是一份整体日历，
// 文件版需要 SEQUENCE / STATUS:CANCELLED 这类「更新与撤销」语义，两者刻意分开。
import * as S from './shared.js';

export const CALENDAR_NAME = '投递管家';
export const CALENDAR_KEY = 'jobTrackerCalendar';  // chrome.storage.local 里的键（导出快照）

// ---------- 节点 → 事件：UID / 内容 / 排序 ----------

// 哈希实现搬到了 shared.js（S.fnv32）：截止节点的确定性 id 也要用它。
// 输出与原来的局部实现逐字节一致，手机上已订阅的日历 UID 不会变。
const fnv = S.fnv32;

// 节点排序：先按时间；同一时刻（同一格填的多个节点）按 id 定序，保证两个设备上场顺序一致
function byDatetime(a, b) {
  return String(a.datetime || '').localeCompare(String(b.datetime || '')) || String(a.id).localeCompare(String(b.id));
}

// 事件 UID：由「岗位身份 + 节点名 + 同名序号」推出，不含时间 ——
// 于是改截止时间 = 更新同一个事件，不会在手机上多出一条。
export function calendarUid(rec, label, ordinal) {
  const base = `${S.recordKey(rec)}|${label}|${ordinal}`;
  return `${fnv(base)}${fnv(base + '#salt')}@jobtracker`;
}

function calendarDescription(rec, dl) {
  const parts = [];
  parts.push(`状态：${rec.status || '筛选中'}`);
  if (rec.stage && rec.status === S.STATUS.INTERVIEW) parts.push(`轮次：${rec.stage}`);
  if (rec.result && rec.status === S.STATUS.ENDED) parts.push(`结果：${rec.result}`);
  parts.push(`投递：${S.fmtDateTime(rec.appliedAt)}`);
  if (rec.notes) parts.push(`备注：${rec.notes}`);
  parts.push(`节点：${dl.label || '截止'}`);
  if (rec.url) parts.push(rec.url);
  return parts.join('\n');
}

/**
 * 从记录里挑出要进日历的节点：**只含有截止时间且未完成**的节点，
 * 没有截止时间的岗位不会进日历。
 */
export function calendarItems(records) {
  const items = [];
  for (const rec of records || []) {
    const pend = (rec.deadlines || []).filter((d) => d && !d.done && Date.parse(d.datetime));
    if (!pend.length) continue;
    const ordinals = new Map();
    for (const d of [...pend].sort(byDatetime)) {
      const label = d.label || '截止节点';
      const n = ordinals.get(label) || 0;
      ordinals.set(label, n + 1);
      items.push({
        uid: calendarUid(rec, label, n),
        dt: Date.parse(d.datetime),
        label,
        summary: [rec.company, rec.position, label].filter(Boolean).join(' · '),
        description: calendarDescription(rec, d),
        url: rec.url || '',
      });
    }
  }
  return items.sort((a, b) => a.dt - b.dt || a.uid.localeCompare(b.uid));
}

// ---------- ICS 原语（RFC 5545） ----------
function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// 按 75 字节折行（中文 3 字节，必须按字节算；续行以空格开头）
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 73) return line;
  let out = '', cur = '', curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > 73) { out += cur + '\r\n '; cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  return out + cur;
}

function icsStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// 提前多久提醒（分钟）：与扩展内的两档保持一致
export const ALARMS = [24 * 60, 60];

/**
 * 生成 .ics 文本。items 里可以混入 cancelled 事件（用来撤销上次导入的旧节点）。
 * 时间一律用 UTC（带 Z）——手机在任何时区都能正确换算，也避免了 TZID 兼容问题。
 */
export function buildCalendarIcs(items, { now = Date.now(), calName = CALENDAR_NAME, prodId = '-//投递状态管家//CN' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];
  for (const it of items || []) {
    const dt = Number(it.dt) || 0;
    if (!dt) continue;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(it.uid)}`);
    lines.push(`DTSTAMP:${icsStamp(now)}`);
    lines.push(`SEQUENCE:${Math.max(0, Number(it.seq) || 0)}`);
    lines.push(`DTSTART:${icsStamp(dt)}`);
    lines.push(`DTEND:${icsStamp(dt + 30 * 60000)}`);
    lines.push(`SUMMARY:${icsEscape(it.summary || '')}`);
    if (it.description) lines.push(`DESCRIPTION:${icsEscape(it.description)}`);
    if (it.url) lines.push(`URL:${icsEscape(it.url)}`);
    lines.push(`STATUS:${it.cancelled ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push('TRANSP:OPAQUE');
    if (!it.cancelled) {
      for (const m of ALARMS) {
        lines.push('BEGIN:VALARM');
        // 提醒自己也要有 UID（以及苹果私有的 X-WR-ALARMUID），这是 iOS 认不认这条提醒的关键：
        // 苹果那边只写 TRIGGER 就能响，iOS 上却会静默丢掉整条 VALARM —— 表现就是"导进去了，
        // 但一条提醒都没有"。两个值都从事件 uid 派生（去掉域名再接 -a<分钟>），稳定不变：
        // 同一份文件重复导入时，系统认得出这是同一条提醒，而不是又加了一条。
        const auid = `${String(it.uid).split('@')[0]}-a${m}@jobtracker`;
        lines.push(`UID:${icsEscape(auid)}`);
        lines.push(`X-WR-ALARMUID:${icsEscape(auid)}`);
        lines.push(`TRIGGER:-PT${m}M`);
        lines.push('ACTION:DISPLAY');
        lines.push(`DESCRIPTION:${icsEscape(it.summary || '截止提醒')}`);
        lines.push('END:VALARM');
      }
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// 事件内容指纹：用来判断"这个节点的内容变了没有"，变了才递增 SEQUENCE
function contentHash(it) {
  return fnv(`${it.dt}|${it.summary}|${it.description}`);
}

/**
 * 与上次导出的快照比对，得到本次要写进文件的事件（含需要撤销的）。
 * @param {object} prev 上次的快照 {items:{uid:{seq,hash,dt,summary,label}}}
 * @returns {{items:Array, snapshot:object, stats:{events:number,updated:number,cancelled:number}}}
 */
export function diffCalendar(prev, items, { now = Date.now() } = {}) {
  const before = (prev && prev.items) || {};
  const out = [];
  const snapshot = {};
  const stats = { events: 0, updated: 0, cancelled: 0 };
  for (const it of items || []) {
    const hash = contentHash(it);
    const old = before[it.uid];
    const seq = old ? (old.hash === hash ? old.seq : old.seq + 1) : 1;
    if (old && old.hash !== hash) stats.updated++;
    out.push({ ...it, seq });
    snapshot[it.uid] = { seq, hash, dt: it.dt, label: it.label, summary: it.summary };
    stats.events++;
  }
  // 上次导出过、这次已经不在列表里的（节点完成/删除/记录删除/改了岗位）→ 标记取消
  for (const [uid, old] of Object.entries(before)) {
    if (snapshot[uid]) continue;
    out.push({ uid, seq: (Number(old.seq) || 0) + 1, cancelled: true, dt: old.dt, summary: old.summary, label: old.label });
    stats.cancelled++;
  }
  return { items: out, snapshot: { at: new Date(now).toISOString(), items: snapshot }, stats };
}

/** 「清空」文件：把上次导出过的事件全部标记为取消（快照清空，下次导出从 SEQUENCE 1 重新开始） */
export function clearCalendar(prev, { now = Date.now() } = {}) {
  const before = (prev && prev.items) || {};
  const items = Object.entries(before).map(([uid, old]) => ({
    uid, seq: (Number(old.seq) || 0) + 1, cancelled: true, dt: old.dt, summary: old.summary, label: old.label,
  }));
  return { items, snapshot: { at: new Date(now).toISOString(), items: {} }, stats: { events: 0, updated: 0, cancelled: items.length } };
}
