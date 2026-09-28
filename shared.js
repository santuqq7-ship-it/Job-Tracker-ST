// shared.js — popup / dashboard / background 共用的数据层与工具函数（ES Module）

export const APP_VERSION = '1.18.2';
export const SCHEMA_VERSION = 6;
export const STORAGE_KEY = 'jobTracker';

// ---------- 状态枚举 ----------
// 已投递已并入筛选中：投递即进入筛选流程
export const STATUS = {
  SCREENING: '筛选中',
  ASSESSMENT: '测评中',
  WRITTEN: '笔试中',
  INTERVIEW: '面试中',
  OFFER: 'Offer已发',
  ENDED: '已结束',
  PENDING: '待确认',
};
export const STATUS_LIST = Object.values(STATUS);

// 面试轮次（status === 面试中 时有效）
export const STAGES = ['未定', '一面', '二面', '三面', '四面', '群面', 'HR面', '终面'];
// 结束结果（status === 已结束 时有效）
export const RESULTS = ['拒绝', '放弃', '其他'];

// 面经条目的轮次：面试轮次（STAGES）之外还要能记笔试与测评 —— 它们不是"面试中"的轮次，
// 而是独立的状态，所以不能直接复用 STAGES。用派生写法而不是手抄一份，
// 将来往 STAGES 里加轮次（如「加面」）时这里不会漂移。顺序即下拉里的顺序：笔试/测评在前，
// 面试轮次居中，未定/其他收尾。
export const INTERVIEW_STAGES = ['笔试', '测评', ...STAGES.filter((s) => s !== '未定'), '未定', '其他'];

// "进行中"集合：badge 计数与筛选 chip 使用
export const ACTIVE_STATUSES = [
  STATUS.SCREENING, STATUS.ASSESSMENT,
  STATUS.WRITTEN, STATUS.INTERVIEW, STATUS.PENDING,
];

// 状态 pill 配色（前景 / 背景）—— 深色魔幻主题适配
const STATUS_COLORS = {
  [STATUS.SCREENING]: ['#7FB3FF', 'rgba(59,130,246,.22)'],  // 蓝
  [STATUS.ASSESSMENT]: ['#FFD76E', 'rgba(245,158,11,.20)'], // 琥珀
  [STATUS.WRITTEN]: ['#FFD76E', 'rgba(245,158,11,.20)'],    // 琥珀
  [STATUS.INTERVIEW]: ['#C9B3FF', 'rgba(139,92,246,.30)'],  // 紫
  [STATUS.OFFER]: ['#7CE8B4', 'rgba(16,185,129,.22)'],      // 绿
  [STATUS.ENDED]: ['#FF9E9E', 'rgba(239,68,68,.20)'],       // 红
  [STATUS.PENDING]: ['#D8BFFF', 'rgba(139,92,246,.24)'],    // 紫
};
export function statusColor(status) {
  return STATUS_COLORS[status] || ['#6B7280', '#F3F4F6'];
}

// 状态切换 → 建议添加的截止节点 label
export const STATUS_DEADLINE_HINTS = {
  [STATUS.ASSESSMENT]: '测评截止',
  [STATUS.WRITTEN]: '笔试截止',
  [STATUS.INTERVIEW]: '面试时间',
  [STATUS.OFFER]: 'Offer答复截止',
};

// ---------- 存储 ----------
// 迁移框架：未来 schema 变更在此登记（MIGRATIONS[n]: n → n+1）
// v1 → v2：把旧版进度表/其他工具的常见状态写法归一化到本工具状态体系
const LEGACY_STATUS_MAP = {
  '待投递': [STATUS.SCREENING, null, null],
  '简历已投递': [STATUS.SCREENING, null, null],
  '投递成功': [STATUS.SCREENING, null, null],
  '新投递': [STATUS.SCREENING, null, null],
  '已投递': [STATUS.SCREENING, null, null],
  '简历筛选中': [STATUS.SCREENING, null, null],
  '简历筛选': [STATUS.SCREENING, null, null],
  '测评': [STATUS.ASSESSMENT, null, null],
  '评估中': [STATUS.ASSESSMENT, null, null],
  '待笔试': [STATUS.WRITTEN, null, null],
  '笔试': [STATUS.WRITTEN, null, null],
  '面试': [STATUS.INTERVIEW, null, null],
  '一面': [STATUS.INTERVIEW, '一面', null],
  '二面': [STATUS.INTERVIEW, '二面', null],
  '三面': [STATUS.INTERVIEW, '三面', null],
  'HR面': [STATUS.INTERVIEW, 'HR面', null],
  'Offer': [STATUS.OFFER, null, null],
  '拒绝': [STATUS.ENDED, null, '拒绝'],
  '放弃': [STATUS.ENDED, null, '放弃'],
  '暂缓': [STATUS.PENDING, null, null],
  // 下面这些来自「别的软件/自己记的表格」里更口语的写法（表格导入用）。
  // 加在这里而不是各写一份：normalizeStatus 与表格导入共用同一张表，不会漂移。
  '待面试': [STATUS.INTERVIEW, null, null],
  '约面': [STATUS.INTERVIEW, null, null],
  '面试邀约': [STATUS.INTERVIEW, null, null],
  '收到offer': [STATUS.OFFER, null, null],
  '已offer': [STATUS.OFFER, null, null],
  '已挂': [STATUS.ENDED, null, '拒绝'],
  '挂了': [STATUS.ENDED, null, '拒绝'],
  '凉了': [STATUS.ENDED, null, '拒绝'],
  '已拒': [STATUS.ENDED, null, '拒绝'],
  '被拒': [STATUS.ENDED, null, '拒绝'],
  '未通过': [STATUS.ENDED, null, '拒绝'],
  '人才库': [STATUS.ENDED, null, '拒绝'],
  '已终止': [STATUS.ENDED, null, '拒绝'],
  '流程终止': [STATUS.ENDED, null, '拒绝'],
};

const NO_TRI = { status: null, stage: null, result: null };

// 查一个状态词。三级宽容：原样 → 去掉所有空白 → 纯 ASCII 忽略大小写（offer / OFFER / Offer）
function lookupStatusWord(s) {
  const direct = LEGACY_STATUS_MAP[s];
  if (direct) return direct;
  const tight = s.replace(/\s+/g, '');
  if (tight !== s && LEGACY_STATUS_MAP[tight]) return LEGACY_STATUS_MAP[tight];
  if (/^[\x21-\x7E]+$/.test(s)) {
    const lower = s.toLowerCase();
    for (const [k, v] of Object.entries(LEGACY_STATUS_MAP)) {
      if (/^[\x21-\x7E]+$/.test(k) && k.toLowerCase() === lower) return v;
    }
  }
  return null;
}

