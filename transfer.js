// transfer.js — 记录搬迁（导出 JSON / 导入合并）与表格导入
//
// 这个模块只做纯逻辑：不碰 chrome.*、不碰 DOM，因此可以直接在 Node 里跑单测
// （见 tools/test-transfer.mjs）。面板负责把结果落盘与下载。
//
//   一、导入导出：把记录导成 JSON，在另一台机器上导入时**合并**而不是覆盖。
//       合并规则见 mergeImport 的注释（记录级 LWW + 字段补空 + 节点/历史并集 + 同岗位去重）。
//   二、手机日历：**已搬到 calendar-ics.js**（手机端也要导出这份文件，而手机壳子是整份
//       缓存的，不该把本模块与 company-type.js 一起背上去）。本模块只转发那几个名字，
//       dashboard.js 与 tools/test-transfer.mjs 照旧 import 这里。
//   三、表格导入：把飞书 / 腾讯文档 / WPS / Excel 的投递表搬进来。
//
// 注意：服务端那套「日历订阅」用的是另一份实现（server/src/core.js 的 buildIcs）——
// 订阅版输出的是**一份整体日历**，文件版（calendar-ics.js）需要 SEQUENCE/STATUS:CANCELLED
// 这类「更新与撤销」语义，两者刻意分开。
import * as S from './shared.js';
import * as CT from './company-type.js';

export const EXPORT_APP = '投递状态管家';

// ==================== 一、导出 / 导入 ====================

/** 生成导出文件的内容（比裸数据多一段 meta，方便导入时告诉用户"这份来自哪台机器、什么时候"） */
export function exportPayload(data, meta = {}) {
  return {
    app: EXPORT_APP,
    schema: S.SCHEMA_VERSION,
    version: S.APP_VERSION,
    exportedAt: new Date(meta.now || Date.now()).toISOString(),
    device: meta.device || '',
    records: data?.records || [],
    tombstones: data?.tombstones || [],
  };
}

// 规范化：把外部（可能是旧版本导出的、手改过的）记录整成内部形状。
// 未知字段原样保留（{...raw}）——将来加字段时老版本导入不会把它吃掉。
function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function isoish(...cands) {
  for (const c of cands) {
    const t = Date.parse(c);
    if (t) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

export function normalizeDeadline(d) {
  const raw = d && typeof d === 'object' ? d : {};
  const label = str(raw.label).trim() || '截止节点';
  const datetime = str(raw.datetime);
  return {
    ...raw,
    // 没有 id 的老节点要用**内容算出的确定性 id**（S.deadlineId），不能用随机 uid：
    // 同一个老节点在两端各自物化，随机 uid 会给出两个不同的 id，合并时被当成两个节点而重复；
    // 而且每次导入都会重新算一遍，连"同一份文件导入两次结果不变"都做不到。
    // 内容为空（连时间都没有）的节点没有可辨识的内容，退回随机 uid，免得互相撞成一条。
    id: str(raw.id).trim() || (datetime ? S.deadlineId({ label, datetime }) : S.uid()),
    label,
    datetime,
    done: Boolean(raw.done),
    notified24hFor: raw.notified24hFor ?? null,
    notifiedOverdueFor: raw.notifiedOverdueFor ?? null,
  };
}

// 面经 / 复盘条目的规范化。fallbackIso 是所属记录的时间（老条目没有自己的 updatedAt 时退回它）
export function normalizeInterview(raw, fallbackIso) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const stage = str(r.stage).trim() || '其他';
  const at = str(r.at);
  const question = str(r.question);
  return {
    ...r,
    // 没有 id 的老条目要用**内容算出的确定性 id**（S.interviewId），不能用随机 uid ——
    // 理由与老节点完全相同（见 normalizeDeadline）：随机 id 会让同一份文件每导入一次就多一条，
    // 两端也会各自物化出一条。连内容都没有的空壳退回随机 uid，免得互相撞成一条。
    id: str(r.id).trim() || (at || question ? S.interviewId({ stage, at, question }) : S.uid()),
    stage,
    at,
    question,
    review: str(r.review),
    // 条目自己的时间戳缺失时退回所属记录的时间 —— 不要退回「现在」：
    // 那会让同一份文件每导入一次都算出新的时间戳，幂等就没了
    updatedAt: isoish(r.updatedAt, r.at, fallbackIso),
  };
}

export function normalizeRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const updatedAt = isoish(r.updatedAt, r.createdAt, r.appliedAt);
  return {
    ...r,
    id: str(r.id).trim() || S.uid(),
    company: str(r.company),
    position: str(r.position),
    url: str(r.url),
    jd: str(r.jd),
    sourceTitle: str(r.sourceTitle),
    notes: str(r.notes),
    // 企业类型两个字段：原样透传（只 trim），**不往枚举上收敛** ——
    // 用户可以在编辑弹窗里「＋ 自定义」写枚举外的值，收敛会把人家自己写的吃掉。
    // 收敛只发生在自动识别那几层（本地库/规则/模型/表格导入）。
    nature: str(r.nature).trim(),
    industry: str(r.industry).trim(),
    status: S.normalizeStatus(r.status),
    stage: r.stage || null,
    result: r.result || null,
    // 显式空串 = 「就是不知道投递日期」，不要拿 createdAt 兜底成导入时刻（那等于瞎填一个"今天"）。
    // 表格导入认不出投递日期时走的就是这条路（界面上显示「—」，比编个日期诚实）。
    // JSON 备份里不会出现空串（导出的是真实时间戳或 undefined），所以老数据行为不变。
    appliedAt: r.appliedAt === '' ? '' : isoish(r.appliedAt, r.createdAt, updatedAt),
    createdAt: isoish(r.createdAt, r.appliedAt, updatedAt),
    updatedAt,
    deadlines: (Array.isArray(r.deadlines) ? r.deadlines : []).filter((d) => d && typeof d === 'object').map(normalizeDeadline),
    // 空数组也要显式给出来。合并结果一定会带上这个键，若本机这一份没有这个键，
    // 「内容有没有变」的比较就会把「多了个空数组」当成一次真变化 ——
    // 于是同一份表格导入第二次仍会被记成「合并更新」，白顶一次时间戳。
    deadlineTombstones: (Array.isArray(r.deadlineTombstones) ? r.deadlineTombstones : []).filter((t) => t && typeof t === 'object'),
    // 面经同理：两个键都要显式给出来（见上一条注释）
    interviews: (Array.isArray(r.interviews) ? r.interviews : [])
      .filter((x) => x && typeof x === 'object')
      .map((x) => normalizeInterview(x, updatedAt)),
    interviewTombstones: (Array.isArray(r.interviewTombstones) ? r.interviewTombstones : []).filter((t) => t && typeof t === 'object'),
    history: (Array.isArray(r.history) ? r.history : [])
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        ...h,
        at: isoish(h.at, updatedAt),
        from: h.from ? S.normalizeStatus(h.from) : null,
        to: S.normalizeStatus(h.to),
        note: str(h.note),
      })),
  };
}

