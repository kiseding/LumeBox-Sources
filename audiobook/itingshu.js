// LumeSource: {"id":"itingshu_audiobook","name":"爱听书","version":"1.0.0","category":"audiobook","contentCategory":"movie","mediaType":"audio","settingsApiVersion":2,"network":"direct","mirrors":["https://www.itingshu.net","https://itingshu.net"],"icon":"https://www.itingshu.net/cdn/itingshu/image/192x192.jpg","settings":[{"key":"note","type":"info","title":"站点说明","description":"爱听书（itingshu.net）是免费有声小说站：16 个题材分类 + 排序/状态/集数筛选 + 站内搜索；目录按 50 集一页自动翻完（实测 1705 集的书 35 页），播放地址由站点播放器的 /api/mapi/play 现取（mp3 / m4a 直链）。全程免登录，不需要代理。"}]}

// 爱听书 · 有声源（https://www.itingshu.net）——
// 站结构（2026-11 实测）：
//   首页 /                            分类导航、最近更新、最新上架
//   分类 /yousheng/{分类}/{排序}/{集数}/{页码}.html   （分类=all + 14 个题材 + pingshu；
//        排序/状态同一个槽位：lastupdate / postdate / allvisit / marknum / votenum / lianzai / over；
//        集数档：1 全部 / 2 500 集以下 / 3 500-1000 / 4 1000 集以上；每页 10 条，页码可深翻）
//   完本 /over/lastupdate/{页码}.html、排行 /paihang/allvisit.html（表格，无封面，不单独做分类）
//   详情 /youshengxiaoshuo/{书号}/       标题、封面、类型、状态、作者、演播、简介、最新 8 集
//   目录 /itingshus/{a}/{b}.html?page=N&sort=asc   ← 路径带每次请求都变的令牌，必须从详情页现取；
//        一页 50 集，页码列表给出总页数（1705 集 = 35 页）
//   播放 /play/{书号}_1_{章节ID}.html      页面 meta 里带播放凭据：
//        _b=nid、_p=cid、_d=sort（read）、_c=sc；再 POST /api/mapi/play（表单 nid/cid/sort，
//        头 sc=上面那个值、sp=dencode(sc)）→ {status:200,url}，url 是 mp3 / m4a 直链
//        （实测 200/206 + audio/mpeg、audio/mp4）。缺 sc/sp 时服务端回 405「参数错误」并给一条
//        不相干的历史地址，所以两处凭据都必须带。
//   搜索 POST /novelsearch/search/result.html（表单 searchword=）→ 结果页 list-works 卡片
//
// 站点首访有 cookie 门：无 cookie 时回 403 + 一个 session cookie，带上 cookie 再来就 200。
// App 的会话池会自动收下 Set-Cookie 并回填，所以这里只在 403 时重试一次。

var SEED = 'https://www.itingshu.net';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var DIR_CHUNK = 8;           // chapterPage 一批取 8 页（400 集）
var DIR_MAX_PAGES = 200;     // 兜底上限（1 万集），避免异常页码把调用拖死
var DIR_TTL = 6 * 3600 * 1000;

var CATS = [
  { id: 'all', title: '全部有声' },
  { id: 'xuanhuan', title: '玄幻修真' },
  { id: 'dushi', title: '都市言情' },
  { id: 'junshi', title: '军事历史' },
  { id: 'lingyi', title: '灵异惊悚' },
  { id: 'jingji', title: '网游竞技' },
  { id: 'guanchangshangzhan', title: '官场商战' },
  { id: 'wenxue', title: '通俗文学' },
  { id: 'chuanji', title: '人物传记' },
  { id: 'jishi', title: '经典纪实' },
  { id: 'bjjt', title: '百家讲坛' },
  { id: 'xiangsheng', title: '相声戏曲' },
  { id: 'yule', title: '综艺娱乐' },
  { id: 'ertong', title: '儿童故事' },
  { id: 'qita', title: '其他有声' },
  { id: 'pingshu', title: '长篇评书' }
];