// 把一个格子里的状态写法拆成三元组 { status, stage, result }。
// 只回 status 是不够的：「一面 / 二面 / HR面」是轮次、「拒绝 / 放弃」是结果，
// 丢掉它们等于把用户表格里的信息扔了（而 status 本身还是「面试中」）。
// 表格导入用它；normalizeStatus 是它的薄封装（只关心 status 的老调用方行为不变）。
export function parseStatusCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ...NO_TRI };
  const hit = lookupStatusWord(s);
  if (hit) return { status: hit[0], stage: hit[1] || null, result: hit[2] || null };
  if (STATUS_LIST.includes(s)) return { status: s, stage: null, result: null };
  if (STAGES.includes(s)) return { status: STATUS.INTERVIEW, stage: s, result: null };
  if (RESULTS.includes(s)) return { status: STATUS.ENDED, stage: null, result: s };
  // 复合写法：「面试中-一面」「已结束（拒绝）」「面试中 / 二面」
  const parts = s.split(/[\s\-—–/|·,，、;；()（）【】[\]]+/).filter(Boolean);
  if (parts.length > 1) {
    const out = { ...NO_TRI };
    for (const p of parts) {
      const r = parseStatusCell(p);   // 段里已无分隔符，深度至多一层
      if (!out.status && r.status) out.status = r.status;
      if (!out.stage && r.stage) out.stage = r.stage;
      if (!out.result && r.result) out.result = r.result;
    }
    if (out.status) return out;
  }
  return { ...NO_TRI };
}

// 归一化任意旧状态写法（导入时用）：只取状态，不认得的原样返回
export function normalizeStatus(s) {
  const { status } = parseStatusCell(s);
  return status ?? s;
}

// 是否像公司名（标题/关键词信号判定用，popup 与解析共用）
export function looksLikeCompany(seg, knownCompanies = []) {
  return isCompanyLike(seg, knownCompanies);
}

// ---------- 从投递链接提取公司 ----------
// 常见 ATS 租户路径 + 品牌域名词典（域名关键词 → 中文公司名）
const BRAND_MAP = [
  ['字节跳动', ['bytedance']], ['腾讯', ['tencent', 'qq.com']], ['阿里巴巴', ['alibaba']],
  ['美团', ['meituan']], ['百度', ['baidu']], ['小米', ['xiaomi']], ['华为', ['huawei']],
  ['网易', ['netease']], ['京东', ['jd.com', 'jingdong']], ['拼多多', ['pinduoduo']],
  ['滴滴', ['didi']], ['快手', ['kuaishou']], ['搜狐', ['sohu']], ['新浪', ['sina']],
  ['360集团', ['360.cn']], ['爱奇艺', ['iqiyi']], ['携程', ['ctrip', 'trip.com']],
  ['哔哩哔哩', ['bilibili']], ['小红书', ['xiaohongshu']], ['荣耀', ['hihonor']],
  ['大疆', ['dji']], ['蔚来', ['nio']], ['理想汽车', ['lixiang']], ['小鹏汽车', ['xiaopeng']],
  ['比亚迪', ['byd']], ['蚂蚁集团', ['antgroup']], ['米哈游', ['mihoyo']], ['莉莉丝', ['lilith']],
  ['鹰角网络', ['hypergryph']], ['完美世界', ['perfectworld', 'wanmei']], ['三七互娱', ['37.com']],
  ['科大讯飞', ['iflytek']], ['海康威视', ['hikvision']], ['商汤科技', ['sensetime']],
  ['旷视科技', ['megvii']], ['地平线', ['horizon']], ['寒武纪', ['cambricon']],
  ['中兴通讯', ['zte']], ['联想', ['lenovo']], ['OPPO', ['oppo']], ['vivo', ['vivo']],
  ['吉利', ['geely']], ['奇瑞', ['chery']], ['长城汽车', ['gwm.com']],
  ['恒生电子', ['hundsun']], ['卓望公司', ['aspire']], ['金蝶', ['kingdee']], ['用友', ['yonyou']],
  ['顺丰', ['sf-express']], ['中芯国际', ['smics']], ['长江存储', ['ymtc']],
  ['紫光展锐', ['unisoc']], ['浪潮', ['inspur']], ['海光信息', ['hygon']],
  ['招商银行', ['cmbchina']], ['中信证券', ['citics']], ['中金公司', ['cicc']],
  ['华泰证券', ['htsc']], ['国泰君安', ['gtja']], ['东方财富', ['eastmoney']],
  ['同花顺', ['10jqka']], ['微众银行', ['webank']], ['网商银行', ['mybank']],
  ['度小满', ['duxiaoman']], ['陆金所', ['lu.com']], ['众安保险', ['zhongan']],
  ['迈瑞医疗', ['mindray']], ['京东方', ['boe']], ['传音控股', ['transsion']],
  ['长鑫存储', ['cxmt']], ['长江存储', ['ymtc']], ['长安汽车', ['changan']],
  ['奇瑞', ['chery']], ['三一集团', ['sany']], ['潍柴集团', ['weichai']],
  ['欣旺达', ['sunwoda']], ['国金证券', ['gjzq']], ['科大讯飞', ['iflytek']],
  ['零跑汽车', ['leapmotor']], ['虎扑', ['hupu']], ['易车', ['yiche']],
  ['贝壳', ['ke.com']], ['中国船舶', ['csic']], ['国轩高科', ['gotion']],
  ['上汽大众', ['svw']], ['临工重机', ['lgmg']], ['中国联通', ['unicom']],
  ['中国移动', ['cmri']], ['猎豹移动', ['cmcm']], ['阅文集团', ['yuewen']],
  ['贝壳找房', ['ke.com']],
  ['泰康保险', ['taikang']], ['平安集团', ['pingan']], ['阳光保险', ['sinosig']],
];
const URL_NOISE_SEGMENTS = new Set([
  'www', 'static', 'job', 'jobs', 'career', 'careers', 'campus', 'recruit',
  'recruitment', 'talent', 'join', 'app', 'm', 'api', 'cdn', 'img', 'stcms',
  'com', 'cn', 'net', 'io', 'ai', 'org', 'co', 'inc', 'edu', 'gov',
]);
// 招聘平台域名：兜底时不得把平台名当公司
const PLATFORM_DOMAINS = [
  'zhipin.com', 'mokahr.com', 'lever.co', 'greenhouse.io', 'zhiye.com',
  'smartrecruiters.com', 'lagou.com', 'liepin.com', 'zhaopin.com', '51job.com',
  'nowcoder.com', 'jobui.com', 'kanzhun.com', 'linkedin.com', 'indeed.com',
  'glassdoor.com', 'jobsdb.com', 'seek.com', 'wetalent.com', 'careerone.com',
];