// 「这条记录变没变」的比较用它；实现放在 shared.js（云同步合并也要用同一份）
export const canonical = S.canonical;

// 去掉时间戳之后的规范形式：判断「内容到底变没变」时用（时间戳本身不算内容变化，见 mergeImport）
function stripStamp(rec) {
  const { updatedAt, ...rest } = rec;
  return canonical(rest);
}

const EMPTY = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

// 字段合并：新版本为准，但它没有的（空/缺失）用旧版本补上 —— 保证"不遗漏"
function mergeFields(winner, loser) {
  const out = { ...winner };
  for (const k of Object.keys(loser)) {
    // 节点/历史/面经/墓碑各自走下面的合并规则，不能在这里整段覆盖
    if (k === 'id' || k === 'updatedAt' || k === 'deadlines' || k === 'history'
      || k === 'deadlineTombstones' || k === 'interviews' || k === 'interviewTombstones') continue;
    if (EMPTY(out[k])) out[k] = loser[k];
  }
  // 轮次/结果只在对应状态下有意义：状态不是"面试中"就不该带轮次（否则并集会复活旧轮次）
  if (out.status !== S.STATUS.INTERVIEW) out.stage = null;
  if (out.status !== S.STATUS.ENDED) out.result = null;
  return out;
}

/**
 * 合并两条"同一岗位"的记录（recordKey 相同）。
 * 身份用 recordKey（链接 + 岗位名），**不是** id ——
 * 两台机器各自新建的同一条投递会有不同的 id，靠 id 判断会变成两条。
 * 合并后保留本机 id：改动 id 会让云同步把这条当成"新记录"再推一次，
 * 服务端上旧 id 的那条又会被拉回来，反而多出一条。
 *
 * 节点与历史走 shared.js 的统一规则（节点级 LWW + 墓碑），与云同步是同一份实现，
 * 否则"导入合并"和"同步合并"会给出两个不同的结果，数据在两套规则之间来回摆动。
 * @returns {{rec: object, idChanged: boolean}}
 */
export function mergeRecords(local, incoming) {
  const lt = Date.parse(local.updatedAt) || 0;
  const it = Date.parse(incoming.updatedAt) || 0;
  const winner = it > lt ? incoming : local;   // 时间相同以本机为准（保证重复导入是幂等的）
  const loser = winner === incoming ? local : incoming;
  const prefer = winner === incoming ? 'b' : 'a';   // 两边都没有节点时间戳时（老备份）以胜者为准
  const merged = mergeFields(winner, loser);
  const dls = S.mergeDeadlineState(local, incoming, { prefer });
  const his = S.mergeHistoryState(local, incoming, { prefer });
  const ivs = S.mergeInterviewState(local, incoming, { prefer });
  merged.deadlines = dls.deadlines;
  merged.deadlineTombstones = dls.deadlineTombstones;
  merged.history = his.history;
  merged.interviews = ivs.interviews;
  merged.interviewTombstones = ivs.interviewTombstones;
  merged.updatedAt = winner.updatedAt;
  merged.id = local.id || incoming.id;
  // 文件给本机带来了原来没有的节点/历史/面经 → 把时间戳顶到「胜者 + 1ms」。
  // 不顶的话这条记录按旧时间戳过不了自动同步的推送水位，导入进来的东西在别的设备上永远看不到。
  // 只在 missingFrom.a > 0（本机确实缺东西）时才顶，所以同一个文件导入第二次不会变（幂等）。
  if (dls.missingFrom.a + his.missingFrom.a + ivs.missingFrom.a > 0) merged.updatedAt = S.nextStamp(winner.updatedAt);
  return { rec: merged, idChanged: merged.id !== incoming.id };
}

/**
 * 记录的身份键里带着链接，于是「本机那条没有链接、表格这一行有链接」会被算成两条记录。
 * 这正是表格导入最容易踩的坑：先导一张没有链接列的表，之后在表里补上链接再导一次，
 * 整库会翻一倍。公司 + 岗位完全一样、只差一个链接时，认成本机那一条（把链接补上）。
 */
function altKeyFor(rec) {
  return rec.url ? S.recordKey({ ...rec, url: '' }) : '';
}

/**
 * 把导入的数据并进本机数据。
 * @returns {{data: object, stats: object}}
 *   stats: added 新增 / updated 合并更新 / unchanged 无变化 / restored 复活（本机曾删除）
 *          / skipped 跳过（无效） / dedupLocal 本机重复岗位被归并 / idDiff 两侧 id 不同（已保留本机 id）
 */
