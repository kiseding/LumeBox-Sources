// LumeSource: {"id":"tingyou_audio","name":"听友听书（有声）","version":"1.0.0","category":"audiobook","contentCategory":"movie","mediaType":"audio","settingsApiVersion":2,"network":"direct","mirrors":["https://fmfm.tingyou.fm","https://www.tingyou.fm","https://tingyou.fm"],"icon":"https://fmfm.tingyou.fm/favicon.svg","settings":[{"key":"note","type":"info","title":"站点说明","description":"听友听书（tingyou.fm）的有声频道：热门 / 推荐 / 最新三张榜 + 有声小说 35 个题材 + 评书 17 个题材，播放是站点自己的 mp3 直链（实测 206 + audio/mpeg），免登录、免代理。同一个站点还有一个「听友听书」综合源（影视 + 听书，在视频板块），本源的差别是只做有声、直接出现在有声板块。"}]}

// 听友听书 · 有声源（https://www.tingyou.fm/listening）——
// 站点是 Nuxt3 SSR 外壳，听书数据全走明文 JSON 接口：
//   GET  {api}/h5/listening/filters                        → sorts[] + categories[{id,name,types[]}]
//   GET  {api}/h5/listening/category?category=&type=&sort=&page=N  → {data[], page, pages}（固定 20 条/页）
//   GET  {api}/h5/listening/rank?section=hot|recommend|latest&page=N → {items[], has_more}
//   GET  {api}/h5/listening/album/{id}                     → 专辑（title / synopsis / count / cat / cover_url）
//   GET  {api}/h5/listening/chapters/{id}                  → 一次给全（《剑来》5329 章）
//   POST {api}/h5/listening/play {album_id, chapter_idx}    → {play_url}（mp3，现取现用）
//   POST {api}/h5/listening/search {keyword, page}          → {results[], has_more}
//
// 请求头必须带 x-listening-session（v4 UUID，脚本生成后存 fs）、x-listening-timezone，
// 以及 Origin / Referer —— 缺 Origin/Referer 时接口直接 404（不是站点改版）。
// 分类参数名是 category（2=有声小说 / 1=评书）与 type（题材 id）；cat / category_id 会被静默忽略。
//
// 接口域名会轮换：站方用一份加密的「启动头」下发当前 api_hosts（[密文][key 32B][iv 16B]，
// AES-256-CBC），本源解头 + 逐个探活（/time/seconds → {"code":0}）并缓存 6 小时，
// 解不出或全探不通时退回内置域名（实测 appp.fdhtbd.cn 会阶段性 404，另两个正常）。

var SITE_SEED = 'https://fmfm.tingyou.fm';
var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

var API_FALLBACKS = [
  'https://appp.fdhtbz.cn/api',
  'https://ffggewvge.dasfrvvbbhhafdgserqw.cc/api',
  'https://fsfggqwewrr.dsafasfvvaaee.cc/api'
];
var HEAD_URLS = [
  'https://toudnbbaa.tou1laopao.cc/api/startup-head/h5api.dat',
  'https://toudnbbaa.toulaopao1.cc/api/startup-head/h5api.dat'
];

var API_TTL = 6 * 3600 * 1000;

var CAT_FIXED = [
  { id: 'ar:hot', title: '热门榜' },
  { id: 'ar:recommend', title: '推荐榜' },
  { id: 'ar:latest', title: '最新上架' },
  { id: 'a:2', title: '有声小说' },
  { id: 'a:1', title: '评书' }
];

// 站点题材表里会混进空题材：实测「古代言情」（type=56）分类页 0 条，
// 挂出来只会让用户点进空列表，所以直接跳过（其余 51 个题材都实测有内容）。
var EMPTY_TYPES = { '56': 1 };

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

function needs(value) {
  return value != null && text(value).length > 0;
}

function siteOrigin() {
  var domain = '';
  try {
    domain = text(LumeSource.config && LumeSource.config.domain);
  } catch (error) {
    domain = '';
  }
  var base = trimSlash(domain) || SITE_SEED;
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return trimSlash(base);
}

