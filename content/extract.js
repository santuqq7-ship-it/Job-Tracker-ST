// content/extract.js — 按需注入的 JD 抓取脚本（自包含经典脚本，结尾 IIFE 表达式为注入返回值）
// 提取层级：① 站点适配器 → ② 通用"岗位职责/任职要求"锚定 → ③ main/article 兜底 → ④ 最长文本块
(() => {
  'use strict';
  const HOST = location.hostname;
  const MAX_LEN = 20000;

  // 站点适配器：jd 选择器（按优先级）+ 公司/岗位 DOM 选择器
  const ADAPTERS = [
    {
      host: /(^|\.)zhipin\.com$/,   // BOSS直聘
      jd: ['.job-sec-text', '.job-detail-section .text', '#job-sec .text', '.job-description', '.job-detail'],
      company: ['.company-info h3', '.sider-company .name h2', '.company-info .name'],
      position: ['.job-name .name h1', '.name h1', '.job-primary .name', '.info-primary .name'],
    },
    {
      host: /(^|\.)nowcoder\.com$/,  // 牛客网
      jd: ['.post-topic-des', '.nc-post-content', '.discuss-detail-content', '.recruitment-job-detail', '.job-detail-box'],
    },
    {
      host: /(^|\.)zhaopin\.com$/,   // 智联招聘
      jd: ['.describtion__detail-content', '.job-description', '.job-detail-content'],
    },
    {
      host: /(^|\.)51job\.com$/,     // 前程无忧
      jd: ['.bmsg.job_msg', '.job_msg', '.job-detail .jtag'],
    },
    {
      host: /(^|\.)liepin\.com$/,    // 猎聘
      jd: ['.job-description', '.content-word', '.job-intro-box'],
    },
    {
      host: /(^|\.)lagou\.com$/,     // 拉勾
      jd: ['.job-detail-content', '.job_detail', '.job-description'],
    },
    {
      host: /(^|\.)maimai\.cn$/,     // 脉脉
      jd: ['.job-detail-content', '.job-description'],
    },
    {
      host: /(^|\.)jobs\.(cn|com)$|careers?\./i, // 公司官网 careers 子域（通用锚定即可，留作占位）
      jd: [],
    },
  ];

  // 通用锚定标题（去掉装饰字符后精确匹配）
  const HEADING_KEYS = new Set([
    '岗位职责', '职位描述', '工作职责', '工作内容', '任职要求', '任职资格',
    '岗位要求', '职位要求', '工作要求', '岗位描述', '职责描述', '职位信息',
    '招聘要求', '岗位介绍', '职位详情', '职位介绍', '职责要求', '岗位说明',
    'job description', 'responsibilities', 'qualifications', 'requirements',
    'what you will do', 'what we are looking for',
  ]);

  function textOf(el) { return el ? (el.textContent || '') : ''; }

  // 结构化文本：<br> 与块级元素输出为换行（JD 里的 "1、…<br>2、…" 不再挤成一行）
  const BLOCK_TAGS = new Set([
    'BR', 'P', 'DIV', 'LI', 'TR', 'TD', 'SECTION', 'UL', 'OL', 'TABLE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'ARTICLE', 'HEADER', 'FOOTER',
  ]);
  function blockText(root) {
    if (!root) return '';
    const parts = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n, prevBreak = true;
    while ((n = w.nextNode())) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (BLOCK_TAGS.has(n.tagName)) {
          if (!prevBreak) parts.push('\n');
          prevBreak = true;
        }
      } else {
        const t = n.textContent;
        if (t) { parts.push(t); prevBreak = false; }
      }
    }
    return parts.join('');
  }

  function clean(text) {
    let t = String(text || '').replace(/[ 　]/g, ' ');
    const noise = /^(登录|注册|立即投递|投递简历|收藏|分享|举报|APP下载|扫码|消息|反馈|首页|搜索|导航|电话|邮箱|意见反馈|在线咨询|客服|关注我们|置顶|刷新|回复|点赞|评论)$/;
    const lines = t.split('\n')
      .map((l) => l.replace(/[\s​­]+/g, ' ').trim())
      .filter((l) => l && !noise.test(l));
    const out = [];
    let prevEmpty = false;
    for (const l of lines) {
      if (!l) { if (out.length && !prevEmpty) out.push(''); prevEmpty = true; }
      else { out.push(l); prevEmpty = false; }
    }
    t = out.join('\n').trim();
    if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN) + '\n…（内容过长，已截断）';
    return t;
  }

  function headingKey(t) {
    return t.replace(/[\s【】\[\]（）()：:、。·\-—_/\\]+/g, '').toLowerCase();
  }

  function isHeading(el) {
    const txt = textOf(el).trim();
    if (!txt || txt.length > 30) return false;
    if (!HEADING_KEYS.has(headingKey(txt))) return false;
    // 只认"像标题"的元素，避免命中正文段落
    return /^(H[1-6]|STRONG|B|P|DIV|SPAN|LI|TD)$/.test(el.tagName);
  }

  function findJd() {
    // ① 站点适配器
    const ad = ADAPTERS.find((a) => a.host.test(HOST));
    if (ad && ad.jd.length) {
      for (const sel of ad.jd) {
        let el;
        try { el = document.querySelector(sel); } catch { continue; }
        if (el) {
          const t = clean(blockText(el));
          if (t.length >= 100) return t;
        }
      }
    }

    // ② 通用锚定：找"岗位职责/任职要求"等标题，向上 ≤5 层取最小且 ≥150 字的容器
    const anchors = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node, count = 0;
    while ((node = walker.nextNode()) && count < 4000) {
      count++;
      if (isHeading(node)) anchors.push(node);
    }
    const blocks = [];
    for (const a of anchors.slice(0, 12)) {
      let best = null, bestLen = Infinity;
      let cur = a;
      for (let i = 0; i <= 5 && cur && cur !== document.body; i++, cur = cur.parentElement) {
        const len = textOf(cur).length;
        if (len >= 150 && len < bestLen) { best = cur; bestLen = len; }
      }
      if (best) {
        const t = clean(blockText(best));
        if (t && !blocks.includes(t)) blocks.push(t);
      }
    }
    if (blocks.length) return blocks.slice(0, 2).join('\n\n');

    // ③ main / article 兜底
    for (const sel of ['main', 'article', '.job-detail', '.detail-content', '#content', '.content']) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (el) {
        const t = clean(blockText(el));
        if (t.length >= 150) return t;
      }
    }

    // ④ 最长叶子文本块（无 div/section 子元素的块，采样防卡顿）
    let longestEl = null, longestLen = 150;
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n2, c2 = 0;
    while ((n2 = w2.nextNode()) && c2 < 2500) {
      c2++;
      if (!/^(DIV|SECTION)$/.test(n2.tagName)) continue;
      if (n2.querySelector('div, section')) continue;
      const len = textOf(n2).length;
      if (len > longestLen) { longestEl = n2; longestLen = len; }
    }
    if (longestEl) {
      const t = clean(blockText(longestEl));
      if (t.length >= 100) return t;
    }
    return null;
  }

  function firstText(selectors) {
    for (const sel of selectors || []) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      const t = (el ? el.textContent : '').trim();
      if (t && t.length < 60) return t;
    }
    return null;
  }

  // ① JSON-LD JobPosting（schema.org 标准：hiringOrganization.name + title，精度最高）
  function fromJsonLd() {
    let nodes;
    try { nodes = document.querySelectorAll('script[type="application/ld+json"]'); } catch { nodes = []; }
    for (const script of nodes) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const list = Array.isArray(data) ? data : [data];
      for (const d of list) {
        if (!d || typeof d !== 'object') continue;
        let jp = null, org = null;
        if (d['@type'] === 'JobPosting') jp = d;
        if (d['@type'] === 'Organization') org = d;
        if (Array.isArray(d['@graph'])) {
          jp = jp || d['@graph'].find((x) => x && x['@type'] === 'JobPosting');
          org = org || d['@graph'].find((x) => x && x['@type'] === 'Organization');
        }
        if (jp) {
          const ho = jp.hiringOrganization;
          const company = org?.name || (typeof ho === 'string' ? ho : ho?.name) || null;
          return { company, position: jp.title || null, description: jp.description || null };
        }
      }
    }
    return null;
  }

  // ② meta keywords：如 "搜狐校园招聘,搜狐校招,搜狐招聘官网…" → 搜狐
  function fromMetaKeywords() {
    let kw = '';
    try { kw = document.querySelector('meta[name="keywords"]')?.content || ''; } catch { kw = ''; }
    if (!kw) return null;
    for (const raw of kw.split(/[,，;；]/)) {
      let seg = raw.trim();
      if (!seg || seg.length > 20 || seg.length < 2) continue;
      seg = seg.replace(/[\s\-—|_·,，]*(?:20\d\d(?:届)?)?(?:校园|社会|人才)?(?:招聘(?:官网|网站|中心|平台)?|校招|求职|官网|首页)$/i, '').trim();
      if (seg && seg.length >= 2 && seg.length <= 14 && !/^(首页|注册|登录|简历)$/.test(seg)) return seg;
    }
    return null;
  }

  // ③ 版权声明：© 2022 sohu.com Inc. / 版权所有 搜狐 …
  function fromCopyright() {
    let text = '';
    try { text = document.body.innerText || ''; } catch { text = ''; }
    const matches = text.match(/(?:©|Copyright|版权所有|保留所有权利)[^\n\r]{0,80}/gi) || [];
    for (const m of matches.slice(0, 4)) {
      const t = String(m)
        .replace(/copyright|all\s+rights?\s+reserved|版权所有|保留所有权利|[京沪粤浙苏陕闽川]ICP备\d+号?/gi, ' ')
        .replace(/20\d\d(?:[-–—]20\d\d)?/g, ' ')
        .replace(/[©()（）,，.。·、:：]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
      if (t && t.length <= 24 && t.length >= 2) return t;
    }
    return null;
  }

  // ---- 岗位/公司候选提取（多提取器 + 垃圾词过滤 + 评分）----
  // 硬垃圾（导航/站点文案）：直接拒收。
  // 校招/社招/招聘 等不在此列——它们是合法岗位标题的常见后缀（"XX工程师-校招"），交给启发式解析清洗
  const NAV_JUNK_RE =
    /加入我们|join us|岗位详情|职位详情|职位信息|投递简历|立即投递|申请职位|联系(我们)?|首页|登录|注册|搜索|导航|返回|更多|列表|上一页|下一页|分享|收藏|举报|在线咨询/i;
  // 栏目名（导航/版块标题）**整串**匹配：SPA 顶栏的「实习生招聘」「校园招聘」「校招公告」「关于我们」
  // 一个字的岗位信息都没有，却因为含"实习生/校招/招聘"这类词而混进候选 —— 而且常常混成唯一的候选
  // （拼多多的岗位页就是这样：真岗位名的容器类名认不出来，候选里只剩顶栏那一条）。
  // 必须整串匹配才安全：真岗位名总带"工程师/经理/管培生…"这类职务词，尾部这张表里一个都没有，
  // 所以「招聘专员」「校招经理」「实习生」照样通过
  const NAV_SECTION_RE =
    /^(?:(?:校园|社会|实习|实习生|应届|应届生|校招|社招|春招|秋招|暑期|寒假|全职|兼职|海外|国内|热门|最新|全部|所有|招聘)\s*)*(?:招聘|招募|校招|社招|公告|通知|资讯|动态|新闻|岗位|职位|列表|入口|通道|流程|政策|关于我们|联系我们|更多)$/;
  function isJunkPosition(t) {
    if (!t || t.length < 2 || t.length > 60) return true;
    if (/^\d+$/.test(t)) return true;
    if (NAV_SECTION_RE.test(t)) return true;
    return NAV_JUNK_RE.test(t);
  }
  function isJunkCompany(t) {
    if (!t || t.length > 40) return true;
    return /招聘|校招|社招|官网|首页|加入|join|岗位|职位|登录|注册/i.test(t);
  }
  const POSITION_WORD_RE =
    /工程师|算法|开发|测试|产品|设计|运营|研究员|专家|顾问|专员|经理|管培生|实习生|教师|编辑|主播|销售|市场|人力|财务|法务|客服|审计/;

  // 页面内岗位标题线索：① 【公司】岗位(J编号) 或 岗位(J编号) 文本模式；② BEM/连字符/驼峰类名容器
  function findPagePosition() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, c = 0;
    while ((n = w.nextNode()) && c < 20000) {
      c++;
      const parentTag = n.parentElement ? n.parentElement.tagName : '';
      if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'NOSCRIPT') continue;
      const t = n.textContent.trim();
      if (!t || t.length > 120) continue;
      const b = t.match(/【([^】]{2,30})】([^【】\s]{2,60})/);
      if (b) return { value: b[0], kind: 'bracket' };
      // 岗位(J编号)，容忍中间的修饰段：如 "AI应用开发工程师-北京-27届校招（15k-25k）(J10787)"
      const j = t.match(/([^【】\n<>{]{2,45}(?:工程师|算法|开发|测试|产品|设计|运营|研究员|顾问|专员|经理|助理|专家)).*?[（(]\s*[Jj]\d{3,6}\s*[)）]/);
      if (j) return { value: j[1].trim(), kind: 'jcode' };
    }
    return null;
  }

  // 岗位名容器选择器：覆盖 BEM(.job__title)、连字符(.job-title)、驼峰(.jobName) 等命名风格
  const POSITION_SELECTORS = [
    '.job__title', '.job-title', '.jobName', '.position-name', '.positionName',
    '.post-name', '.postName', '.job-name', '.job_name', '.position-title',
    '.detail-title', '.post-title',
  ];
  function firstCleanText(el) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, buf = '';
    while ((n = w.nextNode())) {
      const t = n.textContent.trim();
      if (!t) continue;
      if (t.length > 60) return buf.length >= 4 ? buf : null;
      if (isJunkPosition(t)) return buf.length >= 4 ? buf : null;
      // 短文本合并：标题被拆成多个节点时（"数据"+"（中文方向）"+"实习生"）拼接相邻文本
      if (buf && buf.length + t.length + 1 <= 60) buf += ' ' + t;
      else buf = buf || t;
      if (buf.length >= 4) return buf;
    }
    return buf.length >= 4 ? buf : null;
  }
  function fromPositionSelectors() {
    for (const sel of POSITION_SELECTORS) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (!el) continue;
      const t = firstCleanText(el);
      if (t) return t;
    }
    return null;
  }

  // 脚手架生成的类名：现在主流前端把随机后缀直接拼在类名后面（CSS Modules 的
  // page-job-detail_job-detail-title__c_vaI、emotion 的 jobTitle_1a2b3c、Vue scoped 的 xxx_a1b2c），
  // 上面那张手写风格的选择器表一个都匹配不到 —— 而这类页面恰恰最多。
  // 通用规则：先去掉随机后缀拿到"语义部分"，再要求它同时出现
  // ① 职务容器词（job/position/post/recruit/career…）② 部位词（title/name/head）——
  // 于是 company-title、article-title 这些同形不同义的类名不会被误收
  const CLASS_HASH_RE = [
    /__[A-Za-z0-9_-]{2,}$/,                   // __c_vaI（CSS Modules / BEM 变体）
    /[_-](?=[a-z0-9]*\d)[a-z0-9]{4,}$/i,      // _1a2b3c（哈希尾巴必须含数字，否则会把 job-title 的 -title 削掉）
  ];
  const semanticToken = (cls) => String(cls || '').split(/\s+/).filter(Boolean)
    .map((c) => CLASS_HASH_RE.reduce((s, re) => s.replace(re, ''), c))
    .join('-');
  const POS_TITLE_TOKEN_RE =
    /(?:^|[-_])(?:job|jobs|position|post|recruit|recruitment|vacancy|career|apply)[-_]?(?:detail[-_]?)?(?:title|name|head|header)(?:$|[-_])/i;
  function depthOf(el) { let d = 0; for (let p = el; p; p = p.parentElement) d++; return d; }
  function fromSemanticClass() {
    let els;
    // 属性选择器先粗筛（比遍历全部元素便宜），再用语义类名精筛
    try { els = document.querySelectorAll('[class*="title" i], [class*="name" i], [class*="head" i]'); } catch { els = []; }
    const hits = [];
    let c = 0;
    for (const el of els) {
      if (++c > 4000) break;
      const tok = semanticToken(el.className);
      if (!tok || !POS_TITLE_TOKEN_RE.test(tok)) continue;
      // title/name 比 head 更可能正是标题本身；同一档取更深的容器（外层常把标签行、按钮也包进来）
      hits.push({ el, rank: /title|name/i.test(tok) ? 1 : 2 });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.rank - b.rank || depthOf(b.el) - depthOf(a.el));
    for (const h of hits.slice(0, 5)) {
      const t = firstCleanText(h.el);
      if (t) return t;
    }
    return null;
  }

  // 内嵌 JSON：SPA 常在 script 里塞 {"postName": "...", "companyName": "..."} 这类字段
  const EMBED_POSITION_KEYS = ['postName', 'jobName', 'jobTitle', 'positionName', 'postTitle', 'recruitPostName'];
  const EMBED_COMPANY_KEYS = ['companyName', 'corpName', 'orgName', 'tenantName', 'companyShortName'];
  function fromEmbeddedJson(keys, checker) {
    let scripts;
    try { scripts = document.querySelectorAll('script'); } catch { scripts = []; }
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text || text.length > 800000) continue;
      for (const k of keys) {
        const m = text.match(new RegExp('"' + k + '"\\s*:\\s*"([^"\\\\]{2,60})"'));
        if (m) {
          const v = m[1].trim();
          if (v && !checker(v)) return v;
        }
      }
    }
    return null;
  }

  // h1/h2 带岗位特征词且通过垃圾过滤
  function fromHeadings() {
    let heads;
    try { heads = document.querySelectorAll('h1, h2, h3'); } catch { heads = []; }
    for (const el of heads) {
      const t = (el.textContent || '').trim();
      if (t && t.length <= 60 && POSITION_WORD_RE.test(t) && !isJunkPosition(t)) return t;
    }
    return null;
  }

  // 页面上第一个"像岗位名"的短文本节点（兜底）
  function fromKeywordTextNode() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, c = 0;
    while ((n = w.nextNode()) && c < 8000) {
      c++;
      const parentTag = n.parentElement ? n.parentElement.tagName : '';
      if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'NOSCRIPT') continue;
      const t = n.textContent.trim();
      if (!t || t.length < 3 || t.length > 50) continue;
      if (POSITION_WORD_RE.test(t) && !isJunkPosition(t)) return t;
    }
    return null;
  }

  const ad = ADAPTERS.find((a) => a.host.test(HOST));
  const jsonLd = fromJsonLd();
  let jd = findJd();
  // JSON-LD 兜底：JobPosting.description 常含完整 JD
  if (!jd && jsonLd?.description && String(jsonLd.description).length >= 100) {
    jd = clean(String(jsonLd.description));
  }

  // ---- 多提取器候选 + 评分排序（popup 端再与已知公司字典/URL 租户融合） ----
  const positionCandidates = [];
  const companyCandidates = [];
  const addPos = (v, score, source) => {
    const t = String(v || '').trim();
    if (!isJunkPosition(t)) positionCandidates.push({ value: t, score, source });
  };
  const addCo = (v, score, source) => {
    const t = String(v || '').trim();
    if (!isJunkCompany(t)) companyCandidates.push({ value: t, score, source });
  };

  const domCompany = ad ? firstText(ad.company) : null;
  const domPosition = ad ? firstText(ad.position) : null;
  if (jsonLd?.company) addCo(jsonLd.company, 100, 'jsonld');
  if (jsonLd?.position) addPos(jsonLd.position, 100, 'jsonld');
  if (domCompany) addCo(domCompany, 95, 'dom');
  if (domPosition) addPos(domPosition, 95, 'dom');
  const pagePos = findPagePosition();
  if (pagePos) addPos(pagePos.value, pagePos.kind === 'jcode' ? 92 : 90, 'page');
  const selPos = fromPositionSelectors();
  if (selPos) addPos(selPos, 85, 'selector');
  const clsPos = fromSemanticClass();
  if (clsPos) addPos(clsPos, 84, 'class');
  const embPos = fromEmbeddedJson(EMBED_POSITION_KEYS, isJunkPosition);
  if (embPos) addPos(embPos, 88, 'json');
  const headPos = fromHeadings();
  if (headPos) addPos(headPos, 60, 'heading');
  const kwPos = fromKeywordTextNode();
  if (kwPos) addPos(kwPos, 55, 'keyword');

  const kw = fromMetaKeywords();
  if (kw) addCo(kw, 80, 'keywords');
  const embCo = fromEmbeddedJson(EMBED_COMPANY_KEYS, isJunkCompany);
  if (embCo) addCo(embCo, 78, 'json');
  let ogSite = '';
  try { ogSite = document.querySelector('meta[property="og:site_name"]')?.content || ''; } catch { ogSite = ''; }
  if (ogSite.trim()) addCo(ogSite.trim(), 75, 'meta');
  const cr = fromCopyright();
  if (cr) addCo(cr, 70, 'copyright');

  // 同值去重保留最高分，再按分数降序
  const dedupe = (list) => {
    const seen = new Map();
    for (const c of list) {
      const prev = seen.get(c.value);
      if (!prev || c.score > prev.score) seen.set(c.value, c);
    }
    return [...seen.values()].sort((a, b) => b.score - a.score);
  };
  const posRanked = dedupe(positionCandidates);
  const coRanked = dedupe(companyCandidates);

  return {
    jd,
    company: domCompany,
    position: domPosition,
    companyHints: coRanked,
    positionHints: posRanked,
    companyCandidates: coRanked,
    positionCandidates: posRanked,
    titleHint: posRanked[0]?.value || null,
    url: location.href,
    title: document.title,
  };
})()