/**
 * 从投递 URL 猜测公司：ATS 租户段（mokahr/zhiye/lever/greenhouse…）→ 已知公司字典 → 品牌域名映射
 * @returns {{company: string, source: 'url', confidence: 'high'|'low'}|null}
 */
export function guessCompanyFromUrl(u, knownCompanies = []) {
  let host = '', full = '';
  try { const url = new URL(String(u)); host = url.hostname.toLowerCase(); full = (url.hostname + url.pathname).toLowerCase(); } catch { return null; }
  const tenantTokens = [];
  const tenantPatterns = [
    /campus_apply\/([a-z0-9-]+)/i,                 // Moka：app.mokahr.com/campus_apply/{租户}
    /([a-z0-9-]+)\.zhiye\.com/i,                   // 北森 zhiye：{租户}.zhiye.com
    /boards\.greenhouse\.io\/([a-z0-9-]+)/i,       // Greenhouse
    /jobs\.lever\.co\/([a-z0-9-]+)/i,              // Lever
    /smartrecruiters\.com\/[^/]+\/([a-z0-9-]+)/i,  // SmartRecruiters
  ];
  for (const re of tenantPatterns) {
    const m = full.match(re);
    if (m) tenantTokens.push(m[1]);
  }
  // 域名分段（去掉噪音段与顶级域名）
  const hostTokens = [];
  for (const seg of host.split('.')) {
    const s = seg.replace(/^www\d*/, '');
    if (s && !URL_NOISE_SEGMENTS.has(s) && !/^\d+$/.test(s) && s.length >= 3) hostTokens.push(s);
  }
  // token 归一化：360campus → 360、oppocampus → oppo（ATS 常在品牌名后加 campus/careers 等后缀）
  const normalizeToken = (t) => String(t).replace(/(?:campus|careers?|jobs?|recruit(?:ment)?|university|talent|join|hr|s?campus)$/i, '');
  const tokens = [...tenantTokens, ...hostTokens]
    .map(normalizeToken)
    .filter((t) => t && t.length >= 2);
  if (tokens.length === 0) return null;
  // 已知公司字典（用户已存记录，优先级最高）
  for (const t of tokens) {
    const tl = t.toLowerCase();
    for (const c of knownCompanies) {
      if (c && (tl.includes(c.toLowerCase()) || c.toLowerCase().includes(tl))) {
        return { company: c, source: 'url', confidence: 'high' };
      }
    }
  }
  // 品牌域名映射
  for (const t of tokens) {
    for (const [name, keys] of BRAND_MAP) {
      for (const k of keys) {
        if (t.includes(k) || k.includes(t)) return { company: name, source: 'url', confidence: 'high' };
      }
    }
  }
  // 兜底：租户 slug（如 sohu）供用户确认；平台域名（BOSS/牛客等）不参与
  const isPlatform = PLATFORM_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  const rawTenant = tenantTokens[0] ? normalizeToken(tenantTokens[0]) : null;
  const rawHost = hostTokens[0] ? normalizeToken(hostTokens[0]) : null;
  const tenant = rawTenant || (isPlatform ? null : rawHost);
  if (tenant && tenant.length >= 3 && tenant.length <= 20) {
    return { company: tenant, source: 'url', confidence: 'low' };
  }
  return null;
}
const MIGRATIONS = {
  1: (data) => {
    const records = data.records.map((r) => {
      const mapped = LEGACY_STATUS_MAP[r.status];
      if (!mapped) return r;
      return {
        ...r,
        status: mapped[0],
        stage: r.stage || mapped[1],
        result: r.result || mapped[2],
      };
    });
    return { ...data, version: 2, records };
  },
  // v2 → v3：新增持久化备注字段 notes
  2: (data) => ({
    ...data,
    version: 3,
    records: data.records.map((r) => ({ ...r, notes: typeof r.notes === 'string' ? r.notes : '' })),
  }),
  // v3 → v4：已投递并入筛选中（状态与历史同步改名）
  3: (data) => {
    const fix = (s) => (s === '已投递' ? STATUS.SCREENING : s);
    return {
      ...data,
      version: 4,
      records: data.records.map((r) => ({
        ...r,
        status: fix(r.status),
        history: (r.history || []).map((h) => ({
          ...h,
          from: h.from ? fix(h.from) : h.from,
          to: fix(h.to),
        })),
      })),
    };
  },
  // v4 → v5：新增删除墓碑 tombstones（云同步时把删除动作传播到其他设备，防止记录被"复活"）
  4: (data) => ({
    ...data,
    version: 5,
    tombstones: Array.isArray(data.tombstones) ? data.tombstones : [],
  }),
  // v5 → v6：新增面经 / 复盘条目 interviews 与它的删除墓碑 interviewTombstones。
  // 两个键都必须显式补上（连空数组也要）：合并结果一定会带上它们，
  // 某一侧缺键会让「内容有没有变」的比较把「多了个空数组」当成一次真变化（见 transfer.js:90-93）。
  // 注意 migrateData 的产物不会回写存储（loadData 只读），各读取处仍要自己兜 || []，
  // 这层迁移保证的是导入与云同步这两条规范化路径上的键形状一致。
  5: (data) => ({
    ...data,
    version: 6,
    records: data.records.map((r) => ({
      ...r,
      interviews: Array.isArray(r.interviews) ? r.interviews : [],
      interviewTombstones: Array.isArray(r.interviewTombstones) ? r.interviewTombstones : [],
    })),
  }),
};

// 逐版本升级到当前 schema。导入外部文件时也走这里，
// 保证「旧版本导出的备份」能被新版本正确读进来。
export function migrateData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.records)) {
    return { version: SCHEMA_VERSION, records: [], tombstones: [] };
  }
  while (data.version < SCHEMA_VERSION) {
    const migrate = MIGRATIONS[data.version];
    if (!migrate) break;
    data = migrate(data);
  }
  return data;
}

export async function loadData() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return migrateData(raw[STORAGE_KEY]);
}

export async function saveData(data) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  } catch (e) {
    console.error('saveData failed:', e);
    throw e;
  }
}

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- 去重 ----------
const TRACK_PARAMS = new Set([
  'ka', 'kt', 'spm', 'share_token', 'shareId', 'securityId', 'security_id',
  'refer', 'from', 'sid', 'scene', 'source', 'trace_id', '_t', 'timestamp', 'ts',
]);