// ------------------------------------------------------------------ 基础工具

function text(value) {
  return value == null ? '' : String(value);
}

function num(value, fallback) {
  var parsed = Number(value);
  return isFinite(parsed) ? parsed : fallback;
}

function trimSlash(value) {
  return text(value).replace(/\/+$/, '');
}

function base() {
  var domain = '';
  try {
    domain = text(LumeSource.config && LumeSource.config.domain);
  } catch (error) {
    domain = '';
  }
  var host = trimSlash(domain) || SEED;
  if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
  return trimSlash(host);
}

function clean(value) {
  return text(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 站点的封面文件名里带中文（如 cover/yousheng/小说连播.gif），只补非 ASCII 的百分号编码，
// 已有的 %XX 不重复编码
function escapeNonAscii(value) {
  var raw = text(value);
  var out = '';
  for (var i = 0; i < raw.length; i += 1) {
    var ch = raw.charAt(i);
    var code = raw.charCodeAt(i);
    if (code < 128) {
      out += ch;
      continue;
    }
    out += encodeURIComponent(ch);
  }
  return out;
}

function absUrl(value) {
  var raw = text(value).trim();
  if (!raw) return '';
  if (raw.indexOf('//') === 0) raw = 'https:' + raw;
  else if (raw.charAt(0) === '/') raw = base() + raw;
  else if (!/^https?:\/\//i.test(raw)) raw = base() + '/' + raw;
  return escapeNonAscii(raw);
}

function headers(extra) {
  var out = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': base() + '/'
  };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
    }
  }
  return out;
}

async function get(path, options) {
  var opt = options || {};
  var url = /^https?:\/\//i.test(text(path)) ? text(path) : base() + path;
  var reply = await LumeSource.http.get(url, { headers: headers(opt.headers) });
  var status = num(reply && reply.status, 0);
  var body = reply && reply.body != null ? text(reply.body) : '';
  if (status === 403 || status === 0) {
    // 首访 cookie 门：宿主会话池已经收下 Set-Cookie，带 cookie 重来一次即可
    reply = await LumeSource.http.get(url, { headers: headers(opt.headers) });
    status = num(reply && reply.status, 0);
    body = reply && reply.body != null ? text(reply.body) : '';
  }
  if (status !== 200) throw new Error('爱听书：请求失败（HTTP ' + status + '）');
  if (!body) throw new Error('爱听书：返回了空页面，稍后再试');
  return body;
}

async function post(path, form, extraHeaders) {
  var url = /^https?:\/\//i.test(text(path)) ? text(path) : base() + path;
  var head = headers(extraHeaders);
  head['Content-Type'] = 'application/x-www-form-urlencoded';
  head['X-Requested-With'] = 'XMLHttpRequest';
  var reply = await LumeSource.http.request({ url: url, method: 'POST', headers: head, body: form });
  var status = num(reply && reply.status, 0);
  var body = reply && reply.body != null ? text(reply.body) : '';
  if (status === 403) {
    reply = await LumeSource.http.request({ url: url, method: 'POST', headers: head, body: form });
    status = num(reply && reply.status, 0);
    body = reply && reply.body != null ? text(reply.body) : '';
  }
  return { status: status, body: body };
}

