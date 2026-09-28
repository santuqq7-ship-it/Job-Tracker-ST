// sync.js — 云同步客户端（背景页与面板共用）
// 设计要点：
//   · 口令即身份：同步口令派生用户标识，无需注册、不采集邮箱手机号
//   · 增量双向：本地按 lastSyncAt 推送变更，按服务端 rev 游标拉取变更
//   · 冲突策略：记录级 LWW（updatedAt 新者胜）；截止节点与状态历史各自带时间戳做节点级 LWW，
//     删除用节点墓碑表达（见 shared.js 的 mergeDeadlineState）——
//     纯并集无法表达"删除"，一端删掉必被对端复活，这是用户报的"两端节点不同步"的根因
//   · 删除传播：本地删除写墓碑，避免被另一台设备的旧数据"复活"
//   · JD 全文：随记录一起同步，没有开关、也没有自己的合并规则 —— 它就是记录里的普通字段，
//     谁的时间戳新谁整条覆盖（含 JD），理由见下面 `recordPayload 的位置` 那段
//   · 提醒队列：由服务端从记录里派生（只存时间/节点名/公司岗位这几项最小明文）
import * as S from './shared.js';

export const SYNC_KEY = 'jobTrackerSync';

// 拉取游标（lastRev）所属的「号段」。
// lastRev 记的是「本机见过的最大版本号」，增量拉取靠 rev > lastRev 取变更。因此服务端的号码一旦
// 回退，所有设备的游标就都高于真实号码，那之后写入的记录对它们**永久不可见** ——
// 现象是「电脑改了、同步也成功、服务端也有，手机刷新页面就是看不到，只有清掉本地数据重新配对
// （since=0）才看得到」。服务端确实有过这条路：保存推送设置时会把用户的 rev_seq 打回 0
// （成因见 server/src/repo/unicloud.js 的 ensureUser 注释），已在同一个版本里修掉。
// 号段号就是给这类历史遗留兜底的：客户端发现自己的号段比这里低，就强制全量拉一轮重新对齐，
// 跑过一次记下当前号段，此后不再重复。每次「必须让所有设备重新全量对齐一次」时 +1。
export const CURSOR_EPOCH = 2;

export const DEFAULT_SYNC = {
  enabled: false,
  endpoint: '',
  token: '',
  enrollKey: '',
  // cursorEpoch：本机已经对完账的号段（见 CURSOR_EPOCH）。旧配置里没有它 → 0 → 第一次同步全量拉一轮。
  cursorEpoch: 0,
  phoneUrl: '',       // 手机网页版的地址（只是备忘，配对串不依赖它）
  lastRev: 0,
  lastSyncAt: null,
  lastResult: null,   // { at, pushed, pulled, added, updated, removed }
  lastError: null,
  lastErrorAt: null,
  lastErrorCode: null,   // 服务端给的机器可读原因（ENROLL/TOKEN/DISABLED/QUOTA），面板据此高亮到正确的输入框
};

// 同步中 / 正在写入远端数据 —— 供 background 判断，避免"写入→触发同步→再写入"的回环
let busy = false;
let applying = false;
export const isBusy = () => busy;
export const isApplying = () => applying;

// ---------- 口令 ----------
// 这里**故意没有**「生成口令」函数：同步口令必须由管理员创建后分发（在「投递工具管理员」里
// 建号 → 把口令发给用户）。以前客户端自己生成口令再推到服务端，等于每个人都能自助开号 ——
// 服务地址一旦外传，任何人都能无限建号往里灌数据。现在服务端只认已开通的口令（见
// server/src/protocol.js 的 accountGate），所以客户端连这个按钮都没有。

// ---------- 配置读写 ----------
export async function loadSync() {
  const raw = await chrome.storage.local.get(SYNC_KEY);
  const cfg = { ...DEFAULT_SYNC, ...(raw[SYNC_KEY] || {}) };
  // JD 从 1.12 起必同步（见 recordPayload 的位置留下的说明）：开关时代的残留键直接丢掉，
  // 免得它继续躺在配置里被人当成"还有个开关"（下一次 saveSync 落盘时它就彻底消失了）。
  // jdRepair / reconciled 是同一个功能的旧标记名 —— 老名字留着会被人当成"JD 专有修复"，
  // 或以为对账已经跑过（号段变了照样要重来一轮，见 CURSOR_EPOCH）。
  delete cfg.syncJd;
  delete cfg.jdRepair;
  delete cfg.reconciled;
  return cfg;
}