export function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (TRACK_PARAMS.has(k) || k.startsWith('utm_') || k.includes('token') || k.includes('share')) {
        url.searchParams.delete(k);
      }
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.toString();
  } catch {
    return String(u || '').trim();
  }
}

export function normalizePosition(p) {
  return String(p || '')
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/（.*?）/g, '')  // 去掉中文括号修饰（如"（2026校招）"）
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

// 去重键：同一 url + 同一岗位 视为同一条投递；同公司不同岗位天然独立。
// 没有链接时不能只拿岗位名当身份：一份没有链接列的表格里，
// 「后端开发」在 10 家公司就是 10 条，只按岗位名算会把它们塌成一条（真丢数据）。
// 有链接的记录键一字不变 —— 从扩展保存的记录都有链接，身份不受影响；
// 云同步那套也不看这个键（服务端按 id 整包存），所以改它不会让任何设备"变成新记录"。
export function recordKey(rec) {
  const u = normalizeUrl(rec.url);
  return (u || 'no-url://' + normalizePosition(rec.company)) + '::' + normalizePosition(rec.position);
}

// 截止节点的同一性：优先用节点 id（编辑改时间仍是同一个节点），
// 老数据没有 id 时用「名称 + 时间」算出的确定性 id（见 deadlineId）。
export function deadlineKey(d) {
  return d?.id || deadlineId(d);
}

// 状态历史行的同一性：同一时刻的同一状态迁移只保留一条
export function historyKey(h) {
  return `${h?.at || ''}::${h?.from || ''}::${h?.to || ''}`;
}

// 键排序后序列化：用于「这条记录到底变没变」的比较（不受字段顺序影响）。
// 导入合并与云同步合并都用它做「有没有真变化」的判据，避免无谓落盘。
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

// ---------- 截止节点的合并：增 / 改 / 删都要能在设备之间收敛 ----------
// rec.deadlines 里只放**存活**节点（渲染、提醒、日历那些读取方一行都不用改），
// 删除动作记在同级的 rec.deadlineTombstones = [{ key, at }] 里，跟着记录一起同步。
//
// 为什么节点墓碑**不能**像记录墓碑那样按时间清理（sync.js 会清 90 天前的记录墓碑）：
// 记录墓碑在服务端有一份权威副本（那行 deleted=1），客户端清掉也删不掉它；
// 节点墓碑只活在「这条记录胜出版本」的 data 里，本地一清，下次推送就把服务端那份一起抹了，
// 离线久的设备一回来就会让被删的节点复活，而且两端会互相顶戳、永不收敛。
// 所以节点墓碑只增不删：一条约 60~90 字节，相对 JD 全文可以忽略。

// 32 位 FNV-1a：同步、确定、无需 WebCrypto（crypto.subtle 是异步的，同步流程里不方便）
export function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// 确定性节点 id：老数据没有 id，第一次被改动时按内容物化一个。
// 必须由内容推出而不是随机 uid —— 两台设备对同一份老内容要算出同一个 id，
// 否则一台物化之后 key 变了、另一台还按老内容看，同一个节点会被当成两个。
//
// 物化时必须用**改动前**的那份内容（deadlineId(旧节点)），不是改完的新值：
// 对端手里那份还是老内容，它的 key 就是「老内容 → 这个 id」，两边才对得上。
// 改动后的新内容 hash 出来的是另一个 id，对端认不出来，节点会一分为二。
export function deadlineId(d) {
  return 'dl-' + fnv32(`${d?.label || ''}\u0000${d?.datetime || ''}`);
}

// 一个节点可能匹配到的全部 key：它自己的 key，加上由内容推出的那个。
// 墓碑按 key 匹配，多留一个别名才不会出现「一端删掉、另一端那份还活着」。
export function deadlineAliases(d) {
  return new Set([deadlineKey(d), deadlineId(d)]);
}

export function deadlineTombstonesOf(rec) {
  return Array.isArray(rec?.deadlineTombstones) ? rec.deadlineTombstones : [];
}

// 节点的时间：优先用它自己的 updatedAt；老节点没有则退回到所属记录的时间。
// 「缺时间戳 = 永远最旧」是错的：一次导入就能把本机刚编辑过的老节点判负，改完立刻被盖回来。
export function deadlineTime(d, fallbackIso) {
  return Date.parse(d?.updatedAt) || Date.parse(fallbackIso) || 0;
}

// 本机改动后的新时间戳：max(本机现在, 已知版本 + 1ms)。
// 设备时钟可能比对方慢，直接写 new Date() 会让本机刚做的改动在 LWW 里
// 输给「本机已经见过的那一版」，表现就是改了没生效、下次同步又被盖回来。
export function nextStamp(prevIso) {
  return new Date(Math.max(Date.now(), (Date.parse(prevIso) || 0) + 1)).toISOString();
}

// 节点的签名：用于判断「合并结果里有没有远端没有的东西」。
// 刻意不含 notified24hFor / notifiedOverdueFor —— 那两个字段是本机提醒簿记，
// 两端各自变化，算进来会让双方每轮都认定对方缺东西、无限互推。
//
// 也不能含 deadlineTime 的**兜底值**（节点没有 updatedAt 时退回到所属记录的时间）：
// 兜底值各算各的（各用各的记录时间戳），两端手里明明是同一个老节点却签名不等，
// 于是每一轮都判对方缺东西、互相顶戳推来推去，永不收敛。老节点自己那格就留空字符串。
function dlSig(d) {
  return [deadlineKey(d), d?.label || '', d?.datetime || '', d?.done ? 1 : 0, d?.updatedAt || ''].join('\u0000');
}
function hSig(h) {
  return [historyKey(h), h?.note || ''].join('\u0000');
}

/**
 * 合并两侧的截止节点状态（唯一实现：sync.js 的云端合并与 transfer.js 的导入共用）
 * @param {{deadlines?:object[], deadlineTombstones?:object[], updatedAt?:string}} a
 * @param {{deadlines?:object[], deadlineTombstones?:object[], updatedAt?:string}} b
 * @param {{prefer?:'a'|'b'}} opts 两边都没有时间戳时以谁为准（老数据走这里，保持旧的并集行为）
 * @returns {{deadlines:object[], deadlineTombstones:object[], missingFrom:{a:number,b:number}}}
 *   missingFrom.b = 结果里有、b（远端/文件）没有的东西条数 → 本地补了东西，
 *   调用方要把记录时间戳顶新，好让这份并集在下一次同步时推回服务端（否则两端各留各的，永不收敛）。
 *   missingFrom.a = 反过来，a（本机）原来没有的东西条数（导入时判断"文件带来了什么新东西"用）。
 */