async function readJson(key) {
  try {
    var raw = await LumeSource.fs.readText(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function writeJson(key, value) {
  try {
    await LumeSource.fs.writeText(key, JSON.stringify(value));
  } catch (error) {
    /* 存储失败不影响本次调用 */
  }
}

// 并发池：目录要一次翻几十页，串行会超时
async function pool(tasks, limit) {
  var out = [];
  var index = 0;
  var size = Math.max(1, Math.min(num(limit, 6), tasks.length || 1));
  var workers = [];
  for (var w = 0; w < size; w += 1) {
    workers.push((async function () {
      while (index < tasks.length) {
        var at = index;
        index += 1;
        try {
          out[at] = await tasks[at]();
        } catch (error) {
          out[at] = { error: text(error && error.message) };
        }
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ 列表解析

function episodeLabel(block) {
  var eps = /(?:连载至|完结至|更新至)(第?\d+集)/.exec(block);
  return eps ? eps[1] : '';
}

function parseItems(html) {
  var source = text(html);
  var out = [];
  var seen = {};
  var re = /<li>([\s\S]*?)<\/li>/g;
  var match;
  while ((match = re.exec(source)) !== null) {
    var block = match[1] || '';
    var link = /<a class="thumb"href="\/youshengxiaoshuo\/(\d+)\/"(?:[^>]*?)title="([^"]*)"/.exec(block);
    if (!link) continue;
    var id = link[1];
    if (seen[id]) continue;
    seen[id] = 1;
    var title = clean(link[2]).replace(/有声小说$/, '').trim();
    if (!title) title = '有声书 ' + id;
    var cover = (/<img[^>]*(?:data-original|src)="([^"]+)"/.exec(block) || [])[1] || '';
    var parts = [];
    var teller = /<a href="\/boyin\/\d+\.html"title="([^"]*?)作品集">/.exec(block);
    if (teller && text(teller[1]).trim()) parts.push('演播 ' + clean(teller[1]));
    var state = /<span class="(ztlz|ztwj)">([^<]*)<\/span>/.exec(block);
    if (state) parts.push(clean(state[2]));
    var eps = episodeLabel(block);
    if (eps) parts.push(eps);
    out.push({
      id: id,
      title: title,
      cover: absUrl(cover),
      subtitle: parts.join(' · '),
      mediaType: 'audio'
    });
  }
  return out;
}

function hasNextPage(html, path) {
  return text(html).indexOf(path) >= 0;
}

// ------------------------------------------------------------------ 分类 / 筛选项

function orderOf(filters) {
  var raw = text(filters && (filters.order || filters.sort));
  var value = raw.split(',')[0] || 'lastupdate';
  return /^(lastupdate|postdate|allvisit|marknum|votenum|lianzai|over)$/.test(value) ? value : 'lastupdate';
}

function lengthOf(filters) {
  // 路径第三段固定 1：站点侧栏的「集数」档服务端不生效（实测 1/2/4 三页内容相同）
  var raw = text(filters && filters.len);
  var value = raw.split(',')[0] || '1';
  return /^[1-4]$/.test(value) ? value : '1';
}

function catOf(categoryId) {
  var id = text(categoryId).trim();
  if (!id) return 'all';
  for (var i = 0; i < CATS.length; i += 1) {
    if (CATS[i].id === id) return id;
  }
  return 'all';
}

function catPath(cat, order, len, page) {
  return '/yousheng/' + cat + '/' + order + '/' + len + '/' + Math.max(1, num(page, 1)) + '.html';
}

// ------------------------------------------------------------------ 搜索

async function searchItems(keyword) {
  var reply = await post('/novelsearch/search/result.html', 'searchword=' + encodeURIComponent(text(keyword)));
  if (reply.status !== 200 || !reply.body) throw new Error('爱听书：搜索失败（HTTP ' + reply.status + '）');
  return parseItems(reply.body);
}

// ------------------------------------------------------------------ 目录

function dirAnchor(html) {
  var m = /<a href="(\/itingshus\/[^"]+)"class="dirurl"/.exec(text(html));
  if (m) return m[1];
  var m2 = /<a href="(\/itingshus\/[^"]+)"title="[^"]*播放列表"/.exec(text(html));
  return m2 ? m2[1] : '';
}

function dirPages(html) {
  var max = 1;
  var re = /page=(\d+)&sort=asc/g;
  var m;
  while ((m = re.exec(text(html))) !== null) {
    var value = num(m[1], 1);
    if (value > max) max = value;
  }
  return max;
}

function parseDir(html) {
  var out = [];
  var re = /<a title="([^"]*?)第(\d+)集"href="\/play\/(\d+)_1_(\d+)\.html"[^>]*>([^<]*)<\/a>/g;
  var m;
  while ((m = re.exec(text(html))) !== null) {
    var chapterId = m[4];
    var label = clean(m[5]);
    out.push({ chapterId: chapterId, title: label || ('第 ' + num(m[2], 0) + ' 集') });
  }
  return out;
}