export async function saveSync(patch) {
  applying = true;
  try {
    const cur = await loadSync();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [SYNC_KEY]: next });
    return next;
  } finally {
    setTimeout(() => { applying = false; }, 0);
  }
}

export function normalizeEndpoint(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

export function icsUrl(cfg) {
  const base = normalizeEndpoint(cfg.endpoint);
  if (!base || !cfg.token) return '';
  // 用「以 .ics 结尾、不带 query」的路径形式：安卓（OPPO/ColorOS 等）的系统日历
  // 会拒收带 ? 的订阅地址，报「操作失败，当前网络不稳定」。
  // 服务端同时保留 /ics?t=<口令> 的旧写法，老用户已经订阅过的地址不会失效。
  return `${base}/ics/${encodeURIComponent(cfg.token.trim())}.ics`;
}

// ---------- HTTP ----------
// 凭证不放自定义请求头，而是随请求「主体」走：POST → JSON body，GET → query。
// 这是被支付宝云的网关逼出来的硬约束，不是风格选择：
//   「函数URL化」会短路所有 OPTIONS 预检（回 200 空响应、一个 access-control-* 头都没有，
//   请求根本不进云函数）。而只要带自定义请求头、或 Content-Type 用 application/json，
//   浏览器就会先发 OPTIONS —— 于是 100% 失败。扩展页面的来源是 chrome-extension://，
//   表达不成控制台跨域白名单里的条目，绕不过去。
// 所以这里只发「CORS 简单请求」：不带任何自定义头，Content-Type 取安全列表内的 text/plain
// （body 本身仍是 JSON —— 服务端不看 Content-Type，直接 JSON.parse）。
// 来龙去脉见 server/src/protocol.js 文件头的「凭证怎么传」，动这里之前请先读那段。
async function apiFetch(cfg, path, { method = 'GET', body, timeoutMs = 0, needToken = true } = {}) {
  const base = normalizeEndpoint(cfg.endpoint);
  if (!base) throw new Error('未填写服务端地址');
  const token = String(cfg.token || '').trim();
  const enrollKey = String(cfg.enrollKey || '').trim();
  // 同步这条路必须有同步口令（记录记在谁名下就靠它）。识别那条（needToken:false）不需要，
  // 也不接受：识别的凭证**只有注册口令** —— 带上同步口令会让"同步口令也能换识别"这件事
  // 看起来成立，而它不是（服务端 recognizeGate 同样不看 t）。两件事各自独立：
  // 同步口令决定记录上不上云，注册口令决定能不能用识别。
  if (needToken && !token) throw new Error('未填写同步口令');
  if (!needToken && !enrollKey) throw new Error('未填写注册口令');
  // t = 同步口令、e = 注册口令。识别那条只带 e
  const cred = {
    ...(needToken && token ? { t: token } : {}),
    ...(enrollKey ? { e: enrollKey } : {}),
  };
  const hasBody = body !== undefined;
  // 有 body 的（POST）把凭证并进 body，口令因此不进 URL，也不会留在网关日志里；
  // 没 body 的（GET /api/settings、/api/ping）带不了 body，只能走 query。
  const url = hasBody ? base + path : base + path + '?' + new URLSearchParams(cred);
  // timeoutMs > 0 时才挂超时（同步那条路不能有：一次全量同步本来就可能跑很久）。
  // 需要它的是 AI 识别 —— 面板正在等一个"锦上添花"的建议，绝不能让它把面板吊死
  let ctl = null, timer = null;
  if (timeoutMs > 0 && typeof AbortController === 'function') {
    ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), timeoutMs);
  }
  let res;
  try {
    res = await fetch(url, hasBody ? {
      method,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ ...body, ...cred }),
      ...(ctl ? { signal: ctl.signal } : {}),
    } : { method, ...(ctl ? { signal: ctl.signal } : {}) });
  } catch (e) {
    throw new Error(ctl?.signal.aborted
      ? '服务端响应超时（已放弃这次识别，不影响已填好的内容）'
      : '无法连接服务端（检查地址是否正确、服务是否已部署）');
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `服务端返回 HTTP ${res.status}`);
    // 服务端在 403/413 上带一个机器可读的 code（ENROLL / TOKEN / DISABLED / QUOTA）。
    // 挂在 Error 上带出去，让面板能把高亮打到正确的输入框 —— 别在这里按中文文案分支。
    if (json?.code) err.code = String(json.code);
    throw err;
  }
  return json;
}