export function mergeDeadlineState(a, b, { prefer = 'b' } = {}) {
  const side = (x) => ({
    live: (Array.isArray(x?.deadlines) ? x.deadlines : []).filter((d) => d && typeof d === 'object'),
    tombs: (Array.isArray(x?.deadlineTombstones) ? x.deadlineTombstones : []).filter((t) => t && t.key),
    at: x?.updatedAt,
  });
  const A = side(a), B = side(b);

  // 1. 存活节点按 key 归并：同 key 取时间戳较新的；都没有时间戳时看 prefer（老数据不丢东西）
  const live = new Map();
  const putLive = (d, tag) => {
    const k = deadlineKey(d);
    if (!k) return;
    const prev = live.get(k);
    if (!prev) { live.set(k, { d, tag }); return; }
    const tp = deadlineTime(prev.d, prev.tag === 'a' ? A.at : B.at);
    const tn = deadlineTime(d, tag === 'a' ? A.at : B.at);
    if (tn > tp || (tn === tp && tag === prefer)) live.set(k, { d, tag });
  };
  for (const d of A.live) putLive(d, 'a');
  for (const d of B.live) putLive(d, 'b');

  // 2. 墓碑按 key 归并：同一节点被删两次，留后删的那条
  const tombs = new Map();
  for (const t of [...A.tombs, ...B.tombs]) {
    const prev = tombs.get(t.key);
    if (!prev || (Date.parse(t.at) || 0) > (Date.parse(prev.at) || 0)) tombs.set(t.key, { key: t.key, at: t.at });
  }

  // 3. 裁决：改得比删晚 → 节点活下来（并把那条墓碑一起丢掉，否则列表/提醒/日历会各说各话）
  const out = [];
  for (const { d, tag } of live.values()) {
    const mine = deadlineTime(d, tag === 'a' ? A.at : B.at);
    const aliases = deadlineAliases(d);
    let killer = null;
    for (const t of tombs.values()) {
      if (!aliases.has(t.key)) continue;
      const at = Date.parse(t.at) || 0;
      if (at > mine && (!killer || at > (Date.parse(killer.at) || 0))) killer = t;
    }
    if (killer) continue;                       // 保持删除
    for (const k of aliases) tombs.delete(k);   // 节点赢 → 清掉同一节点的墓碑
    out.push(d);
  }
  out.sort((x, y) => String(x.datetime || '').localeCompare(String(y.datetime || ''))
    || deadlineKey(x).localeCompare(deadlineKey(y)));
  const tombList = [...tombs.values()].sort((x, y) => String(x.key).localeCompare(String(y.key)));

  // 4. 差值必须方向敏感（「结果里有、某一侧没有的」），不能拿「两个数组是否相等」当判据 ——
  //    数组顺序的差异会让两端每轮都判对方缺东西，互相顶戳、永不收敛。
  const beyond = (live, tombs) => {
    const sigs = new Set(live.map(dlSig));
    const keys = new Set(tombs.map((t) => t.key));
    let n = 0;
    for (const d of out) if (!sigs.has(dlSig(d))) n++;
    for (const t of tombList) if (!keys.has(t.key)) n++;
    return n;
  };
  const missingFrom = { a: beyond(A.live, A.tombs), b: beyond(B.live, B.tombs) };

  return { deadlines: out, deadlineTombstones: tombList, missingFrom };
}

/**
 * 合并两侧的状态历史（同一实现，导入与云同步共用）
 * @returns {{history:object[], missingFrom:{a:number,b:number}}} 含义同 mergeDeadlineState
 */
export function mergeHistoryState(a, b, { prefer = 'b' } = {}) {
  const listA = (Array.isArray(a?.history) ? a.history : []).filter((h) => h && typeof h === 'object');
  const listB = (Array.isArray(b?.history) ? b.history : []).filter((h) => h && typeof h === 'object');
  const map = new Map();
  for (const [list, tag] of [[listA, 'a'], [listB, 'b']]) {
    for (const h of list) {
      const k = historyKey(h);
      if (!k) continue;
      const prev = map.get(k);
      if (!prev || tag === prefer) map.set(k, h);   // 同 key 冲突：胜出侧整条覆盖
    }
  }
  const out = [...map.values()].sort((x, y) =>
    String(x.at || '').localeCompare(String(y.at || '')) || historyKey(x).localeCompare(historyKey(y)));
  const aSigs = new Set(listA.map(hSig));
  const bSigs = new Set(listB.map(hSig));
  return {
    history: out,
    missingFrom: {
      a: out.filter((h) => !aSigs.has(hSig(h))).length,
      b: out.filter((h) => !bSigs.has(hSig(h))).length,
    },
  };
}

// ---------- 面经 / 复盘条目的合并：增 / 改 / 删都要能在设备之间收敛 ----------
// 与截止节点同一套模式（条目级 LWW + 条目墓碑），理由也一样：
// 电脑上记了一条面经、手机上也记了一条，不该被对方整段覆盖掉。
// （云同步的主体是字段级 LWW（sync.js 的 merged），所以 interviews 必须在这里单独合并，
//   否则"整条数组谁的时间戳新谁说了算"，另一端刚写的那条就没了。）
//
// 条目比节点多一个**必填**的 updatedAt，它是 LWW 的时钟：
//   · 不能用 at（笔试/面试**发生**的时刻）当判据 —— 给上周那场面试补写复盘时 at 在过去，
//     会输给对端手里那份旧版本，改完同步又被盖回来；
//   · 不能只用所属记录的 updatedAt 兜底判胜负 —— 回流顶戳会改它，兜底值一变胜者就翻转，
//     两端来回震荡（deadlineTime 那条注释记的就是这个坑）。at 只负责排序与展示。

// 条目 id：没有 id 的老条目（手改的 JSON、别处搬来的）按内容物化一个确定性的。
// 必须由内容推出而不是随机 uid —— 否则同一份文件每次导入都被当成新条目（破坏幂等），
// 两端也会各自物化出一条。连内容都没有的空壳交给调用方退回随机 uid。
export function interviewId(iv) {
  return 'iv-' + fnv32(`${iv?.stage || ''}\u0000${iv?.at || ''}\u0000${iv?.question || ''}`);
}

export function interviewKey(iv) {
  return iv?.id || interviewId(iv);
}