// 沙箱里不保证有 Buffer / TextEncoder，自带一份字节工具（解「启动头」要用）
var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToB64(bytes) {
  var out = '';
  var i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS.charAt((n >> 18) & 63) + B64_CHARS.charAt((n >> 12) & 63) +
      B64_CHARS.charAt((n >> 6) & 63) + B64_CHARS.charAt(n & 63);
  }
  var rest = bytes.length - i;
  if (rest === 1) {
    var a = bytes[i] << 16;
    out += B64_CHARS.charAt((a >> 18) & 63) + B64_CHARS.charAt((a >> 12) & 63) + '==';
  } else if (rest === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS.charAt((b >> 18) & 63) + B64_CHARS.charAt((b >> 12) & 63) +
      B64_CHARS.charAt((b >> 6) & 63) + '=';
  }
  return out;
}

function b64ToBytes(input) {
  var raw = text(input).replace(/[^A-Za-z0-9+/=]/g, '');
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < raw.length; i += 1) {
    var ch = raw.charAt(i);
    if (ch === '=') break;
    var value = B64_CHARS.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function bytesToUtf8(bytes) {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var byte = bytes[i];
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      i += 1;
    } else if (byte >= 0xf0) {
      var cp = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 4;
    } else if (byte >= 0xe0) {
      out += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if (byte >= 0xc0) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(byte);
      i += 1;
    }
  }
  return out;
}