export function mergeImport(local, incoming, { now = Date.now() } = {}) {
  const stats = { added: 0, updated: 0, unchanged: 0, restored: 0, skipped: 0, dedupLocal: 0, idDiff: 0 };
  const src = S.migrateData(incoming);
  const localRecords = Array.isArray(local?.records) ? local.records : [];
  const tombIds = new Set((local?.tombstones || []).map((t) => String(t?.id || '')).filter(Boolean));

  // 本机索引（顺便把本机历史遗留的同岗位重复记录归并掉）
  const byKey = new Map();
  const records = [];
  for (const raw of localRecords) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = normalizeRecord(raw);
    const key = S.recordKey(rec);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, rec); records.push(rec); continue; }
    const { rec: merged } = mergeRecords(prev, rec);
    records[records.indexOf(prev)] = merged;
    byKey.set(key, merged);
    stats.dedupLocal++;
  }

  // 逐条并入
  for (const raw of src.records) {
    if (!raw || typeof raw !== 'object') { stats.skipped++; continue; }
    const inc = normalizeRecord(raw);
    if (!inc.position && !inc.company && !inc.url) { stats.skipped++; continue; }
    const key = S.recordKey(inc);
    const altKey = altKeyFor(inc);           // 键会随「有没有链接」变，见 altKeyFor
    const found = byKey.get(key) ? key : (altKey && byKey.get(altKey) ? altKey : '');
    const cur = found ? byKey.get(found) : undefined;
    if (!cur) {
      byKey.set(key, inc);
      records.push(inc);
      stats.added++;
      if (tombIds.has(inc.id)) stats.restored++;
      continue;
    }
    // 文件里的节点墓碑与面经墓碑都不作为删除令、也不导入 —— 与记录级墓碑同一个道理（见下）：
    // 导入是"恢复/合并"动作，一个旧备份不该删掉本机后来加的节点或面经。
    // 本机的墓碑照样参与裁决：它代表本机真实的删除，不能被一个老备份复活。
    // 两种墓碑都无条件清空（不走 `.length ?` 分支）：少一个分支就少一处漏判。
    const incMerge = { ...inc, deadlineTombstones: [], interviewTombstones: [] };
    const { rec: merged, idChanged } = mergeRecords(cur, incMerge);
    if (idChanged) stats.idDiff++;
    // 「除了时间戳以外没有任何变化」不算一次更新。
    // 表格导入的每一行时间戳都是导入时刻（表为准），若拿它当变化，
    // 同一份表每导一次都会把涉及的记录顶新时间戳，下一次自动同步就把整库（含 JD 全文）重推上云。
    // 内容一致时保留本机那一份（连原时间戳一起），重复导入才是真正幂等的。
    if (stripStamp(merged) === stripStamp(cur)) { stats.unchanged++; continue; }
    // 合并后链接可能是表里那一条、也可能是本机的，键会跟着变 —— 索引按合并结果重挂
    const mergedKey = S.recordKey(merged);
    records[records.indexOf(cur)] = merged;
    byKey.delete(found);
    byKey.set(mergedKey, merged);
    stats.updated++;
    if (tombIds.has(merged.id) || tombIds.has(inc.id)) stats.restored++;
  }

  // 墓碑：只保留"结果里确实没有这条记录"的（导入是合并动作，文件里出现的记录一律视为有效，
  // 否则会出现「导入了备份却恢复不出来」）。文件自带的墓碑不导入——它属于云同步的机制，
  // 文件导入只做记录层面的合并，避免"导入一个旧备份反而删掉了本机的东西"。
  const alive = new Set(records.map((r) => r.id));
  const tombstones = (local?.tombstones || []).filter((t) => t && t.id && !alive.has(String(t.id)));

  return {
    data: { ...local, version: S.SCHEMA_VERSION, records, tombstones, updatedAt: new Date(now).toISOString() },
    stats,
  };
}

// ==================== 二、手机日历（.ics 文件导入） ====================
// 实现搬到了 calendar-ics.js（手机端也要导出这份文件，而手机壳子是整份缓存的，
// 不该把 transfer.js 与 company-type.js 一起背上去）。这里原样转发，
// dashboard.js 与 tools/test-transfer.mjs 的调用点一个字都不用改；
// 两边是不是同一份实现，由 test-transfer 的「同一份实现」断言盯着。
export {
  CALENDAR_NAME, CALENDAR_KEY, ALARMS,
  calendarUid, calendarItems, buildCalendarIcs, diffCalendar, clearCalendar,
} from './calendar-ics.js';

// ==================== 三、表格导入（粘贴 / CSV 文件） ====================
//
// 目标：把飞书 / 腾讯文档 / WPS / Excel 里的投递表搬进来。两条入口：
//   粘贴（主力）：从表格里选中区域复制时，剪贴板里除了纯文本还带一份 text/html —— 一张真正的
//     <table>。单元格边界就是 DOM 结构，于是「引号里的逗号」「格子里换行」「逗号还是分号」
//     「GBK 还是 UTF-8」这些解析层的坑全都不存在。
//   文件（补充）：手上已经有一个 .csv / .tsv 时用它，需要自己嗅探编码与分隔符。
// 两条路最后汇到同一条：rows → headerMapping → tableToRecords → mergeImport（面板负责落盘）。
//
// 语义（用户定的）：每次导入 = 一次全新的覆盖与同步 —— 表里有的以表为准，表里空着的保留本机
// 原来的值，本机没有的算新增。所以这里生成的每条记录时间戳都是「导入时刻」。
// 这一节全是纯函数：不碰 chrome、不碰 DOM（HTML 也是自己扫的，Node 里跑得动、测得动）。

/** 能识别的字段 → 界面上的名字（预览里的列映射下拉与这里共用一份，顺序就是下拉里的顺序） */
export const FIELD_LABELS = {
  company: '公司', position: '岗位', status: '状态', stage: '轮次', result: '结果',
  nature: '企业性质', industry: '行业赛道', typeCell: '企业类型',
  appliedAt: '投递日期', deadline: '截止节点', url: '链接', notes: '备注', jd: '岗位 JD',
};