// 目录地址里的令牌（/itingshus/{a}/{b}.html）在同一本书上是稳定的，可以缓存复用；
// 万一站点换了令牌，取页失败时会回详情页重新取一次。
async function dirPathOf(bookId, force) {
  var key = 'dirpath-' + bookId + '.json';
  if (!force) {
    var saved = await readJson(key);
    if (saved && text(saved.path) && Date.now() - num(saved.at, 0) < DIR_TTL) return text(saved.path);
  }
  var detail = await get('/youshengxiaoshuo/' + bookId + '/');
  var path = dirAnchor(detail);
  if (!path) throw new Error('爱听书：这本书没有目录入口（可能已下架）');
  await writeJson(key, { at: Date.now(), path: path });
  return path;
}

async function readDirPage(bookId, page) {
  var dirPath = await dirPathOf(bookId, false);
  var url = dirPath + '?page=' + page + '&sort=asc';
  var html;
  try {
    html = await get(url);
  } catch (error) {
    dirPath = await dirPathOf(bookId, true);
    html = await get(dirPath + '?page=' + page + '&sort=asc');
  }
  var rows = parseDir(html);
  for (var i = 0; i < rows.length; i += 1) {
    rows[i].page = page;
    rows[i].seq = i;
  }
  return { rows: rows, maxPage: Math.min(DIR_MAX_PAGES, dirPages(html)) };
}

// 站点目录是「按页码顺序」的，同一页内保持页面顺序，所以合批后按 (页码, 页内序号) 排，
// 不用章节名里的数字（有的书名里带日期、有的标题编号与目录序号错位）。
function mergeRows(batches) {
  var rows = [];
  var seen = {};
  for (var b = 0; b < batches.length; b += 1) {
    var batch = batches[b] || [];
    for (var k = 0; k < batch.length; k += 1) {
      var row = batch[k];
      if (!row || !row.chapterId || seen[row.chapterId]) continue;
      seen[row.chapterId] = 1;
      rows.push(row);
    }
  }
  rows.sort(function (a, b2) {
    if (num(a.page, 0) !== num(b2.page, 0)) return num(a.page, 0) - num(b2.page, 0);
    return num(a.seq, 0) - num(b2.seq, 0);
  });
  return rows;
}

// 一次取 DIR_CHUNK 页（每页 50 集）→ 400 集/批。单页要 0.3–1 秒，串行翻 100 页会拖过调用预算，
// 所以批内并发、批与批之间交给 App 的 chapterPage 循环。
async function chapterChunk(bookId, chunk) {
  var index = Math.max(1, num(chunk, 1));
  var start = (index - 1) * DIR_CHUNK + 1;
  var first = await readDirPage(bookId, start);
  var maxPage = first.maxPage;
  if (start > maxPage) return { items: [], nextPage: null };
  var batches = [first.rows];
  var tasks = [];
  for (var page = start + 1; page <= Math.min(maxPage, start + DIR_CHUNK - 1); page += 1) {
    tasks.push((function (p) {
      return function () {
        return readDirPage(bookId, p).then(function (result) { return result.rows; });
      };
    })(page));
  }
  if (tasks.length) {
    var results = await pool(tasks, DIR_CHUNK);
    for (var i = 0; i < results.length; i += 1) {
      if (Array.isArray(results[i]) && results[i].length) batches.push(results[i]);
    }
  }
  var rows = mergeRows(batches);
  var items = [];
  for (var k = 0; k < rows.length; k += 1) {
    items.push({ id: rows[k].chapterId, title: rows[k].title });
  }
  var lastPage = start + DIR_CHUNK - 1;
  return { items: items, nextPage: lastPage < maxPage ? index + 1 : null };
}

