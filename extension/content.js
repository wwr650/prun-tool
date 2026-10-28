// PRUN 生产队列面板 —— Chrome 扩展（MV3）内容脚本
// 匹配规则写在 manifest.json 里，不进油猴，不依赖 GM_* 接口。

(function () {
  'use strict';

  // 油猴脚本和本扩展用同一套 DOM id，迁移期两个都在会互相盖住
  if (document.getElementById('prun-tab') || document.getElementById('prun-open')) return;

  var RECIPES_URL = 'https://api.prunplanner.org/data/recipes/';
  var K_RECIPES = 'prun.recipes.v1';
  var K_QUEUE = 'prun.queue.v1';
  var K_SCANNED = 'prun.scanned.v1';
  var K_LINES = 'prun.lines.v1';
  var K_TPLGROUP = 'prun.tplgroup.v1';
  var K_DRYRUN = 'prun.dryrun.v1';
  var K_RESUME = 'prun.resume.v1';

  // APEX 用 CSS Modules，类名带哈希后缀且随构建变化，只能按前缀匹配
  function byClass(root, part) {
    return Array.prototype.slice.call(root.querySelectorAll('[class*="' + part + '"]'));
  }
  function one(root, part) {
    return root ? root.querySelector('[class*="' + part + '"]') : null;
  }
  function text(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  // APEX 是 React，一次 commit 基本就落在下一帧；等两帧比睡固定毫秒可靠也快得多。
  // 后台标签页里 rAF 会停摆，所以留一个定时器兜底，不能让流程挂死
  function nextFrame() {
    return new Promise(function (r) {
      var fin = function () { clearTimeout(t); r(); };
      var t = setTimeout(fin, 120);
      requestAnimationFrame(function () { requestAnimationFrame(fin); });
    });
  }
  async function waitFor(fn, timeout, label) {
    var deadline = Date.now() + (timeout || 6000);
    var v = fn();
    // 前 8 轮每 25ms 探一次（绝大多数 UI 更新落在这一档），之后退回 120ms 省电
    for (var round = 0; !v && Date.now() < deadline; round++) {
      await sleep(round < 8 ? 25 : 120);
      v = fn();
    }
    if (v) return v;
    throw new Error('超时等待' + (label || '页面元素'));
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ---------------------------------------------------------------- storage

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 存储满时静默降级为内存态 */ }
  }

  // 内容脚本里的 fetch 走页面源，prunplanner 允许跨源（实测 APEX 页面直接 200）
  async function httpGetText(url) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 30000);
    var r;
    try {
      r = await fetch(url, { signal: ctl.signal });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '请求超时' : '请求失败（网络或被拦截）');
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  // ---------------------------------------------------------------- recipes

  var state = {
    recipes: lsGet(K_RECIPES, []),
    recipesAt: lsGet('prun.recipes.at', null),
    // 从 localStorage 恢复时同样过一遍 normalizeEntry：老数据/导入的 JSON 可能没有
    // on、line 这些字段，不补齐的话界面上显示「参与执行」而 runQueue 按 on=undefined 把它跳过
    queue: (lsGet(K_QUEUE, []) || []).map(normalizeEntry).filter(Boolean),
    scanned: lsGet(K_SCANNED, []),
    lines: lsGet(K_LINES, {}),
    lineMap: lsGet('prun.linemap', {}),
    filterOut: '',
    filterTicker: '',
    tplOut: '',
    tplLine: '',
    tplOpen: lsGet(K_TPLGROUP, {}),
    dryRun: lsGet(K_DRYRUN, false),
    // 执行前先读线上已排好的队列，从最后一单之后续排（默认开）
    resume: lsGet(K_RESUME, true),
    log: []
  };

  function itemsSig(items) {
    return (items || []).map(function (i) {
      return i.material_ticker + 'x' + Number(i.material_amount);
    }).sort().join('+') || '-';
  }
  function recipeSig(r) {
    return itemsSig(r.inputs) + '=>' + itemsSig(r.outputs);
  }
  function fmtMs(ms) {
    if (!ms) return '-';
    var d = Math.floor(ms / 86400000);
    var h = Math.floor(ms / 3600000) % 24;
    var m = Math.round(ms / 60000) % 60;
    if (m === 60) { m = 0; h++; if (h === 24) { h = 0; d++; } }
    var out = [];
    if (d) out.push(d + '天');
    if (h) out.push(h + '小时');
    if (m) out.push(m + '分');
    if (!out.length) out.push('<1分');
    return out.join(' ');
  }
  function recipeLabel(r) {
    var o = (r.outputs || []).map(function (i) { return i.material_ticker + i.material_amount; }).join(' ') || '空';
    var i = (r.inputs || []).map(function (i2) { return i2.material_ticker + i2.material_amount; }).join(' ') || '无';
    return i + ' => ' + o;
  }

  // 基地码优先取条目上存的，没存过（老队列、旧导入档）才按线名回查扫描结果
  function codeFor(e) {
    if (e.code) return e.code;
    if (!e.line || e.line === '自动') return '';
    var hit = state.scanned.filter(function (t) { return t.line === e.line && t.code; })[0];
    return hit ? hit.code : '';
  }

  // 星球码优先查 码→线 登记表（跟着当前瓦片走），再退回本次扫描结果
  function locFor(e) {
    var hit = infoFor(codeFor(e));
    if (hit && hit.loc) return hit.loc;
    if (!e.line || e.line === '自动') return '';
    var t = state.scanned.filter(function (x) { return x.line === e.line && x.sig === e.sig; })[0];
    return t ? t.loc : (hit ? hit.loc : '');
  }

  // 队列条目上的线标识：名字给眼睛看，队列 id 给同名基地做区分
  function entryTag(e) {
    var n = e.line || '自动';
    var c = codeFor(e);
    return (c && n.indexOf(c) < 0) ? n + ' PROD ' + c : n;
  }

  // 基地内部码是这条线的持久身份：`PROD bda98a38` 的 bda98a38。
  // 码→(线名, 星球码) 单独存一张表，状态栏和文件名都按当前瓦片上的码现查，
  // 所以切星球后重扫就会跟着变，不会一直显示上次扫描那个星球的信息
  function infoFor(code) {
    return (code && state.lines[code]) || null;
  }
  function locOfLine(line) {
    var hit = infoFor(line.code);
    return hit ? hit.loc : '';
  }
  function harvestLines(lines) {
    var changed = false;
    lines.forEach(function (l) {
      if (!l.code) return;
      var rec = state.lines[l.code] || (state.lines[l.code] = {});
      if (l.name && rec.name !== l.name) { rec.name = l.name; changed = true; }
      if (!rec.loc) rec.loc = '';
    });
    if (changed) lsSet(K_LINES, state.lines);
    return changed;
  }
  // 把当前瓦片上的线登记进 码→(线名, 星球码) 表；星球码只有开过下单框才拿得到，
  // 开不了对话框的线至少把名字和码保住，状态栏还能报出这条线是谁
  function harvestLine(line, loc) {
    if (!line.code) return loc || '';
    var rec = state.lines[line.code] || (state.lines[line.code] = {});
    rec.name = rec.name || line.name;
    if (rec.loc == null) rec.loc = '';
    if (loc && rec.loc !== loc) {
      rec.loc = loc;
      lsSet(K_LINES, state.lines);
    }
    return rec.loc || loc || '';
  }

  // 状态栏上的一条线：线名 + 星球码。队列 id 是整条队列（这个基地）共用的，
  // 上面那行瓦片 cmd 已经报了它，这里再逐条重复只会把状态栏撑爆
  function lineInfoText(line) {
    var hit = infoFor(line.code);
    var loc = hit && hit.loc ? hit.loc : '未扫描';
    return line.name + ' @' + loc;
  }

  // 队列条目下方那行：把用户选的参数复述一遍，控件挤掉也能看清方案
  function planText(e) {
    var p = [];
    var loc = locFor(e);
    p.push('线=' + entryTag(e) + (loc ? ' @ ' + loc : ''));
    p.push('大小=' + (e.size || 1));
    p.push(e.repeat ? '重复填满（下到该线队列满）' : '单次');
    p.push(e.autoFit === false ? '不降档' : '库存不足自动降档');
    p.push(e.on === false ? '已停用' : '参与执行');
    return '方案 ' + p.join(' · ');
  }

  // 一单耗时 = 配方单件时长 × 订单大小
  function orderMs(e) {
    return (e.time_ms || 0) * Math.max(1, e.size || 1);
  }
  // 勾了重复填满不再有次数上限——以这条线队列满为限，所以单数事先算不出来，
  // 用 Infinity 表示「只能靠读到队列满了才停」
  function orderCount(e) {
    return e.repeat ? Infinity : 1;
  }

  // ------------------------------------------------------- 工厂分组与续排

  // 条目产出的材料缩写：sig 形如 `NSx4+H2Ox2=>MUSx12`，取 => 右边的第一项。
  // 线上订单读回来的 ticker 就是同一套缩写，续排靠它把两边的位置对上。
  // 只认小写 x 后面紧跟数字的那一段，缩写本身都是大写（H2O / LBS），不会误剥
  function outTicker(e) {
    var right = String(e.sig || '').split('=>')[1] || '';
    if (!right || right === '-') return '';
    var first = right.split('+')[0].trim();
    var m = /^(.*?)x[\d.,]/.exec(first);
    return (m ? m[1] : first).trim().toUpperCase();
  }

  // 一条工厂（生产线）= 队列 id + 线名；还没定线的条目自成一组，执行时才找线
  function groupKey(e) {
    return codeFor(e) + '|' + (e.line && e.line !== '自动' ? e.line : '');
  }
  function groupLabel(e) {
    if (!e.line || e.line === '自动') return '未指定生产线';
    var loc = locFor(e);
    return entryTag(e) + (loc ? ' @ ' + loc : '');
  }
  // 按「首次出现」分组，组内保持数组顺序——那就是这一家的生产次序
  function groupQueue(list) {
    var groups = [];
    var byId = {};
    list.forEach(function (e) {
      var k = groupKey(e);
      var g = byId[k];
      if (!g) {
        g = byId[k] = { key: k, label: groupLabel(e), code: codeFor(e) || '',
          line: e.line && e.line !== '自动' ? e.line : '', entries: [] };
        groups.push(g);
      }
      g.entries.push(e);
    });
    return groups;
  }

  // 这一组对应哪条线：和 placeOnce 同一套口径（先用码锁基地，再用线名锁线），
  // 但范围是所有已打开的瓦片，不再只盯第一个
  function groupLine(groupsEntry, lines) {
    var code = groupsEntry.code;
    var name = groupsEntry.line;
    var here = code ? lines.filter(function (l) { return l.code === code; }) : lines;
    if (!here.length) return null;
    return name ? (matchNamed(here, name)[0] || null) : (code ? here[0] : null);
  }

  // 「重复填满」的停止条件：现场量这条线还剩几个空槽位。
  // 读不到线时返回 null（未知），调用方不能把未知当成满
  function groupFreeSlots(g) {
    var line = groupLine(g, allLines());
    return line ? line.free : null;
  }

  // 读这条线已经排好的队列，拿最后一单的产品缩写回查计划里的位置。
  // 返回 -1 表示「从头开始」，否则是「最后一单在组里的下标」，执行时从它下一条起
  function resumeIndex(group) {
    var lines = allLines();
    if (!lines.length) return { idx: -1, why: '页面上没有打开的生产列表瓦片，从第一条开始' };
    if (!group.line && !group.code) return { idx: -1, why: '这一组还没定生产线，从第一条开始' };
    var line = groupLine(group, lines);
    if (!line) return { idx: -1, why: '打开的生产列表里没有这一组（' + group.label +
      '），从第一条开始；要续排先把那个 PROD 窗口开着' };
    var orders = line.orders;
    if (!orders.length) return { idx: -1, why: '线上没有订单（空槽位 ' + line.free + '），从第一条开始' };
    var last = orders[orders.length - 1];
    var tk = String(last.ticker || '').toUpperCase();
    if (!tk) return { idx: -1, why: '线上最后一单读不出产物缩写，从第一条开始' };
    var idx = -1;
    group.entries.forEach(function (e, i) {
      if (outTicker(e) === tk) idx = i;   // 计划里同产物出现多次时取最后一次，那就是走得更远的一处
    });
    if (idx < 0) return { idx: -1, why: '线上最后一单 ' + tk + ' 不在这组的计划里，从第一条开始' };
    var next = idx + 1 < group.entries.length ? outTicker(group.entries[idx + 1]) || group.entries[idx + 1].label : '';
    return {
      idx: idx,
      why: '线上最后一单 ' + tk + '（' + last.qty + ' ' + last.eta + '，' +
        (last.queued ? '排队' : '进行中') + '）= 计划第 ' + (idx + 1) + '/' + group.entries.length + ' 条，' +
        (next ? '从第 ' + (idx + 2) + ' 条 ' + next + ' 起续排' : '它已是本组最后一条，下一条回到组首')
    };
  }
  function timeText(e) {
    if (!e.time_ms) return '耗时未知（本地模板没读到时长）';
    var one = orderMs(e);
    var n = orderCount(e);
    return '耗时 单件 ' + fmtMs(e.time_ms) + ' × 大小 ' + Math.max(1, e.size || 1) +
      ' = 一单 ' + fmtMs(one) +
      (n === Infinity ? '（重复填满：下到该线队列满，总单数不固定）' :
        (n > 1 ? ' × ' + n + ' 单 = ' + fmtMs(one * n) : '')) +
      '（' + (e.dur_src || 'API 口径') + '）';
  }
  // 同一条生产线的订单只能首尾相接，不同线并行跑，所以给两个数。
  // 勾了重复填满的条目单数不确定（下到队列满才停），不参与总时长
  function totalsText() {
    var sel = state.queue.filter(function (e) { return e.on; });
    if (!sel.length) return '';
    var perLine = {};
    var serial = 0;
    var known = 0;
    var fill = 0;
    sel.forEach(function (e) {
      if (e.repeat) { fill++; return; }
      var t = orderMs(e);
      if (!t) return;
      known++;
      serial += t;
      var k = entryTag(e);
      perLine[k] = (perLine[k] || 0) + t;
    });
    var bits = [];
    if (known) {
      var wall = Math.max.apply(null, Object.keys(perLine).map(function (k) { return perLine[k]; }));
      bits.push('选中 ' + sel.length + ' 条：串行相加 ' + fmtMs(serial) +
        '，按线并行 ' + fmtMs(wall) + '（取最长的一条线）');
      var unknown = sel.length - known - fill;
      if (unknown > 0) bits.push(unknown + ' 条无时长未计入');
    }
    if (fill) bits.push(fill + ' 条勾了重复填满，下到该线队列满为止，不计总时长');
    return bits.join('；');
  }

  async function loadRecipes(force) {
    var cache = state.recipesAt && Date.now() - state.recipesAt < 6 * 3600000;
    if (!force && state.recipes.length && cache) {
      log('配方缓存命中：' + state.recipes.length + ' 条（' + new Date(state.recipesAt).toLocaleString() + '）');
      return;
    }
    log('拉取配方 ' + RECIPES_URL);
    var body = await httpGetText(RECIPES_URL);
    var list = JSON.parse(body);
    if (!Array.isArray(list)) throw new Error('返回不是数组');
    list.forEach(function (r) { r._sig = recipeSig(r); });
    state.recipes = list;
    state.recipesAt = Date.now();
    lsSet(K_RECIPES, list);
    lsSet('prun.recipes.at', state.recipesAt);
    log('配方已更新：' + list.length + ' 条');
  }

  function tickers() {
    var set = {};
    state.recipes.forEach(function (r) { set[r.building_ticker] = 1; });
    return Object.keys(set).sort();
  }

  // 模板/配方的产物 ticker 集合，搜索只按英文缩写筛，不看中文名
  function sigOutputs(sig) {
    var right = String(sig || '').split('=>')[1] || '';
    return right.split('+').filter(Boolean).map(function (p) {
      return p.replace(/x[\d.]+$/, '').toUpperCase();
    });
  }
  function recipeOutTickers(r) {
    return (r.outputs || []).map(function (o) { return o.material_ticker.toUpperCase(); });
  }

  function matchesOutput(r, q) {
    if (!q) return true;
    var u = q.toUpperCase();
    return recipeOutTickers(r).some(function (t) { return t.indexOf(u) >= 0; });
  }

  function filteredRecipes() {
    var oq = state.filterOut.toUpperCase();
    var bt = state.filterTicker;
    var out = [];
    for (var i = 0; i < state.recipes.length && out.length < 250; i++) {
      var r = state.recipes[i];
      if (bt && r.building_ticker !== bt) continue;
      if (!matchesOutput(r, oq)) continue;
      out.push(r);
    }
    return out;
  }

  function filteredScanned() {
    var oq = state.tplOut.toUpperCase();
    return state.scanned.filter(function (t) {
      if (state.tplLine && t.line !== state.tplLine) return false;
      if (!oq) return true;
      return sigOutputs(t.sig).some(function (x) { return x.indexOf(oq) >= 0; });
    });
  }

  // ---------------------------------------------------------------- queue

  function saveQueue() {
    lsSet(K_QUEUE, state.queue);
  }

  // 文件名 = 星球_建筑_日期时间；跨星球或跨建筑就明说，免得看着像单星球的档
  function exportName() {
    var planets = uniq(state.queue.map(locFor));
    var blds = uniq(state.queue.map(function (e) { return e.building; }));
    var ids = uniq(state.queue.map(codeFor));
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    var safe = function (s) { return String(s).replace(/[<>:"/\\|?*]+/g, '_'); };
    return safe(planets.length === 1 ? planets[0] : planets.length ? '多星球' + planets.length : '未知星球') +
      '_' + safe(blds.length === 1 ? blds[0] : blds.length ? '多建筑' + blds.length : '未知建筑') +
      '_' + safe(ids.length === 1 ? 'PROD' + ids[0] : ids.length ? '队列' + ids.length : '未定位') +
      '_' + stamp + '.json';
  }

  function pushEntry(entry) {
    entry.id = Math.random().toString(36).slice(2, 9);
    entry.size = 1;
    entry.repeat = false;
    entry.autoFit = true;
    entry.on = true;
    state.queue.push(entry);
    saveQueue();
    log('入队 [' + entry.building + '] ' + entry.label + ' -> ' + entryTag(entry));
    renderQueue();
  }

  // 导出/导入的线定位字段：queueId 就是游戏里那条队列的名字（`PROD bda98a38`），
  // 光有中文线名不唯一——同名基地不止一个，执行时先认这个 id
  function exportEntry(e) {
    var out = JSON.parse(JSON.stringify(e));
    var code = codeFor(e);
    out.queueId = code ? 'PROD ' + code : '';
    out.code = code;
    out.loc = locFor(e);
    return out;
  }

  // 导入的文件是外部输入，缺字段就把渲染队列时会读的那几个补上，其余原样保留
  function normalizeEntry(e) {
    if (!e || typeof e !== 'object' || !e.sig) return null;
    e.id = e.id || Math.random().toString(36).slice(2, 9);
    e.label = e.label || e.sig;
    e.building = e.building || '?';
    e.line = e.line || '自动';
    var qid = /\b([0-9a-f]{5,})\b/i.exec(String(e.queueId || ''));
    e.code = e.code || (qid ? qid[1].toLowerCase() : '');
    e.time_ms = Number(e.time_ms) || 0;
    e.size = Math.max(1, Math.min(20, Number(e.size) || 1));
    e.repeatMax = Math.max(1, Math.min(50, Number(e.repeatMax) || 20));
    e.repeat = !!e.repeat;
    e.on = e.on !== false;
    e.autoFit = e.autoFit !== false;
    return e;
  }

  function addToQueue(r) {
    pushEntry({
      recipe_id: r.recipe_id,
      label: recipeLabel(r),
      sig: r._sig || recipeSig(r),
      building: r.building_ticker,
      time_ms: r.time_ms,
      dur_src: 'API 口径',
      line: '自动'
    });
  }

  // 抽取类生产线（钻井等）的产物由星球资源决定，prunplanner 配方表里是空的，
  // 只能从 APEX 自己的模板列表入队
  function addTemplateToQueue(t) {
    pushEntry({
      recipe_id: t.api ? t.api.recipe_id : 'line:' + (t.code || t.line) + ':' + t.sig,
      label: t.label,
      sig: t.sig,
      building: t.api ? t.api.building_ticker : '本地/' + t.line,
      time_ms: t.time_ms,
      dur_src: 'APEX 实测',
      line: t.line,
      code: t.code || ''
    });
  }

  function parseDurationMs(s) {
    var ms = 0;
    var d = /(\d+)\s*天/.exec(s);
    var h = /(\d+)\s*小时/.exec(s);
    var m = /(\d+)\s*分/.exec(s);
    if (d) ms += Number(d[1]) * 86400000;
    if (h) ms += Number(h[1]) * 3600000;
    if (m) ms += Number(m[1]) * 60000;
    return ms;
  }

  // 下单表单的「位置」行是唯一明确标出这条线在哪个星球的地方，形如
  // AJ-768 - Lemuria (AJ-768a)；括号里是带降落序号的站点代码，PROD 瓦片表头没有它
  function readLocation(form) {
    var m = /位置(.+?)生产线/.exec(text(form));
    if (!m) return '';
    var full = m[1].trim();
    var par = /\(([A-Za-z0-9-]+)\)\s*$/.exec(full);
    if (par) return par[1];
    return (/([A-Z]{2,4}-\d{2,4}[a-z]?)/.exec(full) || [''])[0];
  }

  // 基地自带一个内部编码：点开基地 FK-794B 的生产力，窗口标题是 `WF bda98a38`，
  // 生产队列那条线就是 `PROD bda98a38`。同一星球上可以有几个同名基地，
  // 显示名会撞车，这个码才是「这条线」的唯一标识
  // 只认紧跟在码前面的 `PROD` / `WF` 标签，把它和码一起剥掉：
  // 留下裸「PROD」的话，两条同名线的显示名会变成「水培农场 PROD#bda98a38」这种累赘写法
  var LINE_CODE_RE = /\b(?:([0-9a-f]{5,})|(?:PROD|WF)\s+([0-9a-f]{5,}))\b/i;

  // 从瓦片表头原文里拆出 显示名 和 内部码。内部码是一串纯十六进制，
  // 所以整串必须全 hex；`BS-BS-531a` 这类站点码带连字符，不会被误认
  function splitLineCode(raw) {
    var s = String(raw || '').trim();
    var m = LINE_CODE_RE.exec(s);
    if (!m) return { name: s, code: '' };
    var code = String(m[1] || m[2] || '').toLowerCase();
    if (!/^[0-9a-f]{5,}$/.test(code)) return { name: s, code: '' };
    return {
      name: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length))
        .replace(/\b(?:PROD|WF)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim(),
      code: code
    };
  }

  // 线上显示的定位串：有内部码就以码为主、名字为辅
  function lineTag(line) {
    return line.code ? line.code + '(' + line.name + ')' : line.name;
  }

  // 线名匹配：先要一模一样；对不上再忽略插件自己加的 `#2` / `#bda98a38` 这类后缀，
  // 因为老队列条目里存的可能是加后缀之前（或编号规则变了之前）的写法
  function matchNamed(list, name) {
    var exact = list.filter(function (l) { return l.name === name; });
    if (exact.length) return exact;
    var key = String(name).replace(/#[0-9a-z]{1,}$/i, '');
    return list.filter(function (l) { return String(l.name).replace(/#[0-9a-z]{1,}$/i, '') === key; });
  }

  function uniq(list) {
    var out = [];
    list.forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }

  // 报错时用的一句话：页面上现在开着哪些生产列表，各自有哪些线、在哪个星球
  function openTilesDesc() {
    var tiles = prodTiles().filter(tileVisible);
    if (!tiles.length) return '一个都没打开';
    var bits = tiles.slice(0, 6).map(function (t) {
      var c = tileCode(t);
      var hit = infoFor(c);
      return (c ? 'PROD ' + c : '无码') + (hit && hit.loc ? '@' + hit.loc : '') +
        '（' + listLines(t).map(function (l) { return l.name; }).join('/') + '）';
    });
    return bits.join(' / ') + (tiles.length > 6 ? ' …共 ' + tiles.length + ' 个瓦片' : '');
  }

  async function scanLineTemplates() {
    var lines = allLines();
    var tiles = prodTiles().filter(tileVisible);
    if (!lines.length) throw new Error('页面上没有打开的生产列表（PROD）瓦片，请先打开它');
    var found = [];
    // 一开始就把当前这批队列 id 登进表：状态栏和文件名按表里的现查，
    // 不然切星球后重扫，顶上那行还挂着上一个星球
    harvestLines(lines);
    log('扫描 ' + tiles.length + ' 个瓦片上的 ' + lines.length + ' 条生产线的模板：' +
      lines.map(function (l) { return lineTag(l); }).join(' / '));
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var w = null;
      var loc = '';
      try {
        var opened = await openOrderWindow(line);
        w = opened.w;
        loc = harvestLine(line, readLocation(opened.form));
        var opts = await readTemplateOptions(opened.form);
        opts.forEach(function (o) {
          var api = null;
          for (var k = 0; k < state.recipes.length; k++) {
            if ((state.recipes[k]._sig || recipeSig(state.recipes[k])) === o.sig) { api = state.recipes[k]; break; }
          }
          if (api) state.lineMap[api.building_ticker] = line.name;
          found.push({
            line: line.name, code: line.code, sig: o.sig, label: o.label, duration: o.duration,
            time_ms: parseDurationMs(o.duration), loc: loc, api: api
          });
        });
        log('  ' + lineTag(line) + (loc ? ' @' + loc : '') +
          '：' + opts.length + ' 个模板，其中 ' +
          found.filter(function (f) { return f.line === line.name && f.code === line.code && f.api; }).length +
          ' 个能对上 API 配方');
        await closeWindow(w);
        w = null;
      } catch (e) {
        harvestLine(line, loc);
        log('  ' + lineTag(line) + ' 扫描失败：' + e.message);
      } finally {
        if (w) { try { await closeWindow(w); } catch (e2) { /* 已关闭 */ } }
      }
      // closeWindow 已经等到窗口不可见，这里只留一帧让 PROD 瓦片自己刷完
      await nextFrame();
    }
    lsSet('prun.linemap', state.lineMap);
    // 扫描就是整片替换：列表只反映这次真正扫到的线，和 v0.2.0 一样。
    // 现在「这次」= 页面上所有打开的瓦片，所以多星球同屏扫一遍就把它们全收进来了；
    // 只想扫某一颗星球的话，把别的 PROD 窗口关掉再点
    state.scanned = found;
    lsSet(K_SCANNED, state.scanned);
    log('已关联建筑→生产线：' + Object.keys(state.lineMap).map(function (k) { return k + '=' + state.lineMap[k]; }).join(' '));
    return found;
  }

  // ------------------------------------------------------ APEX DOM reading

  function prodFrames() {
    return byClass(document, 'TileFrame__frame').filter(function (f) {
      return /生产线/.test(text(one(f, 'TileFrame__title')));
    });
  }

  // 可以把多颗星球的生产列表同时摊在一个页面上，所以没有「当前瓦片」这种东西了：
  // 取所有**可见**的生产列表瓦片，执行时按队列 id 在这些瓦片里找。
  // APEX 的瓦片是缓存的：切星球后旧瓦片只是被隐藏、节点还留在文档里，
  // 所以必须按可见性过滤，不然会把上一颗星球的线当成现在能下的
  function prodTiles() {
    var frames = prodFrames();
    var visible = frames.filter(function (f) { return f.offsetWidth || f.offsetHeight; });
    // 一个都不可见时退回第一个隐藏瓦片，只给状态栏和日志当证据用：
    // 这时候执行会明确报「没有打开的生产列表」，不会拿隐藏的线真下单
    return visible.length ? visible : frames.slice(0, 1);
  }

  function tileVisible(tile) {
    return !!(tile.offsetWidth || tile.offsetHeight);
  }

  // 瓦片 cmd 行上的队列 id（`PROD bda98a38` 的 bda98a38），一个基地的整条队列共用它
  function tileCode(tile) {
    return splitLineCode(text(one(tile, 'TileFrame__cmd'))).code;
  }

  function parseMaterialIcons(tpl) {
    var ins = [], outs = [];
    byClass(tpl, 'MaterialIcon__container').forEach(function (m) {
      if (one(m, 'ColoredIcon__container') === null) return;
      var t = text(one(m, 'ColoredIcon__label'));
      var raw = text(one(m, 'MaterialIcon__indicator'));
      var num = parseFloat(raw);
      if (!t) return;
      (m.closest('[class*="ProductionLine__inputs"]') ? ins : outs).push({ t: t, a: isNaN(num) ? raw : num });
    });
    return { ins: ins, outs: outs };
  }

  function domSig(parts) {
    var f = function (list) {
      return list.map(function (x) { return x.t + 'x' + x.a; }).sort().join('+') || '-';
    };
    return f(parts.ins) + '=>' + f(parts.outs);
  }

  // 空槽位也渲染成一个 OrderSlot__container，里面只有 `OrderTile__queue` 占位 div，
  // 既没有游戏自己写的 data-prun-id，也没有材料缩写。实盘数过：二型预制件厂 22 个容器
  // 只有 13 个真订单、三型 18/18（队列真满）、焊接棚 15/14。不过滤的话
  // 「进行/队列」会把空位算成排队订单，槽位总数还恒定不变——下单后的变化检测就永远看不到新订单。
  function readOrders(col) {
    if (!col) return { orders: [], slots: 0 };
    var all = byClass(col, 'OrderSlot__container');
    var orders = [];
    all.forEach(function (s) {
      var id = s.getAttribute('data-prun-id') || '';
      var info = one(s, 'OrderSlot__info');
      var cells = info ? Array.prototype.map.call(info.children, text) : [];
      var iconBox = one(s, 'ColoredIcon__container');
      var ticker = text(one(s, 'ColoredIcon__label'));
      if (!id && !ticker) return;
      orders.push({
        id: id,
        ticker: ticker,
        name: iconBox ? iconBox.getAttribute('title') : '',
        qty: cells[0] || '',
        eta: cells[1] || '',
        status: text(one(s, 'OrderStatus__inProgress')) || cells[2] || '',
        queued: !!one(s, 'OrderTile__queue')
      });
    });
    return { orders: orders, slots: all.length };
  }

  function listLines(tile) {
    var grid = one(tile, 'SiteProductionLines__grid');
    if (!grid) return [];
    // 实盘里 `PROD cb05ba60` 写在瓦片的 cmd 行上，一个基地的整条队列共用这一个码，
    // 每条线的表头只有线名（农场 / 钻井）。所以线的身份是「瓦片码 + 线名」，
    // 表头自己带码的写法仍然优先用表头的（老夹具和某些版本是那样排的）
    var baseCode = tileCode(tile);
    var headers = Array.prototype.filter.call(grid.children, function (c) {
      return c.className.indexOf('header') >= 0;
    });
    var cols = Array.prototype.filter.call(grid.children, function (c) {
      return c.className.indexOf('column__') >= 0;
    });
    var out = headers.map(function (h, i) {
      var rd = readOrders(cols[i]);
      var orders = rd.orders;
      var raw = text(one(h, 'headerName'));
      var p = splitLineCode(raw);
      return {
        raw: raw,
        // 表头整串只有 `PROD <码>` 时剥完是空的，留给下面的 BASE# 兜底，
        // 这里不能用原文兜底，否则显示名又变回「PROD c0ffee01」这种没有信息量的写法
        name: p.name,
        code: p.code || baseCode,
        tile: tile,
        header: h,
        orders: orders,
        active: orders.filter(function (o) { return !o.queued; }).length,
        queued: orders.filter(function (o) { return o.queued; }).length,
        // 容器总数减真订单数 = 还空着的槽位数。这是量出来的，不是游戏声明的容量
        free: Math.max(0, rd.slots - orders.length)
      };
    });
    out.forEach(function (l) {
      // 表头整串就是 `PROD bda98a38` 时，剥掉码只剩「PROD」这种没有信息量的词，
      // 拿基地编码顶上，免得显示名全一样、下拉框里分不清是哪条
      if (!l.name || /^prod$/i.test(l.name)) l.name = l.code ? 'BASE#' + l.code : l.raw;
    });
    // 同一个基地里出现重名线时，光看名字分不开；队列 id 是整个基地共用的，追加它并不能
    // 让两项变唯一，所以按出现次序编号：农场、农场#2、农场#3
    var seen = {};
    out.forEach(function (l) {
      seen[l.name] = (seen[l.name] || 0) + 1;
      if (seen[l.name] > 1) l.name = l.name + '#' + seen[l.name];
    });
    return out;
  }

  // 所有已打开（可见）生产列表瓦片上的全部生产线，每条线带着自己的 瓦片/表头 节点。
  // 跨星球执行靠的就是这一张表：条目里的队列 id 落在哪个瓦片，就去哪个瓦片点新建订单
  function allLines() {
    var out = [];
    prodTiles().forEach(function (t) {
      if (!tileVisible(t)) return;
      listLines(t).forEach(function (l) { out.push(l); });
    });
    return out;
  }

  // ---------------------------------------------------- order automation

  // 该线订单槽位的占用签名；下单成功后它必然变化，用它替代下单后的固定等待。
  // 队列 id 是整个基地共用的，所以必须 码 + 线名 一起比，只比码会拿基地里另一条线的槽位当自己
  function lineLoad(line) {
    var hit = allLines().filter(function (l) {
      return (line.code ? l.code === line.code : l.name === line.name) && l.name === line.name;
    })[0];
    // 签名是订单 id 的集合，不是数量：空槽位不计入订单后容器总数恒定，
    // 只比数量的话新订单填进空位时签名不变，下单后这一步就永远等不到证据
    return hit ? hit.orders.map(function (o) { return o.id || (o.ticker + '|' + o.qty); })
      .sort().join(',') : null;
  }

  function activeWindows() {
    return byClass(document, 'Window__window').filter(function (w) {
      return w.offsetWidth || w.offsetHeight;
    });
  }

  async function openOrderWindow(line) {
    var btn = Array.prototype.filter.call(line.header.querySelectorAll('button'), function (b) {
      return text(b) === '新建订单';
    })[0];
    if (!btn) throw new Error('生产线「' + line.name + '」没有新建订单按钮');
    var before = activeWindows().length;
    btn.click();
    var win = await waitFor(function () {
      var ws = activeWindows();
      if (ws.length <= before) return null;
      var f = one(ws[ws.length - 1], 'ProductionLine__form');
      return f ? { w: ws[ws.length - 1], form: f } : null;
    }, 6000, '下单表单');
    return win;
  }

  async function closeWindow(w) {
    var x = Array.prototype.filter.call(w.querySelectorAll('[class*="Window__button"]'), function (b) {
      return text(b) === 'x';
    })[0];
    if (x) x.click();
    // 窗口是缓存的，关闭只是隐藏不是移除，所以按可见性判定；等不到也只多等半秒就继续
    await waitFor(function () {
      return !document.body.contains(w) || !(w.offsetWidth || w.offsetHeight);
    }, 500, '窗口关闭').catch(function () { /* 交给下一次打开时的可见性判定 */ });
  }

  function formBox(form, label) {
    return byClass(form, 'FormComponent__containerActive').filter(function (c) {
      return text(c.querySelector('label')).indexOf(label) === 0;
    })[0] || null;
  }

  // 模板节点 -> 签名/时长/标签：下拉里的候选和表单上已选中的那一项都读成同一种形状
  function templateInfo(node) {
    var parts = parseMaterialIcons(node);
    return {
      node: node,
      sig: domSig(parts),
      duration: text(one(node, 'ProductionLine__duration')),
      label: parts.ins.map(function (x) { return x.t + x.a; }).join(' ') + ' => ' +
             parts.outs.map(function (x) { return x.t + x.a; }).join(' ')
    };
  }

  // 下拉列表是挂在 body 上的 portal，全文档查询会把别的（已隐藏）窗口留下的旧 portal
  // 一起捞进来，所以只认看得见的那些：不可见的节点一律不算候选
  function listedTemplates() {
    return byClass(document, 'ProductionLine__template').filter(function (t) {
      if (t.closest('[class*="DropDownBox__currentItem"]')) return false;
      if (!(t.offsetWidth || t.offsetHeight)) return false;
      var win = t.closest('[class*="Window__window"]');
      return !win || !!(win.offsetWidth || win.offsetHeight);
    });
  }

  // 空数组在 JS 里是 truthy，所以等待条件必须显式把「一条都还没渲染」当成假
  function listedTemplatesReady() {
    var l = listedTemplates();
    return l.length ? l : null;
  }

  async function readTemplateOptions(form) {
    var box = formBox(form, '生产模板');
    if (!box) throw new Error('表单里没有生产模板字段');
    var toggle = one(box, 'DropDownBox__toggle');
    if (!toggle) throw new Error('生产模板下拉无法展开');
    toggle.click();
    // 列表是异步渲染的，出现第一条就停；最多等 800ms，比原来固定睡的 400ms 慢不了多少
    await waitFor(listedTemplatesReady, 800, '生产模板下拉').catch(function () { /* 空列表照旧走产品过滤器 */ });
    return listedTemplates().map(templateInfo);
  }

  async function selectTemplate(form, sig) {
    // 轮转下单会反复打开同一个缓存对话框，模板已经选对时整段下拉流程都能跳过
    var cur = one(form, 'ProductionLine__template');
    if (cur && domSig(parseMaterialIcons(cur)) === sig) return templateInfo(cur);
    var chosen = function () {
      var c = one(form, 'ProductionLine__template');
      return c && domSig(parseMaterialIcons(c)) === sig ? c : null;
    };
    var opts = await readTemplateOptions(form);
    if (!opts.length) {
      var fb = formBox(form, '产品过滤器');
      if (fb) {
        var tg = one(fb, 'DropDownBox__toggle');
        if (tg) {
          tg.click();
          await waitFor(listedTemplatesReady, 500, '产品过滤模板').catch(function () { /* 继续按空列表处理 */ });
        }
        opts = await readTemplateOptions(form);
      }
    }
    var hit = opts.filter(function (o) { return o.sig === sig; })[0];
    if (!hit) {
      throw new Error('该生产线没有匹配模板 ' + sig + '；可选：' + (opts.map(function (o) { return o.sig; }).join(' / ') || '无'));
    }
    var clickable = hit.node.closest('[class*="DropDownBox__itemContainer"]') || hit.node;
    clickable.click();
    if (!(await waitFor(chosen, 600, '模板选中').catch(function () { return null; }))) {
      hit.node.click();
      if (!(await waitFor(chosen, 600, '模板选中（重试）').catch(function () { return null; }))) {
        // 表单上还挂着别的模板就继续下单，会把错的配方灌进生产队列，宁可不干
        var got = one(form, 'ProductionLine__template');
        throw new Error('模板 ' + sig + ' 点了没生效，当前停在 ' + (got ? domSig(parseMaterialIcons(got)) : '空') + '，拒绝下单');
      }
    }
    return hit;
  }

  // 表单自己渲染的 耗时 才是游戏真正会用到的值：它 = 模板单件时长 × 订单大小。
  // aria-valuenow 会骗人（滑块自己动了、游戏 state 没动），不能只信它。
  // 带「天」时显示会把分钟截掉，所以返回一个区间而不是精确值
  function readCostRange(form) {
    var m = /耗时(.+?)生产费用/.exec(text(form));
    if (!m) return null;
    var s = m[1].trim();
    var lo = parseDurationMs(s);
    if (!lo) return null;
    var slack = /分/.test(s) ? 60000 : (/小时/.test(s) ? 3600000 : 86400000);
    return { lo: lo, hi: lo + slack, txt: s };
  }

  // rc-slider 的拖拽结束监听是渲染之后才挂上的，同一帧连发 down/up 只会改到滑块自己的
  // 显示状态，游戏 state 不动，下单还是 1 单位。必须按 down → move → up 之间留帧来一遍
  async function dragSlider(box, handle, from, to) {
    var r = box.getBoundingClientRect();
    var min = Number(handle.getAttribute('aria-valuemin'));
    var max = Number(handle.getAttribute('aria-valuemax'));
    var y = r.top + r.height / 2;
    var at = function (v) { return r.left + r.width * ((v - min) / (max - min)); };
    var Pointer = window.PointerEvent;
    function fire(type, v, buttons) {
      var init = { bubbles: true, cancelable: true, clientX: at(v), clientY: y, button: 0, buttons: buttons };
      var Ctor = type.indexOf('pointer') === 0 && Pointer ? Pointer : window.MouseEvent;
      var ev;
      try { ev = new Ctor(type, init); } catch (e) { ev = new window.MouseEvent(type, init); }
      box.dispatchEvent(ev);
    }
    fire('pointerdown', from, 1);
    fire('mousedown', from, 1);
    await nextFrame();
    fire('pointermove', to, 1);
    fire('mousemove', to, 1);
    await nextFrame();
    fire('pointerup', to, 0);
    fire('mouseup', to, 0);
    await nextFrame();
  }

  // unitSlack：模板上那行单件耗时被显示截断的最大幅度（显示到小时就最多差 1 小时）
  async function setOrderSize(form, target, baseMs, unitSlack) {
    var handle = form.querySelector('.rc-slider-handle');
    var box = form.querySelector('.rc-slider');
    if (!handle || !box) throw new Error('找不到订单大小滑块');
    var min = Number(handle.getAttribute('aria-valuemin'));
    var max = Number(handle.getAttribute('aria-valuemax'));
    if (isNaN(min) || isNaN(max) || max <= min) { min = 1; max = 20; }
    if (!box.getBoundingClientRect().width) throw new Error('订单大小滑块还没渲染出来');
    var want = Math.max(min, Math.min(max, target));
    // 单件耗时是截断过的，误差会乘以订单大小：区间必须按 want 展开，
    // 否则大订单必然落在区间外，把已经设对的滑块误判成没生效
    var lo = baseMs ? baseMs * want : NaN;
    var hi = baseMs ? (baseMs + (unitSlack || 0)) * want : NaN;
    var last = '';
    function applied() {
      var now = Number(handle.getAttribute('aria-valuenow'));
      var rng = readCostRange(form);
      var ok = !rng || isNaN(lo) ? true : rng.lo <= hi && rng.hi >= lo;
      last = '滑块 ' + now + '，表单耗时 ' + (rng ? rng.txt : '读不到') +
        '，应为 ' + (isNaN(lo) ? '?' : fmtMs(lo) + '~' + fmtMs(hi));
      return now === want && ok;
    }
    for (var attempt = 0; attempt < 3; attempt++) {
      var cur = Number(handle.getAttribute('aria-valuenow'));
      // 滑块读数已经等于目标值但耗时对不上时，原地拖没有位移、React 不会重放 onChange，
      // 所以得先拖到别处再拖回来，逼它产生一次真实变化。偏移量取整条行程：
      // 只错开一格时指针位移太小，实测会被 rc-slider 吃掉（日志里出现过拖完仍停在原值）
      var start = want;
      if (attempt === 0 && cur !== want) start = cur;
      else start = want <= min ? max : min;
      start = Math.max(min, Math.min(max, start));
      await dragSlider(box, handle, start, want);
      if (await waitFor(applied, 600, '订单大小生效').catch(function () { return false; })) {
        if (!readCostRange(form) || isNaN(lo)) log('  订单大小 ' + want + '（时长读不到，只核对了滑块读数）');
        return want;
      }
      log('  订单大小未生效，重试 ' + (attempt + 1) + '：' + last);
    }
    throw new Error('订单大小没设进去（' + last + '），拒绝下单');
  }

  async function setRepeat(form, on) {
    var box = formBox(form, '重复');
    if (!box) return;
    var radio = one(box, 'RadioItem__container');
    if (!radio) return;
    var disabled = /RadioItem__disabled|RadioItem__valueDisabled/.test(radio.className + (one(box, 'RadioItem__value') || {}).className);
    if (disabled) {
      if (on) log('  提示：该生产线不支持重复订单，已忽略 repeat');
      return;
    }
    var selected = /selected|checked|active/.test(radio.className);
    if (on !== selected) {
      radio.click();
      await waitFor(function () {
        return /selected|checked|active/.test(radio.className) === on;
      }, 500, '重复订单切换').catch(function () { /* 状态没读到就照原样往下走 */ });
      var after = /selected|checked|active/.test(radio.className);
      log('  重复订单：' + (on ? '请求开启' : '请求关闭') + '，实际 ' + (after ? '已开启' : '已关闭'));
    }
  }

  function parseNum(s) {
    var m = /([\d][\d,.]*)/.exec(String(s || ''));
    if (!m) return NaN;
    return Number(m[1].replace(/[,.](?=\d{3})/g, '').replace(',', '.'));
  }

  // 下单闸门：表单里没有报错文字，只能自己读材料行。读不到原因时一律标成「未知」
  // 并把原始证据打出来，不要再猜「队列已满」——抽取线根本没有输入行，那条猜测必然错
  function readMaterials(form, which) {
    // 只认这个对话框自己的材料表：全文档兜底查询会捞到别的（已隐藏）窗口留下的旧表单
    var scope = form.closest('[class*="Window__window"]') || form.parentElement || form;
    var view = one(scope, 'InputsOutputsView__container');
    if (!view) {
      // 兜底也只认看得见的那个：窗口是缓存的，隐藏的旧窗口里还挂着自己的材料表
      var vis = byClass(document, 'InputsOutputsView__container').filter(function (v) {
        var w = v.closest('[class*="Window__window"]');
        return (v.offsetWidth || v.offsetHeight) || (w && (w.offsetWidth || w.offsetHeight));
      });
      view = vis[vis.length - 1] || null;
    }
    if (!view) return [];
    var side = one(view, 'InputsOutputsView__' + which);
    if (!side) return [];
    return byClass(side, 'InputsOutputsView__materialContainer').map(function (m) {
      var t = text(one(m, 'ColoredIcon__label'));
      var raw = text(one(m, 'InputsOutputsView__amount'));
      var perCycle = parseNum(raw);
      var avEl = one(m, 'InputsOutputsView__amountAvailable');
      var avail = avEl ? parseNum(text(avEl)) : parseNum((/仓储中有([\d,.]+)/.exec(raw) || [])[1]);
      return { ticker: t, perCycle: perCycle, avail: avail };
    }).filter(function (x) { return x.ticker; });
  }

  function readAvailability(form) {
    return readMaterials(form, 'inputs');
  }

  function maxAffordableSize(rows, fallback) {
    var limit = fallback;
    rows.forEach(function (r) {
      if (!r.perCycle || r.perCycle <= 0) return;
      var can = Math.floor(r.avail / r.perCycle);
      if (can < limit) limit = can;
    });
    return Math.max(0, limit);
  }

  function fmtRow(r, size) {
    return r.ticker + ' 单件需 ' + r.perCycle + '，x' + size + ' 要 ' + (r.perCycle * size) + '，仓储 ' + r.avail;
  }

  function describeBlock(form, size) {
    var rows = readAvailability(form);
    var short = rows.filter(function (r) { return r.perCycle > 0 && r.avail < r.perCycle * size; });
    if (short.length) {
      return {
        reason: '库存不足',
        detail: short.map(function (r) { return fmtRow(r, size); }).join('；'),
        affordable: maxAffordableSize(rows, size)
      };
    }
    var bits = [];
    bits.push(rows.length ? '输入无缺口（' + rows.map(function (r) { return fmtRow(r, size); }).join('；') + '）' : '表单里没读到输入行');
    var outs = readMaterials(form, 'outputs');
    if (outs.length) bits.push('成品 ' + outs.map(function (r) { return r.ticker + ' 单件产 ' + r.perCycle + '，仓储 ' + r.avail; }).join('；'));
    var btn = submitButton(form);
    bits.push('按钮 ' + (btn ? (btn.disabled ? 'disabled属性' : '无disabled属性') + ' class=' +
      String(btn.className).split(/\s+/).filter(function (c) { return /disab|utton/i.test(c); }).join(' ') : '没找到'));
    return { reason: '禁用原因未知', detail: bits.join(' · '), affordable: null };
  }

  function submitButton(form) {
    var b = Array.prototype.filter.call(form.querySelectorAll('button'), function (x) {
      return /队列添加订单|添加订单/.test(text(x));
    })[0];
    return b || null;
  }

  async function attemptOnce(line, entry, opts, sizeWanted) {
    var opened = await openOrderWindow(line);
    var w = opened.w;
    var form = opened.form;
    try {
      var tpl = await selectTemplate(form, entry.sig);
      var baseMs = parseDurationMs(tpl.duration);
      // 单件耗时显示到哪一档，截断误差就有多大（显示到小时则最多差 1 小时）
      var unitSlack = /分/.test(tpl.duration) ? 60000 :
        (/小时/.test(tpl.duration) ? 3600000 : 86400000);
      var size = sizeWanted;
      // 先定模式再定大小：切「重复/单次」可能把滑块弹回原位，顺序反了校验就白做了。
      // 这里恒传 false：APEX 自带的「重复订单」会让游戏无限重复该订单，
      // 队列填满由本脚本的轮转负责，两者语义不同，不能同时开
      await setRepeat(form, false);
      await setOrderSize(form, size, baseMs, unitSlack);
      var btn = submitButton(form);
      if (!btn) throw new Error('找不到下单按钮');
      var ready = btn.className.indexOf('Button__disabled') < 0;
      // 报受阻原因时带上量出来的槽位数：实盘里三型预制件厂 18 个容器全是真订单，
      // 「无空位」就是它有证据的队列已满，不再只留一句「禁用原因未知」
      var describe = function () {
        var b = describeBlock(form, size);
        var total = line.orders.length + (line.free || 0);
        b.full = !!(total && !line.free);
        b.detail += ' · 槽位 ' + line.orders.length + '/' + total + (b.full ? '（实测无空位）' : '');
        return b;
      };
      var block = ready ? null : describe();
      if (!ready && entry.autoFit && block && block.reason === '库存不足' &&
          block.affordable >= 1 && block.affordable < size) {
        size = Math.min(block.affordable, 20);
        await setOrderSize(form, size, baseMs, unitSlack);
        ready = btn.className.indexOf('Button__disabled') < 0;
        block = ready ? null : describe();
        log('  自动降档 x' + sizeWanted + ' → x' + size);
      }
      var rng = readCostRange(form);
      var cost = rng ? rng.txt : '未知';
      if (opts.dryRun) return { placed: false, ready: ready, size: size, tpl: tpl, cost: cost, block: block };
      if (!ready) return { placed: false, ready: false, size: size, tpl: tpl, cost: cost, block: block };
      btn.click();
      // 等到「看得见的证据」：该线槽位变化，或对话框自己收起来。上限就是原来固定睡的 700ms
      var load0 = lineLoad(line);
      await waitFor(function () {
        return lineLoad(line) !== load0 ||
          !document.body.contains(w) || !(w.offsetWidth || w.offsetHeight);
      }, 700, '订单入队').catch(function () { /* 证据没等到也只等满原来的 700ms */ });
      return { placed: true, ready: true, size: size, tpl: tpl, cost: cost, block: null };
    } finally {
      try { await closeWindow(w); } catch (e2) { /* 窗口已自行关闭 */ }
    }
  }

  // 一次只下一单。填不进（队列满 / 缺料）返回 placed:false，那不是错误，是轮转停止信号
  async function placeOnce(entry, opts) {
    var tiles = prodTiles().filter(tileVisible);
    if (!tiles.length) throw new Error('页面上没有打开的生产列表（PROD）瓦片，先把要下的那条线所在的窗口打开');
    var lines = allLines();
    if (!lines.length) throw new Error('生产列表里没有生产线');

    // 先认队列 id（`PROD bda98a38` 的那个 bda98a38）。实盘里它是**整个基地队列**的标识，
    // 同一瓦片上的几条线共用一个码，所以定位是「码锁定基地 + 线名锁定这条线」。
    // 码在哪就下哪：多颗星球的生产列表摊在同一页时，不需要先切到那条线的星球
    var byCode = entry.code || '';
    var byName = entry.line && entry.line !== '自动' ? entry.line : (state.lineMap[entry.building] || '');
    var targets, wanted;
    if (byCode) {
      wanted = (byName ? byName + ' ' : '') + 'PROD ' + byCode;
      var here = lines.filter(function (l) { return l.code === byCode; });
      targets = byName ? matchNamed(here, byName) : here;
      if (byName && here.length && !targets.length) {
        throw new Error('队列 PROD ' + byCode + ' 已经打开了，但这个基地里没有线「' + byName +
          '」，它有：' + here.map(lineTag).join(' / ') + '（重扫一次模板，线名跟着游戏里的改名走）');
      }
    } else {
      // 「自动」不是真线名，配方页入队时线还没定；按 建筑→线 的关联去找，
      // 找不到就把线挨个试（原有行为）。但试的范围只限第一个可见瓦片：
      // 没有队列 id 就跨瓦片试线，等于把订单可能下进另一个基地，那是误操作
      var local = listLines(tiles[0]);
      wanted = byName;
      targets = wanted ? matchNamed(local, byName) : local;
    }
    if (!targets.length) {
      throw new Error('找不到生产队列「' + wanted + '」，当前打开的生产列表：' + openTilesDesc() +
        (byCode ? '（没有 PROD ' + byCode + '；把那个窗口打开，或重扫一次模板拿最新的码）' : ''));
    }

    var why = null;
    var full = false;
    for (var i = 0; i < targets.length; i++) {
      var line = targets[i];
      try {
        var r = await attemptOnce(line, entry, opts, entry.size);
        var block = r.block ? r.block.reason + '：' + r.block.detail : '表单未就绪';
        full = !!(r.block && r.block.full);
        if (opts.dryRun) {
          if (!r.ready) {
            why = lineTag(line) + ' ' + block;
            log('  干跑受阻：' + why);
            continue;
          }
          log('  干跑：' + lineTag(line) + ' ' + r.tpl.label + ' x' + r.size +
            '，表单耗时 ' + r.cost + '，已就绪未提交' +
            (entry.repeat ? '；真实执行会一直轮转填满，直到这条线实测无空位' : ''));
          return { placed: false, dry: true };
        }
        if (!r.placed) {
          why = lineTag(line) + ' ' + block;
          log('  跳过 ' + lineTag(line) + '：' + block);
          continue;
        }
        log('  已下单 ' + lineTag(line) + ' x' + r.size + '（表单耗时 ' + r.cost + '）：' + r.tpl.label);
        refreshStatus();
        return { placed: true, size: r.size, line: line.name, code: line.code };
      } catch (e) {
        if (entry.line && entry.line !== '自动') throw e;
        why = e.message;
        log('  ' + lineTag(line) + ' 跳过：' + e.message);
      }
    }
    return { placed: false, reason: why || ('没有生产线能匹配 ' + entry.sig), lineFull: full };
  }

  // 工厂之间依次做完一个再做下一个；同一工厂里的多条产物仍按轮转（一轮各下一单）。
  // 每个工厂开工前先读它线上已经排好的队列，从最后一单之后续排。
  async function runQueueInner(dryRun) {
    var entries = state.queue.filter(function (e) { return e.on; });
    if (!entries.length) { log('队列为空'); return; }
    var groups = groupQueue(entries);
    var fillN = entries.filter(function (e) { return e.repeat; }).length;
    var fixedN = entries.length - fillN;
    log('=== ' + (dryRun ? '干跑' : '真实下单') + '：' + groups.length + ' 个工厂 / ' +
      entries.length + ' 条，计划 ' + fixedN + ' 单' +
      (fillN ? ' + ' + fillN + ' 条填满（下到该线队列满）' : '') +
      '；工厂依次完成，组内按队列顺序轮转 ===');
    var acc = { placed: 0, ready: 0, rounds: 0, aborted: false };
    for (var gi = 0; gi < groups.length; gi++) {
      if (acc.aborted) break;
      await runFactory(groups[gi], gi + 1, groups.length, dryRun, acc);
    }
    log('=== 结束：' + acc.rounds + ' 轮，' + groups.length + ' 个工厂，' +
      (dryRun ? '可下 ' + acc.ready + ' / ' + entries.length + ' 条' : '成功 ' + acc.placed + ' 单') +
      (acc.aborted ? '，出错中止' : '') + ' ===');
    refreshStatus();
  }

  // 重复填满没有次数上限了，停止条件是「这条线实测无空位」。这个轮数纯粹是兜底，
  // 防的是页面上读不到槽位、free 永远不是 0 的情况——一条线队列容量也就 20 上下
  var MAX_ROUNDS = 60;

  async function runFactory(g, gi, gn, dryRun, acc) {
    var caps = g.entries.map(orderCount);        // 勾了重复填满 = Infinity
    var done = g.entries.map(function () { return 0; });
    var fills = caps.some(function (c) { return c === Infinity; });
    log('【工厂 ' + gi + '/' + gn + '】' + g.label + '：' +
      g.entries.map(function (e, i) { return (i + 1) + '.' + (outTicker(e) || e.label); }).join(' → '));
    var start = 0;
    if (state.resume) {
      var r = resumeIndex(g);
      log('  续排：' + r.why);
      start = r.idx >= 0 ? (r.idx + 1) % g.entries.length : 0;
      // 只有单次条目能按位置判定「这一条线上已经有了，本次不再下」。
      // 勾了重复填满的条目不适用：它要下到队列满，位置不能替它决定配额——
      // 上一版把命中位置之前的条目全按上限填满，于是线上最后一单恰好是组里最后一条时
      // 整组被当成已完成，多产物的厂子一单都不下
      for (var i = 0; i <= r.idx; i++) if (caps[i] !== Infinity) done[i] = caps[i];
      if (!caps.some(function (c, i) { return done[i] < c; })) {
        log('  这一组的单次条目都已排在线上，跳过');
        return;
      }
    } else {
      log('  续排：已关闭，从第一条开始');
    }
    var round = 0;
    for (;;) {
      var pending = caps.filter(function (c, i) { return done[i] < c; }).length;
      if (!pending) break;
      round++;
      if (round > MAX_ROUNDS) { log('  已到 ' + MAX_ROUNDS + ' 轮兜底上限，这一家收工'); break; }
      if (fills) {
        // 开新一轮前先量一次这条线的空槽位：满了就别再一张张开对话框了
        var free = groupFreeSlots(g);
        if (free === 0) { log('  这条线实测无空位，' + g.label + ' 收工'); break; }
      }
      acc.rounds++;
      var lineFull = false;
      for (var k = 0; k < g.entries.length; k++) {
        var j = (start + k) % g.entries.length;
        if (done[j] >= caps[j]) continue;
        var e = g.entries[j];
        log('[工厂' + gi + ' 第' + round + '轮 ' + (j + 1) + '/' + g.entries.length + '] ' +
          e.building + ' ' + e.label + ' x' + e.size + ' -> ' + entryTag(e) +
          '（第 ' + (done[j] + 1) + (caps[j] === Infinity ? ' 单，该线还有空位' : '/' + caps[j]) + '）');
        var res = null;
        try {
          res = await placeOnce(e, { dryRun: dryRun });
        } catch (err) {
          log('  失败：' + err.message);
          if (!dryRun) {
            log('真实下单出错即中止，避免继续误操作');
            acc.aborted = true;
            break;
          }
        }
        if (dryRun) {
          if (res && res.dry) acc.ready++;
          done[j] = caps[j];
          continue;
        }
        if (res.placed) { done[j]++; acc.placed++; continue; }
        done[j] = caps[j];
        log('  「' + e.label + '」停止续填：' + (res.reason || '未成功'));
        if (res.lineFull) {
          // 队列满是这条线的属性，不是这个产物的：一家厂里剩下的条目同样下不进去
          log('  这条线队列已满，' + g.label + ' 收工');
          lineFull = true;
          break;
        }
      }
      if (lineFull || acc.aborted || dryRun) break;
      await nextFrame();
    }
  }
  async function runQueue(dryRun) {
    if (running) { log('已在执行中，忽略本次触发'); return; }
    running = true;
    syncRunBtn();
    try {
      await runQueueInner(dryRun);
    } finally {
      running = false;
      syncRunBtn();
    }
  }

  // ---------------------------------------------------------------- UI

  var panel = null;
  var refs = {};
  var realRun = false;
  var running = false;

  // 队列页底部的执行按钮：模式来自执行页的干跑开关（默认不干跑），这里只复述当前档位
  function syncRunBtn() {
    if (!refs.run) return;
    refs.run.textContent = running
      ? '执行中…'
      : '执行队列（' + (state.dryRun ? '干跑' : '真实下单') + '）';
    refs.run.classList.toggle('warn', !state.dryRun);
    refs.run.classList.toggle('act', state.dryRun);
    refs.run.disabled = running;
  }

  function log(msg) {
    var line = (msg.indexOf('  ') === 0 ? '    ' : '') + '[' + new Date().toLocaleTimeString() + '] ' + msg.replace(/^ +/, '');
    state.log.push(line);
    if (state.log.length > 400) state.log.shift();
    if (refs.log) {
      refs.log.value = state.log.join('\n');
      refs.log.scrollTop = refs.log.scrollHeight;
    }
  }

  // 顶部那一行现在是「开着哪些生产列表」的全景，不再只有第一个瓦片：
  // 多星球同屏执行时，这一行就是判断「目标队列 id 到底开没开」的依据
  function refreshStatus() {
    if (!refs.status) return;
    var tiles = prodTiles().filter(tileVisible);
    if (!tiles.length) {
      var locs = uniq(state.scanned.map(function (t) { return t.loc; }));
      refs.status.textContent = (locs.length ? '星球 ' + locs.join(' / ') : '未扫描，不知道星球') +
        ' · 未找到打开的生产列表瓦片';
      refs.status.title = refs.status.textContent;
      return;
    }
    var parts = [];
    var allLocs = [];
    tiles.forEach(function (tile) {
      var lines = listLines(tile);
      harvestLines(lines);
      var locs = uniq(lines.map(locOfLine));
      allLocs = allLocs.concat(locs);
      var cmd = text(one(tile, 'TileFrame__cmd'));
      parts.push((cmd || 'PROD ?') + (locs.length ? ' @' + locs.join('/') : ' @未扫描') + ' ' +
        lines.map(function (l) { return lineInfoText(l) + '（进行' + l.active + '/队列' + l.queued + '/空' + l.free + '）'; }).join('，'));
    });
    refs.status.textContent = '打开 ' + tiles.length + ' 个生产列表 · 星球 ' +
      (allLocs.length ? uniq(allLocs).join(' / ') : '未扫描，点「扫描生产线模板」') +
      ' · ' + parts.join(' ｜ ');
    refs.status.title = refs.status.textContent;
  }

  // 队列行下拉框的数据源：显示名 + 队列 id + 星球码（星球码只有扫过才有）。
  // 把所有打开瓦片上的线并进来，多星球同屏时直接在下拉里选另一颗星球的那条线
  function lineNames() {
    return allLines().map(function (l) {
      return { name: l.name, code: l.code, loc: locOfLine(l) };
    });
  }

  // 样式必须在入口挂载时就注入：侧边标签自己没有样式的话，会退化成贴满页面宽度的块
  function injectStyle() {
    if (document.getElementById('prun-style')) return;
    var style = el('style');
    style.id = 'prun-style';
    style.textContent = [
      '#prun-panel{position:fixed;right:48px;top:64px;width:470px;max-height:82vh;display:flex;flex-direction:column;',
      'z-index:2147483000;background:#12161d;color:#d6dde8;border:1px solid #2f3a49;border-radius:8px;',
      'font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
      '#prun-panel header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;padding:8px 10px;border-bottom:1px solid #2f3a49;cursor:move}',
      '#prun-panel header b{font-size:13px}',
      // 多颗星球的生产列表同屏时顶部那行会很长：让它换行整幅占位，不要撑破面板
      '#prun-panel header .dim{order:3;flex:1 1 100%;min-width:0;font-size:11px;line-height:1.4;word-break:break-all}',
      // 关闭按钮留在标题那一行，状态那行独占下面一整行
      '#prun-panel header span:last-child{order:2}',
      '#prun-panel .tabs{display:flex;gap:4px;padding:6px 10px;border-bottom:1px solid #2f3a49}',
      '#prun-panel .tabs button{background:#1b222c;color:#aeb9c8;border:1px solid #2f3a49;border-radius:4px;padding:3px 10px;cursor:pointer}',
      '#prun-panel .tabs button.on{background:#2d6cdf;color:#fff;border-color:#2d6cdf}',
      '#prun-panel .body{overflow:auto;padding:8px 10px;flex:1}',
      '#prun-panel .row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #1d2531}',
      '#prun-panel .row .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#prun-panel .qitem{padding:5px 0;border-bottom:1px solid #1d2531}',
      '#prun-panel .qtop{display:flex;align-items:flex-start;gap:5px;min-width:0}',
      '#prun-panel .qtop .txt{min-width:0;flex:1}',
      '#prun-panel .qtop b{display:block;white-space:normal;word-break:break-all}',
      '#prun-panel .qtop .dim{display:block;white-space:normal;word-break:break-all}',
      '#prun-panel .qbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}',
      '#prun-panel .plan{color:#8fb2e6;margin-top:3px;word-break:break-all}',
      '#prun-panel .qtotal{padding:6px 0 2px;border-top:1px solid #2b3648;color:#c9d6e8}',
      '#prun-panel .qgroup{margin-top:8px;padding:4px 6px;background:#161d27;border-left:3px solid #2f6f5e;border-radius:3px}',
      '#prun-panel .qgtitle{display:flex;flex-wrap:wrap;gap:4px;align-items:baseline;color:#c9d6e8;word-break:break-all}',
      '#prun-panel .qgroup .row{margin-top:3px}',
      '#prun-panel .qgitem{border-left:3px solid #2f6f5e;padding-left:6px}',
      '#prun-panel details{border-bottom:1px solid #1d2531;padding:3px 0}',
      '#prun-panel summary{cursor:pointer;color:#8fb2e6;font-weight:600;padding:2px 0}',
      '#prun-panel details>.qitem{border-bottom:0;padding-left:12px}',
      '#prun-panel input,#prun-panel select,#prun-panel textarea{background:#1b222c;color:#d6dde8;border:1px solid #2f3a49;border-radius:4px;padding:2px 4px;font:inherit}',
      '#prun-panel textarea{width:100%;box-sizing:border-box;height:150px;font-family:ui-monospace,Consolas,monospace;font-size:11px;resize:vertical}',
      '#prun-panel button.act{background:#2d6cdf;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}',
      '#prun-panel button.warn{background:#b8860b;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}',
      '#prun-panel .dim{color:#7d8899}',
      '#prun-tab{position:fixed;right:0;top:120px;z-index:2147483001;width:32px;height:36px;display:flex;align-items:center;',
      'justify-content:center;background:#2d6cdf;color:#fff;border:1px solid #1f4e9e;border-right:0;border-radius:8px 0 0 8px;',
      'cursor:pointer;font:16px/1 system-ui;box-shadow:-2px 3px 10px rgba(0,0,0,.5);user-select:none}',
      '#prun-tab:hover{background:#3f7de0}',
      '.prun-hide{display:none!important}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function buildPanel() {
    injectStyle();
    var p = el('div');
    p.id = 'prun-panel';
    var head = el('header');
    head.appendChild(el('b', null, '生产队列'));
    refs.status = el('span', 'dim');
    head.appendChild(refs.status);
    var x = el('span', null, '×');
    x.style.cssText = 'margin-left:auto;cursor:pointer;padding:0 4px;font-size:15px';
    x.onclick = function () { panel.classList.add('prun-hide'); };
    head.appendChild(x);
    p.appendChild(head);

    var tabs = el('div', 'tabs');
    refs.tabBtns = {};
    ['配方', '队列', '执行'].forEach(function (name) {
      var b = el('button', null, name);
      b.onclick = function () { showTab(name); };
      refs.tabBtns[name] = b;
      tabs.appendChild(b);
    });
    refs.tabs = tabs;
    p.appendChild(tabs);

    var body = el('div', 'body');
    p.appendChild(body);
    refs.body = body;

    refs.panes = {
      配方: el('div'),
      队列: el('div'),
      执行: el('div')
    };
    buildRecipesPane(refs.panes['配方']);
    buildQueuePane(refs.panes['队列']);
    buildExecPane(refs.panes['执行']);
    Object.keys(refs.panes).forEach(function (k) { body.appendChild(refs.panes[k]); });

    document.body.appendChild(p);
    panel = p;
    refs.panel = p;
    enableDrag(head);
    showTab('配方');
  }

  function enableDrag(handle) {
    var sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.target.textContent === '×') return;
      dragging = true;
      sx = ev.clientX; sy = ev.clientY;
      var r = refs.panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      refs.panel.style.right = 'auto';
      refs.panel.style.left = ox + 'px';
      refs.panel.style.top = oy + 'px';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!dragging) return;
      refs.panel.style.left = (ox + ev.clientX - sx) + 'px';
      refs.panel.style.top = (oy + ev.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  function showTab(name) {
    Object.keys(refs.panes).forEach(function (k) {
      refs.panes[k].classList.toggle('prun-hide', k !== name);
      refs.tabBtns[k].classList.toggle('on', k === name);
    });
    if (name === '队列') { renderTemplates(); renderQueue(); }
    if (name === '配方') { renderRecipes(); }
    refreshStatus();
  }

  function buildRecipesPane(root) {
    root.innerHTML = '';
    var bar = el('div', 'row');
    refs.outSearch = el('input');
    refs.outSearch.placeholder = '产物 ticker，如 HER';
    refs.outSearch.style.width = '120px';
    refs.outSearch.oninput = function () {
      state.filterOut = refs.outSearch.value.trim();
      renderRecipes();
    };
    bar.appendChild(refs.outSearch);
    refs.tickerSel = el('select');
    refs.tickerSel.onchange = function () { state.filterTicker = refs.tickerSel.value; renderRecipes(); };
    bar.appendChild(refs.tickerSel);
    var rf = el('button', 'act', '刷新');
    rf.onclick = function () {
      loadRecipes(true).then(function () { fillTickers(); renderRecipes(); }, function (e) { log('刷新失败：' + e.message); });
    };
    bar.appendChild(rf);
    root.appendChild(bar);
    var hint = el('div', 'dim');
    hint.textContent = '只按产物英文缩写 + 建筑筛，不看中文名';
    root.appendChild(hint);
    refs.recipeList = el('div');
    root.appendChild(refs.recipeList);
    var count = el('div', 'dim');
    count.id = 'prun-rec-hint';
    root.appendChild(count);
  }

  function fillTickers() {
    var sel = refs.tickerSel;
    if (!sel) return;
    var cur = state.filterTicker;
    sel.innerHTML = '';
    var all = el('option', null, '全部建筑');
    all.value = '';
    sel.appendChild(all);
    tickers().forEach(function (t) {
      var o = el('option', null, t);
      o.value = t;
      sel.appendChild(o);
    });
    sel.value = cur || '';
  }

  function renderRecipes() {
    if (!refs.recipeList) return;
    fillTickers();
    refs.recipeList.innerHTML = '';
    var list = filteredRecipes();
    var hint = document.getElementById('prun-rec-hint');
    if (hint) {
      hint.textContent = state.recipes.length
        ? '共 ' + state.recipes.length + ' 条配方，显示前 ' + list.length + ' 条匹配'
        : '还没有配方数据，点「刷新配方」从 prunplanner 拉取';
    }
    list.forEach(function (r) {
      var item = el('div', 'qitem');
      var top = el('div', 'qtop');
      var txt = el('div', 'txt');
      txt.appendChild(el('b', null, r.building_ticker + ' ' + recipeLabel(r)));
      txt.appendChild(el('div', 'dim', (r._sig || recipeSig(r)) + ' · ' + fmtMs(r.time_ms)));
      top.appendChild(txt);
      item.appendChild(top);
      var bar = el('div', 'qbar');
      var known = state.lineMap[r.building_ticker];
      bar.appendChild(el('span', 'dim', known ? '已知生产线：' + known : '生产线未知（扫描后自动关联）'));
      var b = el('button', 'act', '入队');
      b.onclick = function () { addToQueue(r); };
      bar.appendChild(b);
      item.appendChild(bar);
      refs.recipeList.appendChild(item);
    });
  }

  function renderTemplates() {
    if (!refs.tplList) return;
    var sel = refs.tplLineSel;
    if (sel) {
      var cur = state.tplLine;
      sel.innerHTML = '';
      var all = el('option', null, '全部生产线');
      all.value = '';
      sel.appendChild(all);
      var seen = {};
      state.scanned.forEach(function (t) {
        var k = seen[t.line] || (seen[t.line] = { loc: '', code: '' });
        if (t.loc) k.loc = t.loc;
        if (t.code) k.code = t.code;
      });
      Object.keys(seen).sort().forEach(function (n) {
        var o = el('option', null, n + (seen[n].loc ? ' @ ' + seen[n].loc : '') + (seen[n].code ? ' PROD ' + seen[n].code : ''));
        o.value = n;
        sel.appendChild(o);
      });
      sel.value = cur || '';
      if (sel.value !== (cur || '')) state.tplLine = '';
    }
    refs.tplList.innerHTML = '';
    var list = filteredScanned();
    if (refs.tplHint) {
      refs.tplHint.textContent = state.scanned.length
        ? '模板 ' + state.scanned.length + ' 个，显示 ' + list.length + ' 个（' +
          (state.tplOut ? '产物 ' + state.tplOut + ' ' : '') + (state.tplLine || '全部生产线，按建筑分组') + '）'
        : '还没扫描过模板，点上面「扫描生产线模板」读取 APEX 的模板列表';
    }
    var grouped = !state.tplLine;
    var groups = {};
    var order = [];
    list.forEach(function (t) {
      var k = grouped ? t.line : '';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(t);
    });
    if (grouped) order.sort();
    order.forEach(function (k) {
      var rows = groups[k];
      if (grouped) {
        var box = document.createElement('details');
        box.open = !!state.tplOpen[k];
        var sum = el('summary', null, k + (rows[0].code ? ' PROD ' + rows[0].code : '') +
          (rows[0].loc ? ' @ ' + rows[0].loc : '') + '（' + rows.length + ' 个）');
        box.appendChild(sum);
        box.addEventListener('toggle', function () {
          state.tplOpen[k] = box.open;
          lsSet(K_TPLGROUP, state.tplOpen);
        });
        rows.forEach(function (t) { box.appendChild(tplRow(t, true)); });
        refs.tplList.appendChild(box);
      } else {
        rows.forEach(function (t) { refs.tplList.appendChild(tplRow(t, false)); });
      }
    });
  }

  function tplRow(t, hideLine) {
    var row = el('div', 'qitem');
    var top = el('div', 'qtop');
    var txt = el('div', 'txt');
    txt.appendChild(el('b', null, (hideLine ? '' : t.line + ' ') + t.label));
    txt.appendChild(el('div', 'dim', t.sig + ' · ' + t.duration +
      (t.code ? ' · PROD ' + t.code : '') + (t.loc ? ' @ ' + t.loc : '') +
      (t.api ? ' · ' + t.api.building_ticker : ' · API 无此配方')));
    top.appendChild(txt);
    var b = el('button', 'act', '入队');
    b.onclick = function () { addTemplateToQueue(t); };
    top.appendChild(b);
    row.appendChild(top);
    return row;
  }

  function buildQueuePane(root) {
    root.innerHTML = '';
    var scanRow = el('div', 'row');
    var scan = el('button', 'act', '扫描生产线模板');
    scanRow.appendChild(scan);
    scanRow.appendChild(el('span', 'dim', '读取 APEX 实际模板，抽取类生产线（钻井等）只能靠这里入队'));
    root.appendChild(scanRow);

    var tbar = el('div', 'row');
    refs.tplOut = el('input');
    refs.tplOut.placeholder = '模板产物 ticker';
    refs.tplOut.style.width = '120px';
    refs.tplOut.oninput = function () { state.tplOut = refs.tplOut.value.trim(); renderTemplates(); };
    tbar.appendChild(refs.tplOut);
    refs.tplLineSel = el('select');
    refs.tplLineSel.onchange = function () { state.tplLine = refs.tplLineSel.value; renderTemplates(); };
    tbar.appendChild(refs.tplLineSel);
    root.appendChild(tbar);
    refs.tplList = el('div');
    refs.tplList.style.borderBottom = '1px solid #2f3a49';
    root.appendChild(refs.tplList);
    refs.tplHint = el('div', 'dim');
    root.appendChild(refs.tplHint);
    renderTemplates();

    scan.onclick = function () {
      scan.disabled = true;
      scanLineTemplates().then(function (found) {
        renderTemplates();
        log('扫描完成：' + found.length + ' 个模板');
        renderRecipes();
        renderQueue();
        // 顶部的星球/队列 id 行要跟着这次扫描重算，不能停在上一颗星球
        refreshStatus();
      }).catch(function (e) {
        log('扫描失败：' + e.message);
        refreshStatus();
      }).then(function () { scan.disabled = false; });
    };
    var bar = el('div', 'row');
    var exp = el('button', 'act', '导出JSON');
    exp.onclick = function () {
      if (!state.queue.length) { log('队列是空的，没什么可导出'); return; }
      var name = exportName();
      try {
        var url = URL.createObjectURL(new Blob([JSON.stringify(state.queue.map(exportEntry), null, 2)], { type: 'application/json' }));
        var a = el('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        log('已导出 ' + state.queue.length + ' 条 → ' + name);
      } catch (e) {
        log('导出失败：' + e.message);
      }
    };
    bar.appendChild(exp);
    var imp = el('button', 'act', '导入JSON');
    var file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.style.display = 'none';
    file.onchange = function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      f.text().then(function (raw) {
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr)) throw new Error('文件里不是数组');
        var list = arr.map(normalizeEntry).filter(Boolean);
        if (!list.length) throw new Error('没有一条能认出来（缺 sig/label？）');
        if (!window.confirm('导入 ' + list.length + ' 条，替换当前 ' + state.queue.length + ' 条队列？')) return;
        state.queue = list;
        saveQueue();
        // 档里带着队列 id 和星球码，顺手并进登记表，换电脑/换浏览器导入后状态栏就认识这些线
        var regChanged = false;
        list.forEach(function (e) {
          if (!e.code) return;
          var rec = state.lines[e.code] || (state.lines[e.code] = {});
          if (e.line && !rec.name) { rec.name = e.line.replace(/#[0-9a-f]{5,}$/i, ''); }
          if (e.loc && rec.loc !== e.loc) { rec.loc = e.loc; regChanged = true; }
        });
        if (regChanged) lsSet(K_LINES, state.lines);
        renderQueue();
        refreshStatus();
        var ids = uniq(list.map(codeFor));
        log('从 ' + f.name + ' 导入 ' + list.length + ' 条' +
          (ids.length ? '，队列 id ' + ids.map(function (c) { return 'PROD ' + c; }).join('/') : '（没有队列 id，按线名执行）'));
      }).catch(function (e) { log('导入失败：' + e.message); });
    };
    imp.onclick = function () { file.click(); };
    bar.appendChild(imp);
    bar.appendChild(file);
    var clr = el('button', 'warn', '清空');
    clr.onclick = function () {
      if (!state.queue.length) return;
      if (window.confirm('清空队列？')) { state.queue = []; saveQueue(); renderQueue(); }
    };
    bar.appendChild(clr);
    root.appendChild(bar);

    root.appendChild(el('div', 'dim',
      '↓ 队列按「工厂」分组：执行时做完一家再做下一家，同一厂里的多条产物按组内顺序轮转；勾了「重复填满」的没有次数上限，下到这条线实测无空位为止。'));

    // 续排开关：默认开——执行前先读这条线已经排好的队列，从最后一单之后接着排
    var rr = el('div', 'row');
    var resume = el('input');
    resume.type = 'checkbox';
    resume.checked = state.resume !== false;
    var rlabel = el('label', 'dim');
    rlabel.title = '关掉就每次从队列第一条开始排，不看线上已经排了什么';
    rlabel.appendChild(resume);
    rlabel.appendChild(document.createTextNode(' 执行前读取线上队列，从最后一单之后续排'));
    rr.appendChild(rlabel);
    resume.onchange = function () {
      state.resume = resume.checked;
      lsSet(K_RESUME, state.resume);
      log('续排：' + (state.resume ? '开（先读线上队列再决定从哪条起）' : '关（每次从第一条开始）'));
      renderQueue();
    };
    root.appendChild(rr);

    refs.queueList = el('div');
    root.appendChild(refs.queueList);

    // 排好队直接在这一页点执行；是否干跑在执行页配置，这里不弹任何确认
    var sep = el('div', 'dim');
    sep.style.cssText = 'padding-top:6px;border-top:1px solid #2f3a49';
    sep.textContent = '↓ 执行：一个工厂一个工厂做完（组内轮转）；是否干跑在「执行」页配置（默认不干跑）';
    root.appendChild(sep);
    var rrow = el('div', 'row');
    refs.run = el('button', 'act', '执行队列');
    refs.run.style.flex = '1';
    refs.run.onclick = function () { runQueue(state.dryRun); };
    rrow.appendChild(refs.run);
    root.appendChild(rrow);
    syncRunBtn();
  }

  function renderQueue() {
    if (!refs.queueList) return;
    refs.queueList.innerHTML = '';
    if (!state.queue.length) {
      refs.queueList.appendChild(el('div', 'dim', '队列为空，从上方模板或「配方」页签入队。'));
      return;
    }
    var names = lineNames();
    var total = el('div', 'dim qtotal');
    function syncTotals() { total.textContent = totalsText(); }

    // 组内上下移动：只在本厂的条目之间换位，不会把订单挪到别的工厂去
    function moveWithin(e, dir) {
      var idx = state.queue.indexOf(e);
      var k = groupKey(e);
      var j = idx;
      for (;;) {
        var n = j + dir;
        if (n < 0 || n >= state.queue.length) return;   // 这一头已经是本厂的第一/最后一条
        j = n;
        if (groupKey(state.queue[j]) === k) break;      // 中间夹着的别的厂的条目越过不管
      }
      var list = state.queue.slice();
      list.splice(idx, 1);
      var at = j > idx ? j - 1 : j;
      list.splice(at + (dir > 0 ? 1 : 0), 0, e);
      state.queue = list;
      saveQueue();
      renderQueue();
    }
    // 整组换位：把这一家的所有条目挪到相邻那一家前面/后面，顺带把交叉的条目归拢成连续
    function moveGroup(from, dir) {
      var groups = groupQueue(state.queue);
      var to = from + dir;
      if (to < 0 || to >= groups.length) return;
      var order = groups.map(function (g) { return g.entries; });
      var tmp = order[from];
      order[from] = order[to];
      order[to] = tmp;
      state.queue = [];
      order.forEach(function (list) { state.queue = state.queue.concat(list); });
      saveQueue();
      renderQueue();
    }

    var groups = groupQueue(state.queue);
    groups.forEach(function (g, gIdx) {
      var head = el('div', 'qgroup');
      var ht = el('div', 'qgtitle');
      ht.appendChild(el('b', null, (gIdx + 1) + '. ' + g.label));
      ht.appendChild(el('span', 'dim', '　' + g.entries.length + ' 条产物：' +
        g.entries.map(function (e, i) { return (i + 1) + '.' + (outTicker(e) || e.label); }).join(' → ')));
      head.appendChild(ht);
      var gbtns = el('div', 'row');
      var gu = el('button', null, '↑ 整组');
      gu.title = '把这个工厂整组前移，执行时就更早开工';
      gu.onclick = function () { moveGroup(gIdx, -1); };
      var gd = el('button', null, '↓ 整组');
      gd.title = '把这个工厂整组后移';
      gd.onclick = function () { moveGroup(gIdx, 1); };
      gbtns.appendChild(gu);
      gbtns.appendChild(gd);
      head.appendChild(gbtns);
      refs.queueList.appendChild(head);
      g.entries.forEach(function (e, i) { renderItem(e, i + 1); });
    });

    function renderItem(e, seq) {
      var idx = state.queue.indexOf(e);
      var item = el('div', 'qitem qgitem');

      var top = el('div', 'qtop');
      var on = el('input');
      on.type = 'checkbox';
      on.checked = !!e.on;
      on.title = '参与执行';
      on.onchange = function () { e.on = on.checked; saveQueue(); sync(); };
      top.appendChild(on);
      var txt = el('div', 'txt');
      txt.appendChild(el('b', null, seq + '. ' + e.building + ' ' + e.label));
      txt.appendChild(el('div', 'dim', e.sig + ' · ' + fmtMs(e.time_ms)));
      top.appendChild(txt);
      item.appendChild(top);

      var bar = el('div', 'qbar');
      bar.appendChild(el('span', 'dim', '生产线'));

      var sel = el('select');
      var lineLabel = function (l) {
        return l.name + (l.code ? ' PROD ' + l.code : '') + (l.loc ? ' @ ' + l.loc : '');
      };
      // 多个瓦片同屏后光靠线名不唯一了（两颗星球各有一个「农场」），
      // 下拉框的取值必须是 线名@队列 id 这个组合键
      var lineKey = function (l) { return l.code ? l.name + '@' + l.code : l.name; };
      var opts = [{ name: '自动', code: '', loc: '' }].concat(names);
      var want = lineKey({ name: e.line, code: e.code });
      // 生产列表瓦片没打开时 lineNames() 为空，不能因此把用户选定的生产线抹掉
      if (!opts.some(function (l) { return lineKey(l) === want; }) && e.line && e.line !== '自动') {
        opts.push({ name: e.line, code: e.code || '', loc: '' });
      }
      opts.forEach(function (l) {
        var o = el('option', null, lineLabel(l));
        o.value = lineKey(l);
        sel.appendChild(o);
      });
      sel.value = want;
      if (sel.value !== want) { sel.value = '自动'; e.line = '自动'; e.code = ''; }
      sel.onchange = function () {
        var hit = opts.filter(function (l) { return lineKey(l) === sel.value; })[0];
        e.line = hit ? hit.name : sel.value;
        e.code = hit ? hit.code : '';
        saveQueue();
        sync();
      };
      bar.appendChild(sel);

      bar.appendChild(el('span', 'dim', '大小'));
      var size = el('input');
      size.type = 'number';
      size.min = '1';
      size.max = '20';
      size.value = e.size;
      size.style.width = '42px';
      size.title = '订单大小';
      size.onchange = function () {
        e.size = Math.max(1, Math.min(20, Number(size.value) || 1));
        size.value = e.size;
        saveQueue();
        sync();
      };
      bar.appendChild(size);

      var rep = el('label', 'dim');
      rep.title = '勾选后执行时在本厂内按组内顺序轮转下单：一轮里每条勾选的各下一单，一直下到这条线实测无空位（或库存不足）为止；不再看次数上限';
      var repc = el('input');
      repc.type = 'checkbox';
      repc.checked = !!e.repeat;
      repc.onchange = function () { e.repeat = repc.checked; saveQueue(); sync(); };
      rep.appendChild(repc);
      rep.appendChild(document.createTextNode('重复填满'));
      bar.appendChild(rep);

      var fit = el('label', 'dim');
      fit.title = '库存不足时自动把订单大小降到可承担的档';
      var fitc = el('input');
      fitc.type = 'checkbox';
      fitc.checked = e.autoFit !== false;
      fitc.onchange = function () { e.autoFit = fitc.checked; saveQueue(); sync(); };
      fit.appendChild(fitc);
      fit.appendChild(document.createTextNode('降档'));
      bar.appendChild(fit);

      var summary = el('div', 'plan');
      var time = el('div', 'plan');
      function sync() {
        summary.textContent = planText(e);
        time.textContent = timeText(e);
        syncTotals();
      }
      sync();

      var up = el('button', null, '↑');
      up.title = '在本厂内前移一位（不会挪到别的工厂去）';
      up.onclick = function () { moveWithin(e, -1); };
      bar.appendChild(up);
      var dn = el('button', null, '↓');
      dn.title = '在本厂内后移一位';
      dn.onclick = function () { moveWithin(e, 1); };
      bar.appendChild(dn);
      var rm = el('button', null, '删');
      rm.onclick = function () {
        state.queue.splice(idx, 1);
        saveQueue(); renderQueue();
      };
      bar.appendChild(rm);
      item.appendChild(bar);
      item.appendChild(summary);
      item.appendChild(time);

      refs.queueList.appendChild(item);
    }
    syncTotals();
    refs.queueList.appendChild(total);
  }

  function buildExecPane(root) {
    root.innerHTML = '';
    var r1 = el('div', 'row');
    refs.dryRun = el('input');
    refs.dryRun.type = 'checkbox';
    refs.dryRun.checked = state.dryRun;
    refs.dryRun.onchange = function () {
      state.dryRun = refs.dryRun.checked;
      lsSet(K_DRYRUN, state.dryRun);
      log('执行模式：' + (state.dryRun ? '干跑（不提交，只验证能否下单）' : '真实下单'));
      syncRunBtn();
    };
    var dl = el('label', null, '干跑（不提交，只验证能否下单）');
    dl.insertBefore(refs.dryRun, dl.firstChild);
    r1.appendChild(dl);
    r1.appendChild(el('span', 'dim', '队列页的「执行队列」按这里的档位运行'));
    root.appendChild(r1);

    var r2 = el('div', 'row');
    var stat = el('button', null, '读取当前队列');
    stat.onclick = function () {
      var tiles = prodTiles().filter(tileVisible);
      if (!tiles.length) { log('没有打开的生产列表瓦片'); return; }
      log('页面上打开着 ' + tiles.length + ' 个生产列表');
      tiles.forEach(function (tile) {
        var lines = listLines(tile);
        var locs = uniq(lines.map(locOfLine));
        log('【' + (text(one(tile, 'TileFrame__cmd')) || 'PROD ?') +
          (locs.length ? ' @' + locs.join('/') : '') + '】');
        lines.forEach(function (l) {
          log('  ' + l.name + '：进行 ' + l.active + '，队列 ' + l.queued + '，空槽位 ' + l.free);
          l.orders.slice(0, 8).forEach(function (o) {
            log('    ' + (o.queued ? '[队列]' : '[进行]') + ' ' + o.ticker + ' ' + o.name + ' ' + o.qty + ' ' + o.eta + ' ' + o.status);
          });
          if (l.orders.length > 8) log('    …还有 ' + (l.orders.length - 8) + ' 单未列出');
        });
      });
      refreshStatus();
    };
    r2.appendChild(stat);
    var openProd = el('button', null, '打开PROD');
    openProd.onclick = function () {
      var t = Array.prototype.filter.call(document.querySelectorAll('[class*="TileFrame__title"], [class*="SCRNS"], span, div'), function (x) {
        return x.textContent.trim() === 'PROD' && x.offsetWidth;
      })[0];
      if (t) { t.click(); log('已尝试打开 PROD'); } else { log('没找到 PROD 入口，请手动打开生产列表'); }
    };
    r2.appendChild(openProd);
    root.appendChild(r2);

    refs.log = el('textarea');
    refs.log.readOnly = true;
    root.appendChild(refs.log);

    var r3 = el('div', 'row');
    var expLog = el('button', 'act', '导出日志');
    expLog.onclick = function () {
      if (!state.log.length) { log('日志是空的，没什么可导出'); return; }
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'prun-log_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        '-' + p(d.getHours()) + p(d.getMinutes()) + '.txt';
      try {
        var url = URL.createObjectURL(new Blob([state.log.join('\n')], { type: 'text/plain;charset=utf-8' }));
        var a = el('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        log('已导出日志 ' + state.log.length + ' 行 → ' + name);
      } catch (e) {
        log('导出日志失败：' + e.message);
      }
    };
    r3.appendChild(expLog);
    var clrLog = el('button', 'warn', '清空日志');
    clrLog.onclick = function () {
      state.log = [];
      if (refs.log) refs.log.value = '';
    };
    r3.appendChild(clrLog);
    root.appendChild(r3);
  }

  // ---------------------------------------------------------------- boot

  function toggle() {
    if (!panel || !document.body.contains(panel)) {
      buildPanel();
      panel = refs.panel;
      loadRecipes(false).then(function () { renderRecipes(); refreshStatus(); }, function (e) {
        log('配方加载失败：' + e.message);
      });
      // 刚建好就是可见的，不能再 toggle 一次把自己藏掉
      return;
    }
    var hidden = panel.classList.toggle('prun-hide');
    if (!hidden) refreshStatus();
  }

  function addTrigger() {
    injectStyle();
    // 侧边标签贴在视口右缘，不占用游戏顶栏
    var b = el('div', null, '★');
    b.id = 'prun-tab';
    b.title = '生产队列（Alt+Q）';
    b.onclick = toggle;
    document.body.appendChild(b);
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.altKey && (ev.key === 'q' || ev.key === 'Q')) {
      ev.preventDefault();
      toggle();
    }
  });

  // 顶栏可能延迟渲染，等 body 稳定后再挂入口
  waitFor(function () { return document.body; }, 5000).then(addTrigger, addTrigger);

  // 面板开着的时候切星球、开/关生产列表窗口，游戏不通知任何人：
  // 靠一个只看瓦片指纹的轮询发现变化，变了就重算顶部那行星球/队列 id。
  // 指纹要覆盖**所有**打开的瓦片，多星球同屏时关掉其中一个也算变化
  var lastSig = '';
  setInterval(function () {
    if (!refs.status || !panel || !document.body.contains(panel)) return;
    if (panel.classList.contains('prun-hide')) return;
    if (running) return;
    var sig = prodTiles().filter(tileVisible).map(function (t) {
      var lines = listLines(t);
      return (tileCode(t) || '?') + ':' + lines.map(function (l) { return l.name + ':' + l.active + '/' + l.queued; }).join(',');
    }).join('|') || 'none';
    if (sig === lastSig) return;
    lastSig = sig;
    refreshStatus();
  }, 2500);
})();