// 条目的时间：优先用它自己的 updatedAt；老条目没有则退回到所属记录的时间（与节点同规则）。
export function interviewTime(iv, fallbackIso) {
  return Date.parse(iv?.updatedAt) || Date.parse(fallbackIso) || 0;
}

// 条目的签名：用于判断「合并结果里有没有某一侧没有的东西」。
// 刻意不含 interviewTime 的**兜底值**（老条目退回所属记录时间那一层）：
// 兜底值各算各的，两端手里明明是同一个老条目却签名不等，
// 于是每轮都判对方缺东西、互相顶戳推来推去，永不收敛。老条目自己那格就留空字符串。
function ivSig(iv) {
  return [interviewKey(iv), iv?.stage || '', iv?.at || '', iv?.question || '', iv?.review || '', iv?.updatedAt || ''].join('\u0000');
}

/**
 * 合并两侧的面经条目（唯一实现：sync.js 的云端合并与 transfer.js 的导入共用）
 * @param {{interviews?:object[], interviewTombstones?:object[], updatedAt?:string}} a
 * @param {{interviews?:object[], interviewTombstones?:object[], updatedAt?:string}} b
 * @param {{prefer?:'a'|'b'}} opts 两边都没有条目时间戳时以谁为准（老数据走这里，保持并集行为）
 * @returns {{interviews:object[], interviewTombstones:object[], missingFrom:{a:number,b:number}}}
 *   missingFrom.b = 结果里有、b（远端/文件）没有的东西条数 → 本机补了东西，
 *   调用方要把记录时间戳顶新推回，否则两端各留各的、永不收敛。
 */
export function mergeInterviewState(a, b, { prefer = 'b' } = {}) {
  const side = (x) => ({
    live: (Array.isArray(x?.interviews) ? x.interviews : []).filter((iv) => iv && typeof iv === 'object'),
    tombs: (Array.isArray(x?.interviewTombstones) ? x.interviewTombstones : []).filter((t) => t && t.key),
    at: x?.updatedAt,
  });
  const A = side(a), B = side(b);

  // 1. 存活条目按 key 归并：同 key 取时间戳较新的；都没有时间戳时看 prefer（老数据不丢东西）
  const live = new Map();
  const putLive = (iv, tag) => {
    const k = interviewKey(iv);
    if (!k) return;
    const prev = live.get(k);
    if (!prev) { live.set(k, { iv, tag }); return; }
    const tp = interviewTime(prev.iv, prev.tag === 'a' ? A.at : B.at);
    const tn = interviewTime(iv, tag === 'a' ? A.at : B.at);
    if (tn > tp || (tn === tp && tag === prefer)) live.set(k, { iv, tag });
  };
  for (const iv of A.live) putLive(iv, 'a');
  for (const iv of B.live) putLive(iv, 'b');

  // 2. 墓碑按 key 归并：同一条目被删两次，留后删的那条
  const tombs = new Map();
  for (const t of [...A.tombs, ...B.tombs]) {
    const prev = tombs.get(t.key);
    if (!prev || (Date.parse(t.at) || 0) > (Date.parse(prev.at) || 0)) tombs.set(t.key, { key: t.key, at: t.at });
  }

  // 3. 裁决：改得比删晚 → 条目活下来（并把那条墓碑一起丢掉，否则两端会各说各话）
  const out = [];
  for (const { iv, tag } of live.values()) {
    const mine = interviewTime(iv, tag === 'a' ? A.at : B.at);
    const key = interviewKey(iv);
    let killer = null;
    for (const t of tombs.values()) {
      if (t.key !== key) continue;
      const at = Date.parse(t.at) || 0;
      if (at > mine && (!killer || at > (Date.parse(killer.at) || 0))) killer = t;
    }
    if (killer) continue;                       // 保持删除
    tombs.delete(key);                          // 条目赢 → 清掉它的墓碑
    out.push(iv);
  }
  out.sort((x, y) => String(x.at || '').localeCompare(String(y.at || ''))
    || interviewKey(x).localeCompare(interviewKey(y)));
  const tombList = [...tombs.values()].sort((x, y) => String(x.key).localeCompare(String(y.key)));

  // 4. 差值必须方向敏感（「结果里有、某一侧没有的」），不能拿「两个数组是否相等」当判据 ——
  //    数组顺序的差异会让两端每轮都判对方缺东西，互相顶戳、永不收敛。（同 mergeDeadlineState）
  const beyond = (liveList, tombList2) => {
    const sigs = new Set(liveList.map(ivSig));
    const keys = new Set(tombList2.map((t) => t.key));
    let n = 0;
    for (const iv of out) if (!sigs.has(ivSig(iv))) n++;
    for (const t of tombList) if (!keys.has(t.key)) n++;
    return n;
  };

  return {
    interviews: out,
    interviewTombstones: tombList,
    missingFrom: { a: beyond(A.live, A.tombs), b: beyond(B.live, B.tombs) },
  };
}

// ---------- 标题解析 ----------
// 站点后缀：兼容 "2026校园招聘" 这种带年份的组合（年份可省）
const SITE_SUFFIX_RE =
  /[\s\-—|_·,，]*(?:20\d\d(?:届)?)?(?:BOSS直聘|BOSS|猎聘|拉勾|拉钩|智联招聘|前程无忧|51job|牛客网|牛客|应届生求职网|实习僧|校园招聘|社会招聘|校招|社招|人才招聘|招聘官网|招聘网站|招聘中心|招聘平台|招聘|求职|官网|首页)$/i;

// 纯站点壳标题模式："XX校招 / XX招聘官网"（真实岗位在页面正文里）
const SITE_TITLE_SUFFIX_RE =
  /^(.*?)[\s\-—|_·]*(?:20\d\d(?:届)?)?(?:校园招聘|社会招聘|校招|社招|人才招聘|招聘官网|招聘网站|招聘中心|招聘平台|招聘|求职|官网|首页)$/i;

const COMPANY_SUFFIXES = [
  '公司', '集团', '有限', '股份', '科技', '网络', '银行', '证券', '保险', '基金',
  '研究院', '研究所', '大学', '学院', '医院', '汽车', '电子', '半导体', '智能',
  '信息', '技术', '数据', '云', '通信', '地产', '物流', '传媒', '游戏', '娱乐',
  '高科', '控股', '汽车', '车业', '数码', '互娱', '金科', '医疗', '软件',
  '教育', '医疗', '生物', '制药', '能源', '化工', '制造', '重工', '软件', '硬件',
  '咨询', '事务所', '实验室', '航天', '航空', '电力', '电网',
];