export async function ping(cfg) {
  return apiFetch(cfg, '/api/ping');
}
export async function fetchSettings(cfg) {
  return apiFetch(cfg, '/api/settings');
}
export async function saveSettings(cfg, settings) {
  return apiFetch(cfg, '/api/settings', { method: 'POST', body: settings });
}
export async function testPush(cfg) {
  return apiFetch(cfg, '/api/test-push', { method: 'POST', body: {} });
}

// AI 兜底识别：把「页面地址 + 标题 + 两组候选串」交给服务端，由服务端问模型（key 只在那边）。
// 服务端只做转发与额度控制，**不缓存、不落库**；省钱那层在调用方（ai.js 的本机缓存，
// 命中时连这个函数都不会被调到）。走的还是同一套 CORS 简单请求，所以支付宝云那个
// OPTIONS 预检的坑在这条路由上不存在（见文件头与 protocol.js 的「凭证怎么传」）。
// **不带同步口令**（needToken:false）：凭证只有注册口令，没有它这条请求直接不发。
export async function recognizeJob(cfg, body, { timeoutMs = 12000 } = {}) {
  return apiFetch(cfg, '/api/recognize', { method: 'POST', body, timeoutMs, needToken: false });
}

// ---------- 待推送的负载 = 记录原文 ----------
// 这里曾经有个 recordPayload(rec, { syncJd })：关掉「同步 JD 全文」时把 jd 字段整个摘掉。
// 那是个陷阱，删掉不再提供 —— 服务端把 data 当**不透明整包**落库（protocol.js 的
// JSON.stringify(inc.data)），摘掉字段等于**把服务端那份的 JD 抹掉**，不是"这次没带上"。
// 更糟的是回不来：服务端的幂等判断是 updatedAt <= 已存 → 跳过（core.js 的 diffIncoming），
// 而重新勾选开关不改变任何记录的 updatedAt，于是那条记录怎么重推都进不去，JD 永远停在服务端那一版。
//
// 现在的规则没有例外：JD 就是记录里的一个普通字段，跟 company/notes 一样随记录级 LWW 整条覆盖 ——
// 谁的时间戳新谁说了算，**清空 JD 也是一次正常的修改**（另一端的旧全文不该把它拉回来）。
// 配套要求：改 JD 必须顶新 updatedAt（面板的 JD 模态框就是这么存的），否则那次修改不是"新的"，
// 下一次合并会被判负、白改。提醒队列那边仍然只取公司/岗位/时间等最小几项（见 server/src/protocol.js）。

// ---------- 远端记录合并（纯函数，便于单测） ----------
/**
 * 把服务端下发的记录合并进本地数据（直接修改 data）
 * @returns {{added:number, updated:number, removed:number, restored:number, pushedBack:number}}
 *   pushedBack = 本地补了远端没有的节点/历史，或两端时间戳相同内容却不一致、于是把记录顶新待推的条数
 *   （调用方看到它要再同步一轮，把这份送上去）
 */