function uuid4() {
  var out = '';
  for (var i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += '89ab'.charAt(Math.floor(Math.random() * 4));
    } else {
      out += Math.floor(Math.random() * 16).toString(16);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 沙箱存储

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

var memoIds = {};
var idPending = {};

async function idOf(key) {
  if (memoIds[key]) return memoIds[key];
  if (idPending[key]) return await idPending[key];
  var work = (async function () {
    var saved = await readJson(key);
    if (saved && needs(saved.value)) return text(saved.value);
    var value = uuid4();
    await writeJson(key, { value: value });
    return value;
  })();
  idPending[key] = work;
  try {
    var resolved = await work;
    memoIds[key] = resolved;
    return resolved;
  } finally {
    delete idPending[key];
  }
}

async function toolsCall(name, payload) {
  var tools = LumeSource.tools;
  if (!tools || typeof tools[name] !== 'function') {
    throw new Error('当前运行环境缺少 tools.' + name + '（解析接口域名需要宿主原生解密）');
  }
  return await tools[name](payload);
}

// ------------------------------------------------------------------ 接口域名（站方加密启动头）

var apiState = { base: '', at: 0 };
var apiPending = null;

function normalizeApiBase(value) {
  var base = trimSlash(text(value));
  if (!/^https?:\/\//i.test(base)) return '';
  return /\/api$/i.test(base) ? base : base + '/api';
}

async function decodeHead(reply) {
  var b64 = reply && (reply.bodyBase64 || '');
  if (!needs(b64)) return null;
  var bytes = b64ToBytes(b64);
  if (bytes.length < 96) return null;
  var keyB64 = bytesToB64(bytes.slice(bytes.length - 48, bytes.length - 16));
  var ivB64 = bytesToB64(bytes.slice(bytes.length - 16));
  var cipherB64 = bytesToB64(bytes.slice(0, bytes.length - 48));
  var plainB64 = '';
  try {
    plainB64 = await toolsCall('aes', { key: keyB64, iv: ivB64, data: cipherB64, mode: 'CBC', encrypt: false });
  } catch (error) {
    plainB64 = await toolsCall('aes', { key: keyB64, iv: ivB64, data: cipherB64, mode: 'CBC', encrypt: false, padding: 'none' });
  }
  var plain = bytesToUtf8(b64ToBytes(text(plainB64))).replace(/[\u0000-\u001f]+$/, '').trim();
  return JSON.parse(plain);
}

async function hostsFromHead() {
  for (var i = 0; i < HEAD_URLS.length; i += 1) {
    try {
      var reply = await LumeSource.http.request({
        url: HEAD_URLS[i],
        method: 'GET',
        binary: true,
        headers: { 'User-Agent': UA, 'Accept': 'application/octet-stream' }
      });
      if (!reply || num(reply.status, 0) !== 200) continue;
      if (!needs(reply.bodyBase64)) break; // 宿主不支持二进制回包：别白试第二个头地址
      var json = await decodeHead(reply);
      if (!json) continue;
      var hosts = [];
      var list = json.api_hosts || [];
      for (var h = 0; h < list.length; h += 1) {
        var base = normalizeApiBase(list[h]);
        if (base) hosts.push(base);
      }
      var contracts = json.api_host_contracts || [];
      for (var c = 0; c < contracts.length; c += 1) {
        var cb = normalizeApiBase(contracts[c] && contracts[c].base_url);
        if (cb && hosts.indexOf(cb) < 0) hosts.push(cb);
      }
      if (hosts.length) return hosts;
    } catch (error) {
      /* 换下一个头地址 */
    }
  }
  return [];
}

async function probeApi(base) {
  try {
    var origin = siteOrigin();
    var reply = await LumeSource.http.request({
      url: base + '/time/seconds',
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json', Origin: origin, Referer: origin + '/' }
    });
    if (!reply || num(reply.status, 0) !== 200) return false;
    var json = null;
    try {
      json = JSON.parse(text(reply.body));
    } catch (error) {
      json = null;
    }
    return !!(json && num(json.code, -1) === 0);
  } catch (error) {
    return false;
  }
}

async function resolveApiBase() {
  var saved = await readJson('api.json');
  if (saved && needs(saved.base) && Date.now() - num(saved.at, 0) < API_TTL) {
    apiState.base = text(saved.base);
    apiState.at = num(saved.at, 0);
    return apiState.base;
  }
  var candidates = [];
  var headed = await hostsFromHead();
  for (var i = 0; i < headed.length; i += 1) {
    if (candidates.indexOf(headed[i]) < 0) candidates.push(headed[i]);
  }
  for (var f = 0; f < API_FALLBACKS.length; f += 1) {
    if (candidates.indexOf(API_FALLBACKS[f]) < 0) candidates.push(API_FALLBACKS[f]);
  }
  for (var c = 0; c < candidates.length; c += 1) {
    if (await probeApi(candidates[c])) {
      apiState.base = candidates[c];
      apiState.at = Date.now();
      await writeJson('api.json', { base: apiState.base, at: apiState.at });
      return apiState.base;
    }
  }
  throw new Error('听友的接口域名都探不通（站方在轮换域名，稍后再试）');
}

async function apiBase(force) {
  if (!force && apiState.base && Date.now() - apiState.at < API_TTL) return apiState.base;
  if (apiPending) return await apiPending;
  apiPending = resolveApiBase();
  try {
    return await apiPending;
  } finally {
    apiPending = null;
  }
}

// ------------------------------------------------------------------ 听书接口

async function listeningSession() {
  return await idOf('listening-session.json');
}

async function h5(pathAndQuery, options) {
  var opt = options || {};
  var base = await apiBase();
  var origin = siteOrigin();
  var headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Origin': origin,
    'Referer': origin + '/',
    'x-listening-session': await listeningSession(),
    'x-listening-timezone': 'Asia/Shanghai'
  };
  var body;
  if (opt.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opt.body || {});
  }
  var reply = await LumeSource.http.request({
    url: base + pathAndQuery,
    method: opt.method || 'GET',
    headers: headers,
    body: body
  });
  var status = num(reply && reply.status, 0);
  var raw = reply && reply.body != null ? text(reply.body) : '';
  var json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (error) {
    json = null;
  }
  if (json) return json;
  if (status === 404 || status === 405) {
    // 接口域名阶段性 404（实测 appp 会这样）：换台重来一次
    var retryBase = await apiBase(true);
    var retry = await LumeSource.http.request({
      url: retryBase + pathAndQuery,
      method: opt.method || 'GET',
      headers: headers,
      body: body
    });
    var retryRaw = retry && retry.body != null ? text(retry.body) : '';
    try {
      var retryJson = retryRaw ? JSON.parse(retryRaw) : null;
      if (retryJson) return retryJson;
    } catch (error) {
      /* 落到下面的可读错误 */
    }
    throw new Error('听书接口暂时打不开（HTTP ' + num(retry && retry.status, 0) + '）');
  }
  throw new Error('听书接口返回异常（HTTP ' + status + '）');
}

// ------------------------------------------------------------------ 数据整形

function audioItem(raw) {
  var title = text(raw && raw.title) || '未命名专辑';
  var parts = [];
  if (needs(raw && raw.teller)) parts.push('播音 ' + text(raw.teller));
  else if (needs(raw && raw.author)) parts.push('作者 ' + text(raw.author));
  if (needs(raw && raw.cat)) parts.push(text(raw.cat));
  if (num(raw && raw.count, 0) > 0) parts.push(num(raw.count, 0) + ' 集');
  return {
    id: 'a:' + text(raw && raw.id),
    title: title,
    cover: text(raw && raw.cover_url).replace(/^http:\/\//i, 'https://'),
    subtitle: parts.join(' · '),
    mediaType: 'audio'
  };
}

async function audioList(query) {
  var q = query || {};
  var path = '/h5/listening/category?page=' + Math.max(1, num(q.page, 1)) + '&sort=' + text(q.sort || 'comprehensive');
  if (needs(q.category)) path += '&category=' + encodeURIComponent(text(q.category));
  if (needs(q.type)) path += '&type=' + encodeURIComponent(text(q.type));
  var json = await h5(path);
  var rows = json && json.data && json.data.length ? json.data : [];
  var page = num(json && json.page, num(q.page, 1));
  var pages = num(json && json.pages, page);
  var items = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i] && needs(rows[i].id) && needs(rows[i].title)) items.push(audioItem(rows[i]));
  }
  return { items: items, hasMore: pages > page };
}