const POSITION_KEYWORDS = [
  '工程师', '开发', '算法', '测试', '前端', '后端', '客户端', '全栈', '数据',
  '机器学习', '深度学习', '产品', '运营', '设计', '管培生', '专员', '经理',
  '实习生', '实习', '校招', '秋招', '春招', '校园', '应届', '急招', '内推',
  '岗位', '助理', '顾问', '研究员', '科学家', '分析师', '架构', '运维', '安全',
];

// 岗位修饰词：括号内容命中则视为修饰（从岗位名中去掉）；独立成段的命中则为噪音段
const MODIFIER_CONTENT_RE =
  /(校招|秋招|春招|应届|实习|急招|内推|社招|补录|提前批|正式批|20\d\d届?|方向|北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|长沙|天津|重庆|郑州|济南|青岛|厦门|福州|合肥)/;
const MODIFIER_TOKEN_RE =
  /^(?:(?:20)?\d\d(?:届)?(?:秋招|春招|校招|社招|补录|秋|春)?|20\d\d|20\d\d届|20\d\d届补录|校招|秋招|春招|应届|应届生|社招|补录|提前批|正式批|急招|内推|全职|兼职)$/;
// 独立成段的城市（地点修饰）与岗位编号（5390(J12462)）也是噪音段
const CITY_TOKEN_RE =
  /^(北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|长沙|天津|重庆|郑州|济南|青岛|厦门|福州|合肥|大连|沈阳|哈尔滨|昆明|贵阳|南宁|南昌|兰州|乌鲁木齐|呼和浩特|石家庄|太原|海口)$/;
const JCODE_SEGMENT_RE = /^(?:(?:20)?\d\d(?:届)?(?:秋招|春招|校招|社招|补录)?-?)?[（(][Jj]\d+[)）]$|^\d{2,6}[（(][Jj]\d+[)）]$/;
const BARE_NUMBER_RE = /^\d{2,6}$/;
const MODIFIER_SUFFIX_RE =
  /(?:20\d\d届?|校招|秋招|春招|应届生?|社招|补录|提前批|正式批|急招|内推|实习生?|校园招聘|社会招聘|人才招聘|员工招聘|招聘|求职)+$/;

function stripModifierBrackets(s) {
  return String(s)
    .replace(/[（(【\[][^）)】\]]{1,20}[）)】\]]/g, (m) => (MODIFIER_CONTENT_RE.test(m) ? ' ' : m))
    .replace(/\s+/g, ' ').trim();
}

// 仅用于公司段打分：去掉尾部的修饰词（不影响岗位名原文保真）
function stripModifierSuffix(s) {
  const stripped = String(s).replace(MODIFIER_SUFFIX_RE, '').trim();
  return stripped || String(s);
}

function isSiteName(seg) {
  return /^(BOSS直聘|猎聘|拉勾|智联招聘|前程无忧|51job|牛客网|应届生求职网|实习僧)$/i.test(seg);
}

// 部门词（制造中心/工厂/基地…）：更像岗位归属部门，不是公司
const DEPT_SUFFIX_RE = /(中心|工厂|基地|园区|车间|部门|小组|项目组|制造部|事业部|研究所)$/;
function companyScore(seg, knownCompanies) {
  let score = 0;
  for (const c of knownCompanies) {
    if (c && (seg.includes(c) || c.includes(seg))) { score += 100; break; }
  }
  if (COMPANY_SUFFIXES.some((s) => seg.endsWith(s))) score += 50;
  if (POSITION_KEYWORDS.some((k) => seg.includes(k))) score -= 60;
  if (DEPT_SUFFIX_RE.test(seg)) score -= 50;
  if (seg.length > 12) score += 10;
  return score;
}

function isCompanyLike(seg, knownCompanies) {
  // 括号模式判定从严：仅认已知公司或公司后缀词，避免"NLP方向"等被误判为公司
  if (knownCompanies.some((c) => c && (seg.includes(c) || c.includes(seg)))) return true;
  if (COMPANY_SUFFIXES.some((s) => seg.endsWith(s))) return true;
  return false;
}

function cleanSeg(seg) {
  // 只剥离切分后残留的全角/半角方括号；不碰圆括号（"(J10553)" 等岗位编号要保留）
  return String(seg || '').trim().replace(/^[【\[]+|[】\]]+$/g, '').trim();
}