export function applyRemoteRecords(data, rows) {
  const stat = { added: 0, updated: 0, removed: 0, restored: 0, pushedBack: 0 };
  if (!Array.isArray(data.tombstones)) data.tombstones = [];
  for (const row of rows || []) {
    if (!row || !row.id) continue;
    const at = Date.parse(row.updatedAt) || 0;
    const idx = data.records.findIndex((r) => r.id === row.id);
    const local = idx >= 0 ? data.records[idx] : null;
    const tIdx = data.tombstones.findIndex((t) => t.id === row.id);
    const tomb = tIdx >= 0 ? data.tombstones[tIdx] : null;

    if (row.deleted) {
      if (local && (Date.parse(local.updatedAt) || 0) > at) {
        // 本地在对方删除之后又改过 → 以本地为准，撤销墓碑
        if (tomb) data.tombstones.splice(tIdx, 1);
        continue;
      }
      if (local) { data.records.splice(idx, 1); stat.removed++; }
      if (tomb) data.tombstones[tIdx] = { id: row.id, at: row.updatedAt };
      else data.tombstones.push({ id: row.id, at: row.updatedAt });
      continue;
    }

    // 本地删得更晚 → 忽略远端这条（下次同步会把墓碑推上去）
    if (tomb && (Date.parse(tomb.at) || 0) >= at) continue;

    const incoming = { ...(row.data || {}), id: row.id, updatedAt: row.updatedAt };
    if (!local) {
      const rec = {
        company: '', position: '', url: '', jd: '', sourceTitle: '',
        status: S.STATUS.SCREENING, stage: null, result: null,
        appliedAt: incoming.createdAt || row.updatedAt,
        createdAt: incoming.createdAt || row.updatedAt,
        notes: '', deadlines: [], history: [], interviews: [], interviewTombstones: [], ...incoming,
      };
      data.records.push(rec);
      if (tomb) data.tombstones.splice(tIdx, 1);
      stat.added++;
      continue;
    }

    const localT = Date.parse(local.updatedAt) || 0;
    // 相等也要进合并分支：本地那份并集（旧版本逻辑留下的、或导入产生的）时间戳正好等于远端时，
    // 不进来的话它永远没机会回流服务端 —— 这正是「电脑加了节点、手机永远看不到」的直接原因。
    if (at >= localT) {
      const remoteWins = at > localT;
      const prefer = remoteWins ? 'b' : 'a';
      const dls = S.mergeDeadlineState(local, incoming, { prefer });
      const his = S.mergeHistoryState(local, incoming, { prefer });
      const ivs = S.mergeInterviewState(local, incoming, { prefer });
      // 记录主体（公司/岗位/JD 全文/备注/状态…）没有例外字段：赢的那版整条覆盖输的那版。
      // 尤其 JD —— 清空它也是一次正常的修改，不该被另一端的旧全文"救"回来（留档不靠合并规则保证，
      // 靠的是每次修改都顶新 updatedAt：新的那次一定赢，见 recordPayload 那段）。
      const merged = {
        ...(remoteWins ? { ...local, ...incoming } : { ...local }),
        // 节点/历史/面经走各自那套合并规则（见 shared.js）：增/改/删都能收敛，
        // 删除分别靠 deadlineTombstones / interviewTombstones 表达。
        // 面经尤其不能走主体那套整条覆盖：电脑记了一条、手机也记了一条，谁的时间戳新谁赢的话，
        // 另一端刚写的那条就没了。
        deadlines: dls.deadlines,
        deadlineTombstones: dls.deadlineTombstones,
        history: his.history,
        interviews: ivs.interviews,
        interviewTombstones: ivs.interviewTombstones,
      };
      // 本地补了远端没有的东西 → 把记录时间戳顶新，下一次同步把这份并集推回服务端。
      // 不顶的话服务端永远只存「赢的那一版」，两端各留各的并集：电脑显示 A+B、手机只显示 B，永不收敛。
      // 顶到 max(现在, 对方 + 1ms)：两端都收敛后没人再补东西 → 不再顶 → 不会来回振荡。
      const missing = dls.missingFrom.b + his.missingFrom.b + ivs.missingFrom.b;
      // 时间戳打平（谁也不比谁新）而主体内容不同：以本地那份为准，并且同样要顶一戳把它送上去 ——
      // 不顶的话这条记录的时间戳不再前进，增量推送永远不会带上它，服务端那份就一直是旧的。
      // 比较时只取"记录主体"：节点/历史/面经有自己的合并与回流（上面那个 missing），
      // updatedAt 是打平的前提（毫秒相等）不参与比较 —— 服务端回传的时间戳是它自己序列化的，
      // 未必与本地那份逐字相同，把它算进去会让每条记录每轮都判"不一样"，互相顶戳没完没了。
      const body = (rec) => {
        const { updatedAt, deadlines, deadlineTombstones, history,
          interviews, interviewTombstones, ...rest } = rec || {};
        return S.canonical(rest);
      };
      const tie = !remoteWins && body(local) !== body(incoming);
      if (missing > 0 || tie) {
        merged.updatedAt = S.nextStamp(remoteWins ? incoming.updatedAt : local.updatedAt);
        stat.pushedBack++;
      }
      // 只有真的变了才落盘：否则每轮同步都会重写一遍 storage（白耗寿命，还会惊动所有面板）
      if (S.canonical(merged) !== S.canonical(local)) {
        data.records[idx] = merged;
        stat.updated++;
      }
    }
    if (tomb) data.tombstones.splice(tIdx, 1);
  }
  // 墓碑清理：超过 90 天的删除记录不再需要（两端都早已同步过）
  const cutoff = Date.now() - 90 * 86400_000;
  data.tombstones = data.tombstones.filter((t) => (Date.parse(t.at) || 0) > cutoff);
  return stat;
}

// ---------- 同步主流程 ----------
/**
 * 跑一轮推拉。合并时若发现远端缺我们这边的东西（截止节点/状态历史），或两端打平却内容不同，
 * 返回的 pushedBack > 0
 * 表示「这轮把本地并集顶新了、待推」—— **调用方要再同步一轮**把它送上去（面板/后台/手机页各有一层这样的循环）。
 * @param {{full?: boolean, reason?: string}} opts full=true 时全量推送（用于「立即同步」与首次同步）
 */