// 表头别名。本工具自己导出的 10 个表头都在里面（导出→导入要能原样回来），
// 加上飞书/腾讯文档/WPS 常见的叫法与常见的英文列名。
const COLUMN_ALIASES = {
  company: ['公司', '公司名称', '公司名', '企业', '企业名称', '单位', '单位名称', '应聘公司', '投递公司', '雇主', 'company', 'employer'],
  position: ['岗位', '岗位名称', '岗位名', '职位', '职位名称', '应聘岗位', '投递岗位', '招聘岗位', 'position', 'job', 'title', 'role'],
  status: ['状态', '进度', '当前状态', '投递状态', '招聘状态', '进展', 'status', 'progress'],
  stage: ['轮次', '面试轮次', '当前轮次', '面试阶段', '阶段', 'stage', 'round'],
  result: ['结果', '面试结果', '投递结果', '结论', 'result', 'outcome'],
  // 企业类型：两列分开的走性质/行业，合成一列的走 typeCell（导入时按分隔符拆开，逐段比枚举）
  nature: ['企业性质', '性质', '单位性质', '公司性质', '企业所有制', '所有制', 'nature'],
  industry: ['行业赛道', '行业', '赛道', '所属行业', '行业类型', 'industry'],
  typeCell: ['企业类型', '企业标签', '单位类型', '企业分类', 'typecell'],
  appliedAt: ['投递日期', '投递时间', '投递日', '投递于', '申请日期', '申请时间', '日期', 'appliedat', 'applied', 'applydate', 'applieddate'],
  deadline: ['最近截止', '截止', '截止时间', '截止日期', '最近截止时间', '最近截止节点', 'ddl', 'deadline', 'duedate', 'due'],
  url: ['链接', '岗位链接', '投递链接', '职位链接', '招聘链接', '网址', 'url', 'link', 'joblink', 'applylink'],
  notes: ['备注', '备注说明', '备注信息', '说明', '笔记', 'notes', 'note', 'remark', 'memo', 'comment'],
  jd: ['jd', '岗位jd', '职位描述', '岗位描述', '职位详情', '岗位详情', '工作内容', '岗位职责', 'jobdescription', 'description'],
};

// 认得出但**故意不导入**的列（跟「完全不认识」分开提示，用户才知道我们不是漏了）
const IGNORED_HEADERS = new Map([
  ['序号', '辅助列'], ['编号', '辅助列'], ['id', '辅助列'], ['no', '辅助列'], ['行号', '辅助列'], ['index', '辅助列'],
  ['创建时间', '辅助列'], ['创建日期', '辅助列'], ['添加时间', '辅助列'], ['创建人', '辅助列'],
  ['更新时间', '本工具不使用（每次导入都以表格内容为准）'], ['更新日期', '同左'], ['修改时间', '同左'],
  ['最后修改时间', '同左'], ['最近更新', '同左'], ['最后更新', '同左'], ['updatedat', '同左'], ['lastupdated', '同左'],
  ['城市', '工具里没有这一项'], ['地点', '工具里没有这一项'], ['工作地点', '工具里没有这一项'],
  ['薪资', '工具里没有这一项'], ['待遇', '工具里没有这一项'], ['学历', '工具里没有这一项'],
  ['专业', '工具里没有这一项'], ['渠道', '工具里没有这一项'], ['来源', '工具里没有这一项'],
  // 面经列是我们自己导出的（给人看），但**故意不回读**：一条记录可能有好几条面经，
  // 一列文字表达不了"哪条对应哪条"，硬解析只会让"以表为准"把本机的面经覆盖掉。
  // 登记在这里而不是让它落进"未识别"，用户才知道我们不是漏了。
  ['面经', '只导出不导入（一条记录可能有多条），完整搬迁请用「导出 JSON」'],
  ['面试记录', '同左'], ['面经复盘', '同左'], ['面试题', '同左'],
]);

export const MAX_TABLE_ROWS = 5000;    // 面板据此提示用户分批
const HARD_MAX_ROWS = 50000;           // 解析层的硬上限：防一次粘贴几十万行把页面卡死

// ---------- 文本 / 字节 → 二维数组 ----------

/** 文件字节 → 文本。UTF-8（严格）→ GB18030 → 非严格 UTF-8，永不抛 */
export function decodeTableBytes(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  const at = (...sig) => sig.every((b, i) => bytes.length > i && bytes[i] === b);
  if (typeof TextDecoder === 'undefined') {
    // 理论上到不了这里（Chrome 与 Node 18+ 都有 TextDecoder）。真遇到就按字节直出，至少不崩
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return { text: s, encoding: '未知', suspect: false };
  }
  const dec = (enc, data) => { try { return new TextDecoder(enc).decode(data); } catch { return null; } };
  if (at(0xEF, 0xBB, 0xBF)) return { text: dec('utf-8', bytes.subarray(3)) ?? '', encoding: 'UTF-8（含 BOM）', suspect: false };
  if (at(0xFF, 0xFE)) return { text: dec('utf-16le', bytes.subarray(2)) ?? '', encoding: 'UTF-16LE', suspect: false };
  if (at(0xFE, 0xFF)) return { text: dec('utf-16be', bytes.subarray(2)) ?? '', encoding: 'UTF-16BE', suspect: false };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8', suspect: false };
  } catch { /* 不是合法 UTF-8，往下试 */ }
  // 中文 Windows 上 Excel「另存为 CSV」默认就是 GBK 系。
  // 用 gb18030 而不是 gbk：它是 GBK 的超集，生僻字不会解成 U+FFFD。
  const gbk = dec('gb18030', bytes);
  if (gbk != null) return { text: gbk, encoding: 'GB18030（GBK）', suspect: gbk.includes('�') };
  return { text: dec('utf-8', bytes) ?? '', encoding: '未知', suspect: true };
}

// 数一行里有几个「引号外的」分隔符
function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { i++; continue; }
      q = !q;
      continue;
    }
    if (!q && ch === d) n++;
  }
  return n;
}

/**
 * 猜分隔符：看前几行里**哪一个分隔符切出来的列数最一致**，而不是谁出现得多。
 * 表头里带逗号（"字节跳动, 北京"）时，「数个数」会误判，一致性不会。
 * 并列时按 Tab → 逗号 → 分号 → 竖线 取（TSV 的列数通常最多也最齐）。
 */
