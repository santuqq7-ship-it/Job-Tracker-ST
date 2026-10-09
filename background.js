// background.js — MV3 service worker：badge 计数、alarms 调度、截止时间通知、云同步
import * as S from './shared.js';
import * as SY from './sync.js';

const SWEEP_MINUTES = 30;        // 周期兜底检查（纯本地，不联网）
// 云同步：定期拉取其他设备的改动。
// 30 分钟而不是 15 分钟：云函数按「调用次数」计费，免费额度 1.5 万次/月是
// 所有设备共用的；15 分钟一拉就是 96 次/天/台，几台设备就把额度吃完了。
// 需要立刻拿到另一台设备的改动时，面板上有「立即同步」按钮（只花 1 次调用）。
const SYNC_SWEEP_MINUTES = 30;
const SYNC_DEBOUNCE_MS = 45_000; // 本地改动后延迟推送（合并连续编辑，少打扰服务端）
const UPCOMING_WINDOW_MS = 24 * 3600 * 1000; // 到期前 24h 提醒
const OVERDUE_LIMIT_MS = 7 * 24 * 3600 * 1000; // 过期超过 7 天不再提醒

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

// 数据变化（保存/编辑/删除/导入）统一走 storage，这里作为唯一触发源重算 alarms 与 badge
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[S.STORAGE_KEY]) {
    scheduleNext();
    refreshBadge();
    if (!SY.isApplying()) scheduleSync();  // 本地改动 → 稍后自动推送到云端
  }
});

// ---------- 云同步调度 ----------
let syncTimer = null;
function scheduleSync(delay = SYNC_DEBOUNCE_MS, round = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const cfg = await SY.loadSync();
    if (!cfg.enabled) return;
    const r = await SY.syncNow({ reason: 'auto' });
    // 拉到远端改动 → 数据落盘会触发 onChanged，其他面板窗口自动刷新
    if (r && r.ok && (r.added || r.updated || r.removed)) console.info('[投递管家] 云同步合并', r);
    // 这一轮把本地并集顶新了（远端缺我们这边的节点/历史）→ 立刻再推一轮送上去。
    // 不能指望 onChanged 兜底：合并落盘期间 applying 为真，那次改动是被刻意忽略的，
    // 不补这一轮，本地这份并集就永远留在这台电脑上（两端各自显示不同的节点列表）。
    if (r && r.ok && r.pushedBack > 0 && round < 3) scheduleSync(200, round + 1);
  }, delay);
}

// 面板/弹窗主动请求同步
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'sync-now') {
    SY.syncNow({ full: !!msg.full, reason: 'manual' }).then(sendResponse);
    return true; // 异步响应
  }
  if (msg?.type === 'sync-status') {
    SY.loadSync().then((cfg) => sendResponse(cfg));
    return true;
  }
  return false;
});

// 这里原本有一个「自动备份」：每次 Chrome 启动 + 每 7 天，用 chrome.downloads 把数据导出成
// 「下载/投递备份/投递备份-日期.json」。**已整体删除** —— 它的代价是浏览器里会不定期多出文件，
// 而这点防呆抵不上"我的电脑怎么自己下载东西"的困扰。备份改为**只在用户点「导出 JSON」时**发生
// （面板顶栏那个按钮，走 shared.js 的 download()，不经过 chrome.downloads，因此下面 boot 里
// 也不再需要 downloads 权限了）。数据本体仍然存在 chrome.storage.local，与浏览数据分开，
// 清历史/缓存不会动它 —— 真正会丢的情形只有"移除扩展"这一种，那个由手动导出负责兜。

export async function boot() {
  // 写版本标记：已打开的旧页面据此提示刷新（避免旧代码覆盖新数据）
  chrome.storage.local.set({ appMeta: { codeVersion: S.APP_VERSION, updatedAt: Date.now() } });
  chrome.alarms.create('sweep', { periodInMinutes: SWEEP_MINUTES });
  chrome.alarms.create('syncSweep', { periodInMinutes: SYNC_SWEEP_MINUTES });
  await scheduleNext();
  await refreshBadge();
  await syncOnBoot();
}

// 启动时同步一次（首次同步会全量推送；之后为增量）
async function syncOnBoot() {
  const cfg = await SY.loadSync();
  if (!cfg.enabled) return;
  const first = !cfg.lastSyncAt;
  // 合并若把本地并集顶新了（远端缺我们这边的节点/历史/JD 全文），立刻补一轮送上去 ——
  // 与 scheduleSync 里那个循环同一个理由：启动同步这条路径以前漏了，于是要等下一轮 sweep。
  let r = null;
  for (let round = 0; round < 3; round++) {
    r = await SY.syncNow({ full: (first || !cfg.lastRev) && round === 0, reason: 'boot' });
    if (!r?.ok || !r.pushedBack) break;
  }
  if (r && r.ok && (r.added || r.updated || r.removed)) {
    await scheduleNext();
    await refreshBadge();
  }
}

// 找到所有未完成截止节点的最小时间，调度一次性 alarm（Chrome 120+ 最小粒度 30s）
export async function scheduleNext() {
  const { records } = await S.loadData();
  let soonest = Infinity;
  for (const rec of records) {
    for (const dl of rec.deadlines || []) {
      if (dl.done) continue;
      const t = Date.parse(dl.datetime);
      if (t && t < soonest) soonest = t;
    }
  }
  if (soonest === Infinity) {
    await chrome.alarms.clear('next');
    return;
  }
  // 提前 24h 就该触发一次"即将到期"通知，所以 alarm 安排在 min(时间点, 提前24h点)
  const target = Math.min(soonest, soonest - UPCOMING_WINDOW_MS);
  const when = Math.max(Date.now() + 30_000, target);
  chrome.alarms.create('next', { when });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'syncSweep') { await syncOnBoot(); return; }
  if (alarm.name === 'next' || alarm.name === 'sweep') {
    await checkAndNotify();
    await scheduleNext();
  }
});

// 检查全部截止节点：24h 内 → "即将到期"；已过期 → "已过期"。各自只通知一次（标记存 datetime 值，
// 用户改了时间则标记失配、允许重新提醒；勾选 done 后静默）。
export async function checkAndNotify() {
  const data = await S.loadData();
  const now = Date.now();
  let changed = false;
  for (const rec of data.records) {
    for (const dl of rec.deadlines || []) {
      if (dl.done) continue;
      const t = Date.parse(dl.datetime);
      if (!t) continue;
      if (t > now && t - now <= UPCOMING_WINDOW_MS && dl.notified24hFor !== dl.datetime) {
        notify(rec, dl, 'upcoming');
        dl.notified24hFor = dl.datetime;
        changed = true;
      } else if (t <= now && now - t <= OVERDUE_LIMIT_MS && dl.notifiedOverdueFor !== dl.datetime) {
        notify(rec, dl, 'overdue');
        dl.notifiedOverdueFor = dl.datetime;
        changed = true;
      }
    }
  }
  if (changed) await S.saveData(data);
}

function notify(rec, dl, kind) {
  const overdue = kind === 'overdue';
  chrome.notifications.create('deadline-' + rec.id + '-' + dl.id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `「${rec.position}」${overdue ? '已过期' : '即将到期'}`,
    message: `${rec.company} · ${dl.label} · ${S.fmtDateTime(dl.datetime)}`,
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// 徽标 = 进行中记录数
export async function refreshBadge() {
  const { records } = await S.loadData();
  const active = records.filter((r) => S.ACTIVE_STATUSES.includes(r.status)).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
  await chrome.action.setBadgeText({ text: active > 0 ? (active > 99 ? '99+' : String(active)) : '' });
}