export async function syncNow({ full = false, reason = '' } = {}) {
  const cfg = await loadSync();
  if (!cfg.enabled) return { skipped: true, reason: '未开启云同步' };
  if (!cfg.endpoint || !cfg.token) return { skipped: true, reason: '未配置服务端地址或口令' };
  if (busy) return { skipped: true, reason: '同步中' };
  busy = true;
  try {
    const data = await S.loadData();
    // 号段对账：本机对过的号段落后于 CURSOR_EPOCH 时强制全量拉一轮。
    // 针对的是「服务端号码回退过」的历史遗留（成因见 CURSOR_EPOCH）：那些设备的 lastRev 高于真实号码，
    // 增量拉取永远拉不到回退期间写入的记录，只有 since=0 能把它们捞回来。
    // 对账轮只强制「全量拉」：推集合仍按增量走 —— 服务端对时间戳没变的记录本来就会跳过，
    // 全量推只会把所有 JD 文本白传一遍（记录多时还可能顶到网关的体积上限，那会让同步一直失败）。
    const epoch = Number(cfg.cursorEpoch) || 0;
    const since = (full || epoch < CURSOR_EPOCH) ? 0 : Number(cfg.lastRev) || 0;
    const sinceTime = full ? 0 : (Number(cfg.lastSyncAt) || 0) - 10_000;

    const records = [];
    let bytes = 0, deletes = 0;
    for (const rec of data.records) {
      if ((Date.parse(rec.updatedAt) || 0) < sinceTime) continue;
      bytes += JSON.stringify(rec).length;
      records.push({ id: rec.id, updatedAt: rec.updatedAt, deleted: false, data: rec });
    }
    for (const t of data.tombstones || []) {
      if ((Date.parse(t.at) || 0) < sinceTime) continue;
      // 删除标记也占一个「条目」。界面上必须把这两类分开说（pushedRecords / pushedDeletes），
      // 否则「删掉 5 条测试数据后仍然显示上传 20 条」会被当成没删掉 —— 其实那 5 条就变成了这 5 个标记。
      deletes++;
      records.push({ id: t.id, updatedAt: t.at, deleted: true, data: {} });
    }

    const out = await apiFetch(cfg, '/api/sync', { method: 'POST', body: { since, records } });

    // 先推进本地水位，再落盘数据：避免刚合并回来的远端记录被当作本地变更再推一次
    const syncedAt = Date.now();
    const stat = applyRemoteRecords(data, out.records || []);
    const changed = stat.added + stat.updated + stat.removed > 0;
    if (changed) {
      applying = true;
      try { await S.saveData(data); } finally { setTimeout(() => { applying = false; }, 0); }
    }
    await saveSync({
      lastRev: Number(out.rev) || since,
      lastSyncAt: syncedAt,
      cursorEpoch: CURSOR_EPOCH,
      lastError: null,
      lastErrorAt: null,
      lastErrorCode: null,
      lastResult: {
        at: syncedAt, pushed: records.length, bytes,
        pushedRecords: records.length - deletes, pushedDeletes: deletes, ...stat,
      },
    });
    return {
      ok: true, ...stat, pushed: records.length,
      pushedRecords: records.length - deletes, pushedDeletes: deletes,
      pulled: (out.records || []).length, rev: out.rev,
    };
  } catch (e) {
    const msg = String(e?.message || e);
    // lastErrorCode 是服务端给的机器可读原因（ENROLL / TOKEN / DISABLED / QUOTA）：
    // 面板据此把高亮打到**正确的那一栏**（注册口令 vs 同步口令），不用去正则猜中文文案。
    // 旧版服务端不返回 code → 存 null，面板会退回到文案匹配。
    await saveSync({ lastError: msg, lastErrorAt: Date.now(), lastErrorCode: e?.code ? String(e.code) : null });
    return { ok: false, error: msg, code: e?.code || null };
  } finally {
    busy = false;
  }
}

// ---------- 本地删除 → 墓碑 ----------
export function tombstone(data, id) {
  if (!Array.isArray(data.tombstones)) data.tombstones = [];
  const at = new Date().toISOString();
  const existing = data.tombstones.find((t) => t.id === id);
  if (existing) existing.at = at;
  else data.tombstones.push({ id, at });
  data.records = data.records.filter((r) => r.id !== id);
  return at;
}

// ---------- 设备名（面板展示"上次同步设备"用） ----------
export function deviceName() {
  const ua = navigator.userAgent || '';
  const os = /Mac/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : /Android/i.test(ua) ? 'Android' : '本机';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : '浏览器';
  return `${os} · ${br}`;
}