async function audioRank(section, page) {
  var json = await h5('/h5/listening/rank?page=' + Math.max(1, num(page, 1)) + '&section=' + encodeURIComponent(text(section || 'hot')));
  var rows = json && json.items && json.items.length ? json.items : [];
  var items = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i] && needs(rows[i].id) && needs(rows[i].title)) items.push(audioItem(rows[i]));
  }
  return { items: items, hasMore: !!(json && json.has_more) };
}

async function audioSearch(keyword, page) {
  var json = await h5('/h5/listening/search', {
    method: 'POST',
    body: { keyword: text(keyword), page: Math.max(1, num(page, 1)) }
  });
  var rows = json && json.results && json.results.length ? json.results : (json && json.items ? json.items : []);
  var items = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i] && needs(rows[i].id) && needs(rows[i].title)) items.push(audioItem(rows[i]));
  }
  return { items: items, hasMore: !!(json && json.has_more) };
}

async function audioAlbum(albumId) {
  var json = await h5('/h5/listening/album/' + encodeURIComponent(albumId));
  if (!json || !needs(json.id)) return null;
  return json;
}

async function audioChapters(albumId) {
  var json = await h5('/h5/listening/chapters/' + encodeURIComponent(albumId));
  var rows = json && json.chapters && json.chapters.length ? json.chapters : [];
  var list = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (!row) continue;
    var index = num(row.index, i + 1);
    if (index < 1) index = i + 1;
    list.push({ index: index, title: text(row.title) || ('第 ' + index + ' 集') });
  }
  list.sort(function (a, b) {
    return a.index - b.index;
  });
  var out = [];
  for (var k = 0; k < list.length; k += 1) {
    out.push({ id: String(list[k].index), title: list[k].title });
  }
  return out;
}