async function collectChapters(bookId) {
  var key = 'dir-' + bookId + '.json';
  var cached = await readJson(key);
  if (cached && cached.list && cached.list.length && Date.now() - num(cached.at, 0) < DIR_TTL) {
    return cached.list;
  }
  var first = await readDirPage(bookId, 1);
  var maxPage = first.maxPage;
  var batches = [first.rows];
  var tasks = [];
  for (var page = 2; page <= maxPage; page += 1) {
    tasks.push((function (p) {
      return function () {
        return readDirPage(bookId, p).then(function (result) { return result.rows; });
      };
    })(page));
  }
  if (tasks.length) {
    var results = await pool(tasks, 12);
    for (var i = 0; i < results.length; i += 1) {
      if (Array.isArray(results[i]) && results[i].length) batches.push(results[i]);
    }
  }
  var rows = mergeRows(batches);
  var list = [];
  for (var r = 0; r < rows.length; r += 1) {
    list.push({ id: rows[r].chapterId, title: rows[r].title });
  }
  if (list.length) await writeJson(key, { at: Date.now(), list: list });
  return list;
}

// ------------------------------------------------------------------ 播放凭据（站点播放器自己的签名）

var SP_CHARSET = 'PXhw7U1B0a9kQDKZsTjIASmOeNzxYG4CHo1JyRfg2b8FLpEvr3FtVnlqMidu6c';

// 站点播放器里的 dencode(sc)：逐字符按表位移 +3（模 62），前后各插一个随机表内字符
function dencode(value) {
  var input = text(value);
  var out = '';
  for (var i = 0; i < input.length; i += 1) {
    var at = SP_CHARSET.indexOf(input.charAt(i));
    var shifted = at < 0 ? input.charAt(i) : SP_CHARSET.charAt((at + 3) % 62);
    out += SP_CHARSET.charAt(Math.floor(Math.random() * 62)) + shifted + SP_CHARSET.charAt(Math.floor(Math.random() * 62));
  }
  return out;
}

function metaOf(html, name) {
  var m = new RegExp('<meta name="' + name + '"content="([^"]*)"').exec(text(html));
  return m ? m[1] : '';
}