export function detectDelimiter(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (!lines.length) return ',';
  let best = ',', bestScore = 0;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const k = Math.max(...counts);
    if (k < 1) continue;
    // 至少两行（或只有一行时该行本身）列数一致才算数
    if (counts.filter((c) => c === k).length < Math.min(2, lines.length)) continue;
    if (k > bestScore) { best = d; bestScore = k; }
  }
  return best;
}

// 导出时以 = + - @ Tab CR 开头的值会被加一个 ' 前缀（防 Excel 公式注入），回读时去掉。
// 只在「' + 这几个字符」的组合下去，用户自己写的前导 ' 不会被误吃。
function unescapeCell(v) {
  const s = String(v ?? '');
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

/**
 * RFC4180 风格解析（引号包住的逗号/换行、"" 转义、CRLF/LF 混排、BOM）。
 * 容错优先：宁可多认一行，也不因为一个畸形的引号把整份文件判失败。
 * @returns {{rows:string[][], delimiter:string, blankRows:number, truncated:number}}
 */
export function parseDelimited(text, { delimiter, maxRows = HARD_MAX_ROWS } = {}) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [], cell = '', inQ = false, blankRows = 0, truncated = 0;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => {
    // 整行都是空的（Excel 另存 CSV 常在末尾拖一片空行）不算数据行
    if (row.length === 1 && row[0].trim() === '') blankRows++;
    else if (rows.length < maxRows) rows.push(row.map(unescapeCell));
    else truncated++;
    row = [];
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { inQ = true; i++; continue; }
    if (ch === d) { endCell(); i++; continue; }
    // 换行前必须先把手上这格收尾，否则最后一个字段会粘到下一行的第一格上
    if (ch === '\r') { if (src[i + 1] === '\n') i++; endCell(); endRow(); i++; continue; }
    if (ch === '\n') { endCell(); endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { endCell(); endRow(); }
  return { rows, delimiter: d, blankRows, truncated };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
    }
    const k = name.toLowerCase();
    return k in ENTITIES ? ENTITIES[k] : m;
  });
}