async function audioContent(albumId, chapterId) {
  var index = num(chapterId, 0);
  if (!(index > 0)) throw new Error('章节序号无效：' + text(chapterId));
  var json = await h5('/h5/listening/play', {
    method: 'POST',
    body: { album_id: text(albumId), chapter_idx: index }
  });
  var url = text(json && json.play_url);
  if (!/^https?:\/\//i.test(url)) throw new Error('站点没有给出播放地址（该集可能需要登录或已下架）');
  var title = '';
  try {
    var album = await audioAlbum(albumId);
    if (album) title = text(album.title);
  } catch (error) {
    title = '';
  }
  return {
    kind: 'audio',
    url: url,
    title: title,
    headers: { 'User-Agent': UA, 'Referer': siteOrigin() + '/' }
  };
}

// ------------------------------------------------------------------ 分类

async function typeCategories() {
  var json = await h5('/h5/listening/filters');
  var cats = json && json.categories && json.categories.length ? json.categories : [];
  var out = [];
  for (var i = 0; i < cats.length; i += 1) {
    var cat = cats[i];
    if (!cat || !cat.types || !cat.types.length) continue;
    var prefix = text(cat.name) === '评书' ? '评书 · ' : '题材 · ';
    for (var k = 0; k < cat.types.length; k += 1) {
      var type = cat.types[k];
      if (!type || !needs(type.id)) continue;
      if (EMPTY_TYPES[text(type.id)]) continue;
      out.push({ id: 't:' + text(type.id), title: prefix + text(type.name) });
    }
  }
  return out;
}

function categoryOf(categoryId) {
  var id = text(categoryId);
  if (id.indexOf('ar:') === 0) return { kind: 'rank', section: id.slice(3) };
  if (id.indexOf('a:') === 0) {
    var parts = id.slice(2).split(':');
    return { kind: 'list', category: parts[0], type: parts[1] || '' };
  }
  if (id.indexOf('t:') === 0) return { kind: 'list', category: '', type: id.slice(2) };
  return { kind: 'rank', section: 'hot' };
}

// ------------------------------------------------------------------ 五个入口

var LumeSource = {
  id: 'tingyou_audio',
  name: '听友听书（有声）',
  version: '1.0.0',
  category: 'audiobook',
  contentCategory: 'movie',
  mediaType: 'audio',
  settingsApiVersion: 2,
  network: 'direct',
  mirrors: ['https://fmfm.tingyou.fm', 'https://www.tingyou.fm', 'https://tingyou.fm'],
  icon: 'https://fmfm.tingyou.fm/favicon.svg',
  settings: [
    {
      key: 'note',
      type: 'info',
      title: '站点说明',
      description: '听友听书的有声频道：三张榜 + 有声小说 / 评书全部题材，播放是站点自己的 mp3 直链，免登录。接口域名会轮换，源里会自己解「启动头」探活换台。'
    }
  ],

  async categories() {
    var list = [];
    for (var i = 0; i < CAT_FIXED.length; i += 1) list.push(CAT_FIXED[i]);
    try {
      var types = await typeCategories();
      for (var k = 0; k < types.length; k += 1) list.push(types[k]);
    } catch (error) {
      /* 题材拿不到就只给固定分类，不影响浏览 */
    }
    return list;
  },

  async home() {
    // 四块并发：冷启动（解头 + 探域名）也能压在一次调用的预算里
    var results = await Promise.all([
      audioRank('hot', 1).catch(function () { return { items: [] }; }),
      audioRank('recommend', 1).catch(function () { return { items: [] }; }),
      audioRank('latest', 1).catch(function () { return { items: [] }; }),
      audioList({ category: '2', page: 1, sort: 'comprehensive' }).catch(function () { return { items: [] }; })
    ]);
    var plan = [
      { index: 0, title: '热门榜', more: 'ar:hot' },
      { index: 1, title: '推荐榜', more: 'ar:recommend' },
      { index: 2, title: '最新上架', more: 'ar:latest' },
      { index: 3, title: '有声小说', more: 'a:2' }
    ];
    var sections = [];
    for (var i = 0; i < plan.length; i += 1) {
      var got = results[plan[i].index];
      if (got && got.items && got.items.length) {
        sections.push({ title: plan[i].title, moreUrl: plan[i].more, items: got.items.slice(0, 12) });
      }
    }
    if (!sections.length) throw new Error('听友听书：首页板块都没取到内容，稍后再试');
    return sections;
  },

  async list(argument) {
    var arg = argument || {};
    var page = Math.max(1, num(arg.page, 1));
    var keyword = text(arg.keyword).trim();
    if (keyword) return await audioSearch(keyword, page);
    var parsed = categoryOf(arg.categoryId);
    if (parsed.kind === 'rank') return await audioRank(parsed.section, page);
    // 站点分类页只有「综合排序」这一个稳定口径（叠加 popular/updated 会漏条），
    // 热度与最新由榜单分类承担
    return await audioList({ category: parsed.category, type: parsed.type, page: page, sort: 'comprehensive' });
  },

  async detail(argument) {
    var id = text(argument && argument.id);
    if (id.indexOf('a:') !== 0) return null;
    var album = await audioAlbum(id.slice(2));
    if (!album) return null;
    var parts = [];
    if (needs(album.teller)) parts.push('播音 ' + text(album.teller));
    if (needs(album.author)) parts.push('作者 ' + text(album.author));
    if (needs(album.cat)) parts.push(text(album.cat));
    if (num(album.count, 0) > 0) parts.push(num(album.count, 0) + ' 集');
    var detail = {
      id: id,
      title: text(album.title) || '未命名专辑',
      cover: text(album.cover_url).replace(/^http:\/\//i, 'https://'),
      subtitle: parts.join(' · '),
      description: text(album.synopsis),
      mediaType: 'audio'
    };
    if (needs(album.author)) detail.author = text(album.author);
    return detail;
  },

  async chapters(argument) {
    var id = text(argument && argument.id);
    if (id.indexOf('a:') !== 0) return [];
    return await audioChapters(id.slice(2));
  },

  async content(argument) {
    var arg = argument || {};
    var id = text(arg.id);
    if (id.indexOf('a:') !== 0) throw new Error('未知内容：' + id);
    return await audioContent(id.slice(2), text(arg.chapterId));
  }
};