function fullwidthToHalfwidth(s) {
  return String(s).replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/**
 * 从页面标题猜测公司名与岗位名。
 * @returns {{company: string, position: string, confidence: 'high'|'low'|'none'}}
 */
export function guessCompanyPosition(title, url, knownCompanies = []) {
  let t = fullwidthToHalfwidth(String(title || '').trim()).replace(/\s+/g, ' ');
  // 纯站点壳标题（"恒生校招"、"搜狐 -校园招聘"）：不要误当岗位名。
  // 前缀含岗位特征词（工程师/开发…）的除外——"岗位-公司招聘"是正常标题格式
  const siteTitle = t.match(SITE_TITLE_SUFFIX_RE);
  if (siteTitle && siteTitle[1] && siteTitle[1].trim()) {
    const prefix = siteTitle[1].trim();
    const hasPosKeyword = POSITION_KEYWORDS.some((k) => prefix.includes(k));
    if (!hasPosKeyword) {
      if (isCompanyLike(prefix, knownCompanies)) {
        return { company: prefix, position: '', confidence: 'low' };
      }
      // 品牌裸名（欣旺达/恒生/搜狐…）：2-6 字且非通用词的前缀也视为公司
      if (prefix.length >= 2 && prefix.length <= 6 && !/(游戏|职位|岗位|简历|实习|校园|招聘|人才|登录|注册|搜索|首页|投递)/.test(prefix)) {
        return { company: prefix, position: '', confidence: 'low' };
      }
      return { company: '', position: '', confidence: 'none' };
    }
  }
  // 后缀重复剥除（"XXX校园招聘校园招聘" 之类嵌套）
  let prevT = '';
  while (t && t !== prevT) {
    prevT = t;
    const next = t.replace(SITE_SUFFIX_RE, '').trim();
    if (next === t) break;
    t = next;
  }
  if (!t) return { company: '', position: '', confidence: 'none' };

  // 1. 括号模式：【公司】岗位 / [公司]岗位 / （公司）岗位
  const bracket = t.match(/【(.+?)】|\[(.+?)\]|（(.+?)）/);
  if (bracket) {
    const inside = cleanSeg(bracket[1] || bracket[2] || bracket[3]);
    if (inside && isCompanyLike(inside, knownCompanies)) {
      const rest = joinPositionSegments(t.replace(bracket[0], ''));
      return { company: inside, position: rest, confidence: rest ? 'high' : 'low' };
    }
    // 括号内容不是公司：修饰词（校招/急招/城市）与薪资编号类噪音（15k-25k）直接去掉；
    // 实义内容（如"NLP方向"）并入岗位文本继续
    const rest = stripModifierBrackets(t.replace(bracket[0], ''));
    if (MODIFIER_CONTENT_RE.test(inside) || /^[\d.]{2,}[kKw万千-]|[\d.]+[kKw万]/.test(inside)) {
      t = rest;
    } else {
      t = (rest + ' ' + inside).trim();
    }
  }

  // 2. 分隔符切分 + 打分选公司段
  let segs = t.split(/[\s\-—–|｜_·]+/)
    .map((s) => stripModifierBrackets(cleanSeg(s)))
    .filter((s) => s && !isSiteName(s) && !MODIFIER_TOKEN_RE.test(s) && !CITY_TOKEN_RE.test(s) && !JCODE_SEGMENT_RE.test(s) && !BARE_NUMBER_RE.test(s));
  if (segs.length === 0) return { company: '', position: '', confidence: 'none' };
  if (segs.length === 1) {
    // 单段兜底：公司特征（网络/科技/公司…）→ 归公司；站点噪音 → 都留空；否则归岗位
    const only = segs[0];
    if (isCompanyLike(only, knownCompanies)) return { company: only, position: '', confidence: 'low' };
    if (/招聘|官网|首页|人才|求职/.test(only)) return { company: '', position: '', confidence: 'none' };
    return { company: '', position: only, confidence: 'none' };
  }
  let best = segs[0], bestScore = -Infinity;
  for (const s of segs) {
    const sc = companyScore(stripModifierSuffix(s), knownCompanies);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  const position = segs.filter((s) => s !== best).join(' ');
  return {
    company: stripModifierSuffix(best),
    position,
    confidence: bestScore >= 40 ? 'high' : 'low',
  };
}

// 括号模式下：剩余文本切段、去噪音段后拼接为岗位名
function joinPositionSegments(text) {
  return stripModifierBrackets(text)
    .split(/[\s\-—–|｜_·]+/).map(cleanSeg)
    .filter((s) => s && !isSiteName(s) && !MODIFIER_TOKEN_RE.test(s) && !CITY_TOKEN_RE.test(s) && !JCODE_SEGMENT_RE.test(s) && !BARE_NUMBER_RE.test(s))
    .join(' ');
}

// ---------- 记录构造与状态变更 ----------
export function makeRecord({ company, position, url, jd, sourceTitle, appliedAt } = {}) {
  const now = new Date().toISOString();
  return {
    id: uid(),
    url: String(url || '').trim(),
    company: String(company || '').trim(),
    position: String(position || '').trim(),
    jd: String(jd || '').trim(),
    sourceTitle: String(sourceTitle || '').trim(),
    status: STATUS.SCREENING,  // 投递即进入筛选
    stage: null,
    result: null,
    appliedAt: appliedAt || now,
    createdAt: now,
    updatedAt: now,
    notes: '',
    deadlines: [],
    interviews: [],
    interviewTombstones: [],
    history: [{ at: now, from: null, to: STATUS.SCREENING, note: '初始投递' }],
  };
}

// 状态变更：更新状态、清理无关字段、记录历史
export function applyStatusChange(rec, next, note = '') {
  if (rec.status === next && !note) return rec;
  rec.history.push({
    at: new Date().toISOString(),
    from: rec.status,
    to: next,
    note: String(note || '').trim(),
  });
  rec.status = next;
  if (next !== STATUS.INTERVIEW) rec.stage = null;
  if (next !== STATUS.ENDED) rec.result = null;
  // 与节点级、手机端 markEdited 同一条规则：本机刚做的动作必须赢过"本机已经见过的"那一版
  // （两台设备时钟不一致时，直接取现在可能比对方旧，改完同步又被盖回来）
  rec.updatedAt = nextStamp(rec.updatedAt);
  return rec;
}

// ---------- 截止节点工具 ----------
export function nextDeadline(rec) {
  let best = null;
  for (const dl of rec.deadlines || []) {
    if (dl.done) continue;
    const t = Date.parse(dl.datetime);
    if (!t) continue;
    if (!best || t < Date.parse(best.datetime)) best = dl;
  }
  return best;
}

// 截止 chip 元数据（用于面板展示与提醒着色）
export function deadlineChipMeta(dl, now = Date.now()) {
  if (!dl || dl.done) return null;
  const t = Date.parse(dl.datetime);
  if (!t) return null;
  const diff = t - now;
  if (diff < 0) return { label: '已过期', color: '#FF9E9E', bg: 'rgba(239,68,68,.18)' };
  if (diff <= 24 * 3600 * 1000) {
    const d = new Date(t), n = new Date(now);
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return { label: sameDay ? '今天' : '明天', color: '#FFC76E', bg: 'rgba(234,88,12,.20)' };
  }
  if (diff <= 3 * 24 * 3600 * 1000) return { label: '3天内', color: '#7FB3FF', bg: 'rgba(37,99,235,.22)' };
  return { label: '远期', color: '#A5B0C4', bg: 'rgba(148,163,184,.14)' };
}

// ---------- 格式化 ----------
const DATE_FMT = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const WEEKDAY_FMT = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });

export function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '—' : DATE_FMT.format(d).replace(/\//g, '-');
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '—' : TIME_FMT.format(d).replace(/\//g, '-');
}

export function fmtRelative(iso, now = Date.now()) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const diff = now - d.getTime();
  const abs = Math.abs(diff);
  if (abs < 60 * 1000) return diff >= 0 ? '刚刚' : '即将';
  if (abs < 3600 * 1000) return (diff >= 0 ? '' : '') + Math.round(abs / 60000) + ' 分钟' + (diff >= 0 ? '前' : '后');
  if (abs < 24 * 3600 * 1000) return Math.round(abs / 3600000) + ' 小时' + (diff >= 0 ? '前' : '后');
  if (abs < 7 * 24 * 3600 * 1000) return Math.round(abs / 86400000) + ' 天' + (diff >= 0 ? '前' : '后');
  return fmtDateTime(iso);
}

export function todayLabel() {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAY_FMT.format(now)}`;
}

// datetime-local 输入框 ↔ ISO 互相转换（本地时区）
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

// ---------- 杂项 ----------
// 取链接主机名（用于行内展示），非法 URL 返回空串
export function hostOf(u) {
  try { return new URL(String(u)).hostname; } catch { return ''; }
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