// 单元格内的 HTML → 文本：<br> 与块级标签的收尾当换行（JD 里很常见），其余标签只取文字
function cellHtmlToText(h) {
  return decodeEntities(String(h)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 剪贴板里的 text/html → 二维数组。
 * 自己扫而不用 DOMParser：Node 里没有 DOMParser，用 DOM 就等于这段逻辑只能在浏览器里测；
 * 输入是表格软件复制出来的规整 HTML，正则扫描足够，而且两条入口共用一份实现。
 * @returns {{rows:string[][], truncated:number}|null}
 */
export function tableFromHtml(html, { maxRows = HARD_MAX_ROWS } = {}) {
  const src = String(html || '');
  if (!src) return null;
  // 取「行数最多的那张表」：粘贴板里常带装饰表/嵌套表
  const tables = src.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = null, bestN = 0;
  for (const t of tables) {
    const rows = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = [];
      for (const m of tr.matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi)) {
        // 合并单元格铺成 N 个格子：宁可留空，也不能让后面的列整体错位
        const span = Math.max(1, Number((m[2].match(/colspan\s*=\s*"?(\d+)/i) || [])[1]) || 1);
        cells.push(cellHtmlToText(m[3]));
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.some((c) => c !== '')) rows.push(cells);
    }
    if (rows.length > bestN) { best = rows; bestN = rows.length; }
  }
  if (!best) return null;
  const truncated = Math.max(0, best.length - maxRows);
  return { rows: best.slice(0, maxRows), truncated };
}

/**
 * 粘贴内容 → 行。优先走 HTML 表格（单元格边界是结构，最稳），没有就退回纯文本（通常是 TSV）。
 * @returns {{rows, source, truncated, blankRows, delimiter?, error?}}
 */
export function readTableFromPaste({ html, text } = {}) {
  const t = tableFromHtml(html);
  if (t && t.rows.length) {
    return { rows: t.rows, source: 'html', truncated: t.truncated, blankRows: 0 };
  }
  const p = parseDelimited(String(text || ''));
  if (p.rows.length) {
    return { rows: p.rows, source: 'text', truncated: p.truncated, blankRows: p.blankRows, delimiter: p.delimiter };
  }
  return { rows: [], source: 'empty', truncated: 0, blankRows: p.blankRows, error: '剪贴板里没有可识别的表格。请在表格软件里选中区域（连表头一起）再复制。' };
}

// Excel 的 .xlsx 是 zip（PK\x03\x04），老的 .xls 是 OLE2 复合文档。
// 认出来直接说人话，别让用户对着「一个表头都没认出来」猜 —— 拖进来的十有八九是这个。
function binaryOfficeKind(b) {
  const at = (...sig) => sig.every((v, i) => b[i] === v);
  if (!b || b.length < 8) return '';
  if (at(0x50, 0x4B, 0x03, 0x04) || at(0x50, 0x4B, 0x05, 0x06) || at(0x50, 0x4B, 0x07, 0x08)) return 'xlsx';
  if (at(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)) return 'xls';
  return '';
}

/** 文件字节 → 行（含编码与分隔符） */
export function readTableFromBytes(bytes, opts = {}) {
  const kind = binaryOfficeKind(bytes);
  if (kind) {
    return {
      rows: [], source: 'file', encoding: '', delimiter: '', blankRows: 0, truncated: 0,
      error: kind === 'xlsx'
        ? '这是 Excel 的 .xlsx 文件（二进制格式，本工具不读）。请在 Excel / WPS 里「另存为 CSV」，或者更省事：在表格里选中区域（连表头一起）复制，回到这里直接粘贴。'
        : '这是老版 Excel 的 .xls 文件（二进制格式，本工具不读）。请在 Excel 里「另存为 CSV」，或者选中区域复制后粘贴到这里。',
    };
  }
  const { text, encoding, suspect } = decodeTableBytes(bytes);
  const p = parseDelimited(text, opts);
  return { rows: p.rows, encoding, suspect, delimiter: p.delimiter, blankRows: p.blankRows, truncated: p.truncated, source: 'file' };
}

// ---------- 日期 ----------

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);   // Excel 序列号原点（已吸收「1900 是闰年」那个老 bug）

// 本地时区构造 + 回读校验（挡掉 2026-02-30 这种「构造得出来但不是那个日期」的输入）
function makeLocal(y, mo, da, h, mi) {
  if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return null;
  const dt = new Date(y, mo - 1, da, h, mi, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== da) return null;
  if (dt.getHours() !== h || dt.getMinutes() !== mi) return null;
  return dt.getTime();
}

/**
 * 解析表格里的日期/时间格子。认不出来就返回 null（**不瞎猜**），由界面提示用户改表格。
 * 为什么不用 Date.parse：`Date.parse('01-15 23:59')` 会静默变成 2001 年，而
 * 「09-24 18:11」正是本工具自己 fmtDateTime 输出的形状；`new Date('2026-03-01')` 按 UTC 解，
 * 东八区会显示成 08:00。所以一律自己按**本地时区**构造。
 * @param {string} v 原始格子内容
 * @param {{mode?:'datetime'|'deadline'}} opts deadline 模式：只有日期没时刻时补 23:59（补 00:00
 *   会让节点当天零点就显示「已过期」）；datetime 模式（投递日期）补 00:00，且不会落在未来。
 * @returns {{iso:string|null, reason:string}}
 */
export function parseTableDate(v, { mode = 'datetime' } = {}) {
  const raw = String(v ?? '').trim();
  if (!raw) return { iso: null, reason: '空值' };
  const fail = { iso: null, reason: '认不出这个写法' };
  const defH = mode === 'deadline' ? 23 : 0;
  const defM = mode === 'deadline' ? 59 : 0;
  let m;

  // 1) 纯数字：Excel 序列号 / Unix 时间戳。不属于这两种的数（年份、序号）不算日期，继续往下走
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (n >= 20000 && n <= 80000) {           // ≈1954–2119 年
      const dt = new Date(EXCEL_EPOCH + Math.round(n * 86400000));
      // 序列号是「不带时区的天数」，按 UTC 取出年月日再当本地时刻重建，否则整批日期会漂 8 小时
      const t = makeLocal(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(),
        n % 1 ? dt.getUTCHours() : defH, n % 1 ? dt.getUTCMinutes() : defM);
      if (t) return { iso: new Date(t).toISOString(), reason: '' };
    } else if (n >= 1e9 && n <= 4e9) {        // Unix 秒（2001–2096）
      return { iso: new Date(n * 1000).toISOString(), reason: '' };
    } else if (n >= 1e12 && n <= 4e12) {      // Unix 毫秒
      return { iso: new Date(n).toISOString(), reason: '' };
    }
  }

  // 2) ISO 8601（带 T 与 Z / 毫秒）交给 Date：它的时区信息是明确的，不需要我们补
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    const t = Date.parse(raw);
    if (t) return { iso: new Date(t).toISOString(), reason: '' };
  }

  // 3) 年月日：2026-03-01 / 2026/3/1 / 2026.3.1 / 2026年3月1日（可跟 23:59 或 23:59:00）
  // 注意 `(?:\s*日)?` 这个写法：空格必须圈在「日」这一组里面。写成 `\s*日?` 的话，
  // 「2026/3/1 8:05」里的空格会被 \s* 先吃掉，后面的时刻就再也匹配不上，时间被悄悄丢掉。
  m = raw.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?(?:[\sT]+(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?)?/);
  if (m) {
    const t = makeLocal(+m[1], +m[2], +m[3], m[4] ? +m[4] : defH, m[5] ? +m[5] : defM);
    return t ? { iso: new Date(t).toISOString(), reason: '' } : fail;
  }

  // 4) 连写：20260301
  m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const t = makeLocal(+m[1], +m[2], +m[3], defH, defM);
    return t ? { iso: new Date(t).toISOString(), reason: '' } : fail;
  }

  // 5) 只有月日：3月1日 / 3-1 / 3.1（可跟时刻）
  m = raw.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[\sT]+(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?)?$/);
  if (m) {
    const mo = +m[1], da = +m[2];
    const h = m[3] ? +m[3] : defH, mi = m[4] ? +m[4] : defM;
    const now = Date.now();
    const y0 = new Date().getFullYear();
    const cands = [y0 - 1, y0, y0 + 1].map((y) => makeLocal(y, mo, da, h, mi)).filter((t) => t != null);
    if (!cands.length) return fail;
    // 投递日期不可能落在将来（8 月看到「9-24」多半是去年的 9 月 24 日）；
    // 截止时间可以是将来的（12 月看到「1-5」= 明年 1 月 5 日）。
    const pool = mode === 'deadline' ? cands : cands.filter((t) => t <= now + 86400000);
    // 取离现在最近的那一年
    const best = (pool.length ? pool : cands).reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
    return { iso: new Date(best).toISOString(), reason: '' };
  }

  return fail;
}

// 「最近截止」格子的形状：本工具导出的是「笔试截止 2026-09-25 23:59」（标签里可能带空格），
// 别的软件可能只写一个时间。从右往左切：末尾那段能当日期解析的就是时间，剩下的是标签。
function parseDeadlineCell(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const tail = /(\d{4}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}日?|\d{1,2}[-/.月]\s*\d{1,2}日?|\d{8}|\d+(?:\.\d+)?)(?:[\sT]+\d{1,2}[:：]\d{1,2}(?::\d{1,2})?)?$/;
  const m = s.match(tail);
  if (m && m.index > 0) {
    const t = parseTableDate(m[0].trim(), { mode: 'deadline' });
    if (t.iso) return { label: s.slice(0, m.index).trim() || '截止', datetime: t.iso };
  }
  const t = parseTableDate(s, { mode: 'deadline' });
  return t.iso ? { label: '截止', datetime: t.iso } : null;
}