async function resolveAudio(bookId, chapterId) {
  var playPath = '/play/' + bookId + '_1_' + chapterId + '.html';
  var html = await get(playPath);
  var nid = metaOf(html, '_b');
  var cid = metaOf(html, '_p');
  var sort = metaOf(html, '_d') || 'read';
  var sc = metaOf(html, '_c');
  if (!nid || !cid || !sc) {
    // 章节不存在时站点会软跳回详情页，meta 全空
    throw new Error('爱听书：这一集没有播放凭据（章节可能已下架，或站点改了播放器）');
  }
  var form = 'nid=' + encodeURIComponent(nid) + '&cid=' + encodeURIComponent(cid) + '&sort=' + encodeURIComponent(sort);
  var reply = await post('/api/mapi/play', form, {
    'sc': sc,
    'sp': dencode(sc),
    'Referer': base() + playPath,
    'Origin': base()
  });
  var json = null;
  try {
    json = reply.body ? JSON.parse(reply.body) : null;
  } catch (error) {
    json = null;
  }
  if (!json) throw new Error('爱听书：播放接口返回的不是 JSON（HTTP ' + reply.status + '）');
  var status = num(json.status, 0);
  var url = text(json.url);
  // 站方自建音频会给站内相对路径（/cdn/xxx.mp3），外链（xmcdn / audio*.top）才是绝对地址
  if (url && !/^https?:\/\//i.test(url)) url = absUrl(url);
  if (status !== 200 || !/^https?:\/\//i.test(url)) {
    throw new Error('爱听书：站点没有给出音频地址（' + (text(json.msg) || ('状态 ' + status)) + '）');
  }
  return { url: url, name: clean(json.name) };
}

// ------------------------------------------------------------------ 五个入口

var LumeSource = {
  id: 'itingshu_audiobook',
  name: '爱听书',
  version: '1.0.0',
  category: 'audiobook',
  contentCategory: 'movie',
  mediaType: 'audio',
  settingsApiVersion: 2,
  network: 'direct',
  mirrors: ['https://www.itingshu.net', 'https://itingshu.net'],
  icon: 'https://www.itingshu.net/cdn/itingshu/image/192x192.png',
  settings: [
    {
      key: 'note',
      type: 'info',
      title: '站点说明',
      description: '免费有声小说站：16 个题材 + 排序/状态/集数筛选，站内搜索按书名/主播/作者命中；目录自动翻页取全（50 集一页），播放地址每次现取（mp3 / m4a 直链）。免登录、免代理。'
    }
  ],

  async categories() {
    var out = [];
    for (var i = 0; i < CATS.length; i += 1) out.push({ id: CATS[i].id, title: CATS[i].title });
    return out;
  },

  async filters() {
    // 站点侧栏虽然画了「集数」一档（/lastupdate/2|3|4/），但服务端不生效——实测
    // lastupdate/1、2、4 三页条目逐条相同，所以不声明这一组，避免假筛选。
    return [
      {
        key: 'order',
        title: '排序 / 状态',
        options: [
          { id: 'lastupdate', title: '最近更新' },
          { id: 'postdate', title: '最新上架' },
          { id: 'allvisit', title: '人气最高' },
          { id: 'marknum', title: '收藏最多' },
          { id: 'votenum', title: '推荐最多' },
          { id: 'lianzai', title: '连载中' },
          { id: 'over', title: '已完本' }
        ]
      }
    ];
  },

  async home() {
    var plan = [
      { title: '最近更新', path: catPath('all', 'lastupdate', '1', 1), more: 'all' },
      { title: '玄幻修真', path: catPath('xuanhuan', 'lastupdate', '1', 1), more: 'xuanhuan' },
      { title: '最新上架', path: catPath('all', 'postdate', '1', 1), more: 'all' },
      { title: '人气最高', path: catPath('all', 'allvisit', '1', 1), more: 'all' },
      { title: '都市言情', path: catPath('dushi', 'lastupdate', '1', 1), more: 'dushi' },
      { title: '已完本', path: catPath('all', 'over', '1', 1), more: 'all' }
    ];
    var tasks = [];
    for (var i = 0; i < plan.length; i += 1) {
      tasks.push((function (item) {
        return function () {
          return get(item.path).then(parseItems);
        };
      })(plan[i]));
    }
    var results = await pool(tasks, 4);
    var sections = [];
    for (var k = 0; k < plan.length; k += 1) {
      var items = results[k];
      if (!items || !items.length) continue;
      sections.push({ title: plan[k].title, moreUrl: plan[k].more, items: items.slice(0, 10) });
    }
    if (!sections.length) throw new Error('爱听书：首页板块都没取到内容，稍后再试');
    return sections;
  },

  async list(argument) {
    var arg = argument || {};
    var page = Math.max(1, num(arg.page, 1));
    var keyword = text(arg.keyword).trim();
    if (keyword) {
      var found = await searchItems(keyword);
      return { items: found, hasMore: false };
    }
    var cat = catOf(arg.categoryId);
    var order = orderOf(arg.filters);
    var len = lengthOf(arg.filters);
    var path = catPath(cat, order, len, page);
    var html = await get(path);
    var items = parseItems(html);
    if (!items.length && page === 1) {
      throw new Error('爱听书：这个分类第 1 页没有内容（站点分类可能改了）');
    }
    return { items: items, hasMore: hasNextPage(html, catPath(cat, order, len, page + 1)) };
  },

  async detail(argument) {
    var id = text(argument && argument.id).replace(/[^\d]/g, '');
    if (!id) return null;
    var html = await get('/youshengxiaoshuo/' + id + '/');
    var title = clean((/class="book-title"[^>]*>([\s\S]*?)<\/h1>/.exec(html) || [])[1] || '');
    if (!title) {
      var fallback = clean((/<meta property="og:title"content="([^"]*)"/.exec(html) || [])[1] || '');
      if (!fallback) return null;
      title = fallback;
    }
    title = title.replace(/有声小说$/, '').trim() || ('有声书 ' + id);
    var cover = absUrl((/<meta property="og:image"content="([^"]*)"/.exec(html) || [])[1] || '');
    if (!cover) {
      // 部分老书没有 og:image，封面在详情页左侧的 .book-img 里
      var at = html.indexOf('class="book-img"');
      if (at > 0) cover = absUrl((/<img[^>]*(?:data-original|src)="([^"]+)"/.exec(html.slice(at, at + 800)) || [])[1] || '');
    }
    var desc = clean((/<div class="book-des"[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1] || '');
    var author = clean((/title="([^"]*?) 作品全集"/.exec(html) || [])[1] || '');
    var parts = [];
    var cat = clean((/类型：<\/span><a[^>]*>([^<]*)<\/a>/.exec(html) || [])[1] || '');
    if (cat) parts.push(cat);
    var state = clean((/状态：<\/span>([^<]*)</.exec(html) || [])[1] || '');
    if (state) parts.push(state);
    var total = /目前更新至(\d+)集|共(\d+)集/.exec(html);
    if (total) parts.push((total[1] || total[2]) + ' 集');
    var tellers = [];
    var tellerRe = /<a href="\/boyin\/\d+\.html"title="([^"]*?) 演播全集">/g;
    var tellerMatch;
    while ((tellerMatch = tellerRe.exec(html)) !== null) {
      var name = clean(tellerMatch[1]);
      if (name && tellers.indexOf(name) < 0) tellers.push(name);
      if (tellers.length >= 3) break;
    }
    if (tellers.length) parts.push('演播 ' + tellers.join('、'));
    var result = {
      id: id,
      title: title,
      cover: cover,
      subtitle: parts.join(' · '),
      description: desc,
      mediaType: 'audio'
    };
    if (author) result.author = author;
    return result;
  },

  async chapters(argument) {
    var id = text(argument && argument.id).replace(/[^\d]/g, '');
    if (!id) return [];
    var list = await collectChapters(id);
    return list.map(function (row) {
      return { id: row.id, title: row.title };
    });
  },

  // 分批目录：App 认这个方法时按 nextPage 循环取，几千集的书也不会撞单次调用 10 秒上限
  async chapterPage(argument) {
    var arg = argument || {};
    var id = text(arg.id).replace(/[^\d]/g, '');
    if (!id) return { items: [], nextPage: null };
    var part = await chapterChunk(id, Math.max(1, num(arg.page, 1)));
    return {
      items: part.items.map(function (row) { return { id: row.id, title: row.title }; }),
      nextPage: part.nextPage
    };
  },

  async content(argument) {
    var arg = argument || {};
    var bookId = text(arg.id).replace(/[^\d]/g, '');
    var chapterId = text(arg.chapterId).replace(/[^\d]/g, '');
    if (!bookId || !chapterId) throw new Error('爱听书：缺少书籍或章节编号');
    var audio = await resolveAudio(bookId, chapterId);
    return {
      kind: 'audio',
      url: audio.url,
      title: audio.name || ('第 ' + chapterId + ' 集'),
      headers: { 'User-Agent': UA, 'Referer': base() + '/play/' + bookId + '_1_' + chapterId + '.html' }
    };
  }
};