// ---------- 表头 → 列映射 ----------

// 表头归一化：去空白 → 全角转半角 → 去括号冒号星号 → 小写
function normHeader(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s ]+/g, '')
    .replace(/[（）()【】[\]:：*＊.。]/g, '')
    .toLowerCase();
}

function aliasHit(name) {
  const n = normHeader(name);
  if (!n) return '';
  for (const f of Object.keys(COLUMN_ALIASES)) {
    if (COLUMN_ALIASES[f].some((a) => normHeader(a) === n)) return f;
  }
  return '';
}

// 表头在第几行：前 5 行里挑「别名命中最多」的那一行（飞书/WPS 导出的常带一行大标题）。
// 一行都没命中就按第 0 行算，由界面提示用户「请连表头一起复制」。
function findHeaderRow(rows) {
  let best = 0, bestScore = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const score = (rows[i] || []).filter((c) => aliasHit(c)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

/**
 * 把表头行映射成「第几列是什么字段」。
 * @returns {{headerRow:number, columns:{index:number,header:string,field:string}[],
 *            ignored:{index:number,header:string,reason:string}[], recognized:boolean}}
 */
export function headerMapping(rows, { headerRow } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const pick = headerRow == null ? findHeaderRow(list) : headerRow;
  const header = list[pick] || [];
  const columns = [], ignored = [];
  const taken = new Set();
  header.forEach((raw, index) => {
    const header2 = String(raw ?? '').trim();
    const field = aliasHit(header2);
    if (field && !taken.has(field)) {          // 同一字段命中多列时取最左那列
      taken.add(field);
      columns.push({ index, header: header2, field });
      return;
    }
    const known = IGNORED_HEADERS.get(normHeader(header2));
    ignored.push({ index, header: header2, reason: known || '未识别' });
  });
  return { headerRow: pick, columns, ignored, recognized: columns.length > 0 };
}

// ---------- 行 → 记录 ----------

/** 本机记录按 recordKey 建索引（表格只认「同链接 + 同岗位」，与合并引擎同一个键） */
export function indexByKey(data) {
  const m = new Map();
  for (const r of (data?.records || [])) {
    if (!r || typeof r !== 'object') continue;
    const k = S.recordKey(r);
    if (!m.has(k)) m.set(k, r);
  }
  return m;
}

function tally(map, key) { map.set(key, (map.get(key) || 0) + 1); }

/**
 * 表格行 → 记录（还没落库；交给 mergeImport 合并）。
 * 「表里没说」的字段一律留空，交给合并引擎用本机的值补上；
 * 新增的记录才填默认值（状态默认「筛选中」），否则表格的空状态会盖掉本机的进度。
 * @param {string[][]} rows
 * @param {{columns, headerRow, localByKey?:Map, now?:number}} opts
 */
export function tableToRecords(rows, { columns = [], headerRow = 0, localByKey = null, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const stamp = new Date(now).toISOString();
  const fieldAt = new Map();
  for (const c of columns) if (!fieldAt.has(c.field)) fieldAt.set(c.field, c.index);
  const headOf = new Map(columns.map((c) => [c.field, c.header]));

  const out = [];
  const unknownStatus = new Map();
  const badDates = new Map();
  const badTypes = new Map();
  const seen = new Set();
  let newCount = 0, mergeCount = 0, skipCount = 0, dupRows = 0, droppedDeadlines = 0;

  for (let i = headerRow + 1; i < list.length; i++) {
    const row = list[i] || [];
    const cell = (field) => {
      const idx = fieldAt.get(field);
      return idx == null ? '' : String(row[idx] ?? '').trim();
    };
    const company = cell('company'), position = cell('position'), url = cell('url');
    if (!company && !position && !url) { skipCount++; continue; }   // 与 mergeImport 同一条跳过规则

    const key = S.recordKey({ url, position, company });
    // 预览里的「新增 / 覆盖本机」必须和 mergeImport 认出的是同一条，否则预览说新增、落盘却是覆盖
    const altKey = altKeyFor({ url, position, company });
    const local = !localByKey ? undefined
      : (localByKey.get(key) || (altKey ? localByKey.get(altKey) : undefined));
    const isNew = !local;
    if (seen.has(key)) dupRows++; else seen.add(key);

    // 状态：状态 / 轮次 / 结果 三列合成一个三元组
    const tri = (field) => (cell(field) ? S.parseStatusCell(cell(field)) : null);
    const st = tri('status'), sg = tri('stage'), rs = tri('result');
    let status = (st && st.status) || (sg && sg.status) || (rs && rs.status) || '';
    let stage = (st && st.stage) || (sg && sg.stage) || null;
    let result = (st && st.result) || (rs && rs.result) || null;
    const unknown = [];
    for (const [raw, t] of [[cell('status'), st], [cell('stage'), sg], [cell('result'), rs]]) {
      if (raw && !t.status) { unknown.push(raw); tally(unknownStatus, raw); }
    }
    if (!status && isNew) status = S.STATUS.SCREENING;   // 新增的默认；合并时空着 = 保留本机进度
    // 引擎不变量：轮次只在「面试中」、结果只在「已结束」下有意义
    if (status !== S.STATUS.INTERVIEW) stage = null;
    if (status !== S.STATUS.ENDED) result = null;

    // 投递日期：认不出来就留空（normalizeRecord 有「显式空串 = 故意留空」的例外）。
    // 本机已有的记录空着 = 不覆盖 → 保留本机原来的日期。
    const appliedRaw = cell('appliedAt');
    const applied = appliedRaw ? parseTableDate(appliedRaw, { mode: 'datetime' }) : { iso: null };
    if (appliedRaw && !applied.iso) tally(badDates, `${headOf.get('appliedAt') || '投递日期'}=${appliedRaw}`);

    // 截止节点：表格里没有节点 id，只能给出「名称 + 时间」，尽量对齐本机已有的同名节点
    const deadlines = [];
    const dlRaw = cell('deadline');
    if (dlRaw) {
      const parsed = parseDeadlineCell(dlRaw);
      // 补齐成完整节点形状（含 done / notified24hFor 这些键）：
      // 节点级 LWW 可能选中表格这一版，缺键的节点会顺手把本机的提醒簿记抹掉，
      // 也会让「内容有没有变」的比较把「少几个空键」当成一次真变化。
      const node = parsed ? normalizeDeadline(parsed) : null;
      if (node) {
        const mine = (local?.deadlines || []);
        const alive = mine.filter((d) => !d.done && d.label === node.label);
        const doneSame = mine.filter((d) => d.done && d.label === node.label);
        if (doneSame.length && !alive.length) {
          // 本机已经把这个节点做完了，表格里还挂着它 → 不再导进来（否则等于把「已完成」抹掉）
          droppedDeadlines++;
        } else {
          // 只有一个同名存活节点时沿用它的 id：否则每次导入都会多出一个重复节点
          // （面板里手动加的节点 id 是随机 uid，跟内容算出来的 id 对不上）
          if (alive.length === 1) node.id = alive[0].id;
          deadlines.push(node);
        }
      } else {
        tally(badDates, `${headOf.get('deadline') || '截止节点'}=${dlRaw}`);
      }
    }

    // 企业类型：能拆出来的认，拆不出来的**整段丢掉并报给用户看**（认不出不瞎猜）。
    // 表里根本没这两列时 cell() 返回空串 = 「表里没说」，合并时保留本机的值。
    const natureRaw = cell('nature'), industryRaw = cell('industry'), typeRaw = cell('typeCell');
    let nature = natureRaw ? CT.normalizeTypeValue('nature', natureRaw) : '';
    let industry = industryRaw ? CT.normalizeTypeValue('industry', industryRaw) : '';
    if (natureRaw && !nature) tally(badTypes, natureRaw);
    if (industryRaw && !industry) tally(badTypes, industryRaw);
    if (typeRaw) {
      const split = CT.splitTypeCell(typeRaw);
      // 合成列只补分开的两列没给出的那一半（同时存在时以「企业性质/行业」两列为准）
      if (!nature) nature = split.nature;
      if (!industry) industry = split.industry;
      if (!split.nature && !split.industry) tally(badTypes, typeRaw);
    }

    // 备注：合并时原样用表里的（空着就保留本机的）；新增时若状态词没认出来，把原词附在备注里，别丢
    let notes = cell('notes');
    if (isNew && unknown.length) notes = [notes, `状态：${unknown.join('、')}`].filter(Boolean).join('\n');

    if (isNew) newCount++; else mergeCount++;
    out.push({
      company, position, url, jd: cell('jd'), notes, status, stage, result, nature, industry,
      // 「创建时间」表格里没有，但也不能让它跟着导入时刻走：本机这条是 3 月建的，
      // 每次导入都把创建时间改成今天，就等于每导一次都白改一次这条记录（还会白顶一次时间戳）。
      createdAt: isNew ? '' : local.createdAt,
      appliedAt: applied.iso || '',
      updatedAt: stamp,                                    // 表为准：导入时刻必胜
      deadlines,
      // 新增的记录补一条历史（合并的空历史不参与并集，不会动本机的历史）
      history: isNew ? [{ at: applied.iso || stamp, from: null, to: status || S.STATUS.SCREENING, note: '表格导入' }] : [],
    });
  }

  return {
    records: out,
    newCount, mergeCount, skipCount, dupRows, droppedDeadlines,
    unknownStatus: [...unknownStatus.entries()].map(([word, count]) => ({ word, count })),
    badDates: [...badDates.entries()].map(([value, count]) => ({ value, count })),
    badTypes: [...badTypes.entries()].map(([value, count]) => ({ value, count })),
  };
}

// ---------- 导出 CSV（面板顶栏「导出 CSV」用它；表头与 COLUMN_ALIASES 对得上，能原样导回来） ----------

export const CSV_COLUMNS = ['公司', '岗位', '状态', '轮次', '结果', '企业性质', '行业赛道', '投递日期', '最近截止', '链接', '备注', '面经', 'JD'];

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 防公式注入
  return '"' + s.replace(/"/g, '""') + '"';
}

// 导出里必须带年份：S.fmtDateTime 输出的是「09-24 18:11」，回读时没有年份只能靠猜（会变成 2001 年）。
// 用本地时区拼，与手机/面板看到的时间一致。
export function csvStamp(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 面经列：人类可读（Excel 里要开"自动换行"才会展开多行）。
// 导入侧**故意不解析**这一列（见 IGNORED_HEADERS），所以这里怎么排都不影响往返。
// 每条复盘截到 2000 字：Excel 单个单元格上限 32767 字符，不截会让整行读不出来。
const CSV_IV_MAX = 2000;
export function interviewCell(r) {
  return (r.interviews || []).slice()
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .map((iv) => [
      `【${iv.stage || '其他'}】${S.fmtDate(iv.at)}`,
      iv.question ? `题目：${iv.question}` : '',
      iv.review
        ? `复盘：${iv.review.length > CSV_IV_MAX ? iv.review.slice(0, CSV_IV_MAX) + '…（已截断，完整内容见 JSON 备份）' : iv.review}`
        : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

/** 记录 → CSV 文本（含 BOM 与 CRLF，Excel 双击打开不乱码） */
export function buildCsv(records) {
  const rows = (records || []).map((r) => {
    const nd = S.nextDeadline(r);
    return [
      r.company, r.position, r.status, r.stage || '', r.result || '',
      r.nature || '', r.industry || '',
      csvStamp(r.appliedAt),
      nd ? `${nd.label} ${csvStamp(nd.datetime)}` : '',
      r.url, r.notes || '', interviewCell(r), r.jd || '',
    ];
  });
  return '﻿' + [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
