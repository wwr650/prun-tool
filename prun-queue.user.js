// ==UserScript==
// @name         PRUN 生产队列面板
// @namespace    https://github.com/wwr650/prun-tool
// @version      0.1.0
// @description  在 APEX 里自定义生产队列，用 prunplanner 配方一键批量下单（默认干跑）
// @author       wwr650
// @match        https://apex.prosperousuniverse.com/*
// @connect      api.prunplanner.org
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var RECIPES_URL = 'https://api.prunplanner.org/data/recipes/';
  var K_RECIPES = 'prun.recipes.v1';
  var K_QUEUE = 'prun.queue.v1';
  var K_SCANNED = 'prun.scanned.v1';
  var K_TPLGROUP = 'prun.tplgroup.v1';

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

  function httpGetText(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url: url, timeout: 30000,
          onload: function (r) {
            if (r.status >= 200 && r.status < 300) resolve(r.responseText);
            else reject(new Error('HTTP ' + r.status));
          },
          onerror: function () { reject(new Error('请求失败（网络或被拦截）')); },
          ontimeout: function () { reject(new Error('请求超时')); }
        });
      } else {
        fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then(resolve, reject);
      }
    });
  }

  // ---------------------------------------------------------------- recipes

  var state = {
    recipes: lsGet(K_RECIPES, []),
    recipesAt: lsGet('prun.recipes.at', null),
    queue: lsGet(K_QUEUE, []),
    scanned: lsGet(K_SCANNED, []),
    lineMap: lsGet('prun.linemap', {}),
    filterOut: '',
    filterTicker: '',
    tplOut: '',
    tplLine: '',
    tplOpen: lsGet(K_TPLGROUP, {}),
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

  // 队列条目的星球不单独存，按 生产线+签名 回查扫描结果，改线或重扫后不会留下过期值
  function locFor(e) {
    if (!e.line || e.line === '自动') return '';
    var hit = state.scanned.filter(function (t) { return t.line === e.line && t.sig === e.sig; })[0];
    return hit ? hit.loc : '';
  }

  // 队列条目下方那行：把用户选的参数复述一遍，控件挤掉也能看清方案
  function planText(e) {
    var p = [];
    var loc = locFor(e);
    p.push('线=' + (e.line || '自动') + (loc ? ' @ ' + loc : ''));
    p.push('大小=' + (e.size || 1));
    p.push(e.repeat ? '重复填满（上限 ' + (e.repeatMax || 20) + ' 次）' : '单次');
    p.push(e.autoFit === false ? '不降档' : '库存不足自动降档');
    p.push(e.on === false ? '已停用' : '参与执行');
    return '方案 ' + p.join(' · ');
  }

  // 一单耗时 = 配方单件时长 × 订单大小；勾了重复填满就按上限给最坏总耗时
  function orderMs(e) {
    return (e.time_ms || 0) * Math.max(1, e.size || 1);
  }
  function orderCount(e) {
    return e.repeat ? Math.max(1, e.repeatMax || 20) : 1;
  }
  function timeText(e) {
    if (!e.time_ms) return '耗时未知（本地模板没读到时长）';
    var one = orderMs(e);
    var n = orderCount(e);
    return '耗时 单件 ' + fmtMs(e.time_ms) + ' × 大小 ' + Math.max(1, e.size || 1) +
      ' = 一单 ' + fmtMs(one) + (n > 1 ? ' × ' + n + ' 单 = ' + fmtMs(one * n) : '') +
      '（' + (e.dur_src || 'API 口径') + '）';
  }
  // 同一条生产线的订单只能首尾相接，不同线并行跑，所以给两个数
  function totalsText() {
    var sel = state.queue.filter(function (e) { return e.on; });
    if (!sel.length) return '';
    var perLine = {};
    var serial = 0;
    var known = 0;
    sel.forEach(function (e) {
      var t = orderMs(e) * orderCount(e);
      if (!t) return;
      known++;
      serial += t;
      var k = e.line || '自动';
      perLine[k] = (perLine[k] || 0) + t;
    });
    if (!known) return '';
    var wall = Math.max.apply(null, Object.keys(perLine).map(function (k) { return perLine[k]; }));
    return '选中 ' + sel.length + ' 条：串行相加 ' + fmtMs(serial) +
      '，按线并行 ' + fmtMs(wall) + '（取最长的一条线）' +
      (known < sel.length ? '，' + (sel.length - known) + ' 条无时长未计入' : '');
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
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    var safe = function (s) { return String(s).replace(/[<>:"/\\|?*]+/g, '_'); };
    return safe(planets.length === 1 ? planets[0] : planets.length ? '多星球' + planets.length : '未知星球') +
      '_' + safe(blds.length === 1 ? blds[0] : blds.length ? '多建筑' + blds.length : '未知建筑') +
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
    log('入队 [' + entry.building + '] ' + entry.label + ' -> ' + entry.line);
    renderQueue();
  }

  // 导入的文件是外部输入，缺字段就把渲染队列时会读的那几个补上，其余原样保留
  function normalizeEntry(e) {
    if (!e || typeof e !== 'object' || !e.sig) return null;
    e.id = e.id || Math.random().toString(36).slice(2, 9);
    e.label = e.label || e.sig;
    e.building = e.building || '?';
    e.line = e.line || '自动';
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
      recipe_id: t.api ? t.api.recipe_id : 'line:' + t.line + ':' + t.sig,
      label: t.label,
      sig: t.sig,
      building: t.api ? t.api.building_ticker : '本地/' + t.line,
      time_ms: t.time_ms,
      dur_src: 'APEX 实测',
      line: t.line
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

  function uniq(list) {
    var out = [];
    list.forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }

  async function scanLineTemplates() {
    var tile = prodTile();
    if (!tile) throw new Error('页面上找不到生产列表（PROD）瓦片，请先打开它');
    var lines = listLines(tile);
    var found = [];
    log('扫描 ' + lines.length + ' 条生产线的模板：' + lines.map(function (l) { return l.name; }).join(' / '));
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var w = null;
      try {
        var opened = await openOrderWindow(line);
        w = opened.w;
        var loc = readLocation(opened.form);
        var opts = await readTemplateOptions(opened.form);
        opts.forEach(function (o) {
          var api = null;
          for (var k = 0; k < state.recipes.length; k++) {
            if ((state.recipes[k]._sig || recipeSig(state.recipes[k])) === o.sig) { api = state.recipes[k]; break; }
          }
          if (api) state.lineMap[api.building_ticker] = line.name;
          found.push({
            line: line.name, sig: o.sig, label: o.label, duration: o.duration,
            time_ms: parseDurationMs(o.duration), loc: loc, api: api
          });
        });
        log('  ' + line.name + (loc ? ' @ ' + loc : '') + '：' + opts.length + ' 个模板，其中 ' +
          found.filter(function (f) { return f.line === line.name && f.api; }).length + ' 个能对上 API 配方');
        await closeWindow(w);
        w = null;
      } catch (e) {
        log('  ' + line.name + ' 扫描失败：' + e.message);
      } finally {
        if (w) { try { await closeWindow(w); } catch (e2) { /* 已关闭 */ } }
      }
      // closeWindow 已经等到窗口不可见，这里只留一帧让 PROD 瓦片自己刷完
      await nextFrame();
    }
    lsSet('prun.linemap', state.lineMap);
    state.scanned = found;
    lsSet(K_SCANNED, found);
    log('已关联建筑→生产线：' + Object.keys(state.lineMap).map(function (k) { return k + '=' + state.lineMap[k]; }).join(' '));
    return found;
  }

  // ------------------------------------------------------ APEX DOM reading

  function prodTile() {
    var frames = byClass(document, 'TileFrame__frame');
    for (var i = 0; i < frames.length; i++) {
      if (/生产线/.test(text(one(frames[i], 'TileFrame__title')))) return frames[i];
    }
    return null;
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

  function readOrders(col) {
    if (!col) return [];
    return byClass(col, 'OrderSlot__container').map(function (s) {
      var info = one(s, 'OrderSlot__info');
      var cells = info ? Array.prototype.map.call(info.children, text) : [];
      var iconBox = one(s, 'ColoredIcon__container');
      return {
        ticker: text(one(s, 'ColoredIcon__label')),
        name: iconBox ? iconBox.getAttribute('title') : '',
        qty: cells[0] || '',
        eta: cells[1] || '',
        status: text(one(s, 'OrderStatus__inProgress')) || cells[2] || '',
        queued: !!one(s, 'OrderTile__queue')
      };
    });
  }

  function listLines(tile) {
    var grid = one(tile, 'SiteProductionLines__grid');
    if (!grid) return [];
    var headers = Array.prototype.filter.call(grid.children, function (c) {
      return c.className.indexOf('header') >= 0;
    });
    var cols = Array.prototype.filter.call(grid.children, function (c) {
      return c.className.indexOf('column__') >= 0;
    });
    return headers.map(function (h, i) {
      var orders = readOrders(cols[i]);
      return {
        name: text(one(h, 'headerName')),
        header: h,
        orders: orders,
        active: orders.filter(function (o) { return !o.queued; }).length,
        queued: orders.filter(function (o) { return o.queued; }).length
      };
    });
  }

  // ---------------------------------------------------- order automation

  // 该线订单槽位的占用签名；下单成功后它必然变化，用它替代下单后的固定等待
  function lineLoad(name) {
    var t = prodTile();
    if (!t) return null;
    var hit = listLines(t).filter(function (l) { return l.name === name; })[0];
    return hit ? hit.orders.length * 100 + hit.queued : null;
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

  async function setOrderSize(form, target, baseMs) {
    var handle = form.querySelector('.rc-slider-handle');
    var box = form.querySelector('.rc-slider');
    if (!handle || !box) throw new Error('找不到订单大小滑块');
    var min = Number(handle.getAttribute('aria-valuemin'));
    var max = Number(handle.getAttribute('aria-valuemax'));
    if (isNaN(min) || isNaN(max) || max <= min) { min = 1; max = 20; }
    if (!box.getBoundingClientRect().width) throw new Error('订单大小滑块还没渲染出来');
    var want = Math.max(min, Math.min(max, target));
    var expect = baseMs ? baseMs * want : NaN;
    var last = '';
    function applied() {
      var now = Number(handle.getAttribute('aria-valuenow'));
      var rng = readCostRange(form);
      var ok = !rng || isNaN(expect) ? true : expect >= rng.lo && expect <= rng.hi;
      last = '滑块 ' + now + '，表单耗时 ' + (rng ? rng.txt : '读不到') + '，应为 ' + fmtMs(expect);
      return now === want && ok;
    }
    for (var attempt = 0; attempt < 3; attempt++) {
      var cur = Number(handle.getAttribute('aria-valuenow'));
      // 滑块读数已经等于目标值但耗时对不上时，原地拖没有位移、React 不会重放 onChange，
      // 所以先拖偏一格再拖回来，逼它产生一次真实变化
      var start = want;
      if (attempt === 0 && cur !== want) start = cur;
      else start = want === max ? want - 1 : want + 1;
      start = Math.max(min, Math.min(max, start));
      await dragSlider(box, handle, start, want);
      if (await waitFor(applied, 600, '订单大小生效').catch(function () { return false; })) {
        if (!readCostRange(form) || isNaN(expect)) log('  订单大小 ' + want + '（时长读不到，只核对了滑块读数）');
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

  // 下单被两道闸门卡住：队列位不足、仓储不满足输入需求。表单里没有报错文字，
  // 只能自己读输入材料行算出来，否则只能看到"按钮是灰的"这种无用信息
  function readAvailability(form) {
    var holder = form.parentElement || form;
    var view = one(holder, 'InputsOutputsView__container') || one(document, 'InputsOutputsView__container');
    if (!view) return [];
    var inputs = one(view, 'InputsOutputsView__inputs');
    if (!inputs) return [];
    return byClass(inputs, 'InputsOutputsView__materialContainer').map(function (m) {
      var t = text(one(m, 'ColoredIcon__label'));
      var raw = text(one(m, 'InputsOutputsView__amount'));
      var perCycle = parseNum(raw);
      var avEl = one(m, 'InputsOutputsView__amountAvailable');
      var avail = avEl ? parseNum(text(avEl)) : parseNum((/仓储中有([\d,.]+)/.exec(raw) || [])[1]);
      return { ticker: t, perCycle: perCycle, avail: avail };
    }).filter(function (x) { return x.ticker; });
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

  function describeBlock(form, size) {
    var rows = readAvailability(form);
    var short = rows.filter(function (r) { return r.perCycle > 0 && r.avail < r.perCycle * size; });
    if (short.length) {
      return {
        reason: '库存不足',
        detail: short.map(function (r) {
          return r.ticker + ' 需 ' + (r.perCycle * size) + '，仓储 ' + r.avail;
        }).join('；'),
        affordable: maxAffordableSize(rows, size)
      };
    }
    return { reason: '队列已满', detail: '输入材料够，说明该生产线的排队位已占满', affordable: null };
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
      var size = sizeWanted;
      // 先定模式再定大小：切「重复/单次」可能把滑块弹回原位，顺序反了校验就白做了。
      // 这里恒传 false：APEX 自带的「重复订单」会让游戏无限重复该订单，
      // 队列填满由本脚本的轮转负责，两者语义不同，不能同时开
      await setRepeat(form, false);
      await setOrderSize(form, size, baseMs);
      var btn = submitButton(form);
      if (!btn) throw new Error('找不到下单按钮');
      var ready = btn.className.indexOf('Button__disabled') < 0;
      var block = ready ? null : describeBlock(form, size);
      if (!ready && entry.autoFit && block && block.reason === '库存不足' &&
          block.affordable >= 1 && block.affordable < size) {
        size = Math.min(block.affordable, 20);
        await setOrderSize(form, size, baseMs);
        ready = btn.className.indexOf('Button__disabled') < 0;
        block = ready ? null : describeBlock(form, size);
        log('  自动降档 x' + sizeWanted + ' → x' + size);
      }
      var rng = readCostRange(form);
      var cost = rng ? rng.txt : '未知';
      if (opts.dryRun) return { placed: false, ready: ready, size: size, tpl: tpl, cost: cost, block: block };
      if (!ready) return { placed: false, ready: false, size: size, tpl: tpl, cost: cost, block: block };
      btn.click();
      // 等到「看得见的证据」：该线槽位变化，或对话框自己收起来。上限就是原来固定睡的 700ms
      var load0 = lineLoad(line.name);
      await waitFor(function () {
        return lineLoad(line.name) !== load0 ||
          !document.body.contains(w) || !(w.offsetWidth || w.offsetHeight);
      }, 700, '订单入队').catch(function () { /* 证据没等到也只等满原来的 700ms */ });
      return { placed: true, ready: true, size: size, tpl: tpl, cost: cost, block: null };
    } finally {
      try { await closeWindow(w); } catch (e2) { /* 窗口已自行关闭 */ }
    }
  }

  // 一次只下一单。填不进（队列满 / 缺料）返回 placed:false，那不是错误，是轮转停止信号
  async function placeOnce(entry, opts) {
    var tile = prodTile();
    if (!tile) throw new Error('页面上找不到生产列表（PROD）瓦片，请先打开它');
    var lines = listLines(tile);
    if (!lines.length) throw new Error('生产列表里没有生产线');

    var targets = entry.line && entry.line !== '自动'
      ? lines.filter(function (l) { return l.name === entry.line; })
      : lines;
    if (!targets.length) throw new Error('找不到生产线「' + entry.line + '」，当前有：' + lines.map(function (l) { return l.name; }).join(' / '));

    var why = null;
    for (var i = 0; i < targets.length; i++) {
      var line = targets[i];
      try {
        var r = await attemptOnce(line, entry, opts, entry.size);
        var block = r.block ? r.block.reason + '：' + r.block.detail : '表单未就绪';
        if (opts.dryRun) {
          if (!r.ready) {
            why = line.name + ' ' + block;
            log('  干跑受阻：' + why);
            continue;
          }
          log('  干跑：' + line.name + ' ' + r.tpl.label + ' x' + r.size +
            '，表单耗时 ' + fmtMs(r.cost) + '，已就绪未提交' +
            (entry.repeat ? '；真实执行会轮转填满，上限 ' + (entry.repeatMax || 20) + ' 单' : ''));
          return { placed: false, dry: true };
        }
        if (!r.placed) {
          why = line.name + ' ' + block;
          log('  跳过 ' + line.name + '：' + block);
          continue;
        }
        log('  已下单 ' + line.name + ' x' + r.size + '（表单耗时 ' + fmtMs(r.cost) + '）：' + r.tpl.label);
        refreshStatus();
        return { placed: true, size: r.size, line: line.name };
      } catch (e) {
        if (entry.line && entry.line !== '自动') throw e;
        why = e.message;
        log('  ' + line.name + ' 跳过：' + e.message);
      }
    }
    return { placed: false, reason: why || ('没有生产线能匹配 ' + entry.sig) };
  }

  // 多条一起勾选重复填满时按队列顺序轮转：一轮里每条各下一单，而不是一条灌满再换下一条
  async function runQueue(dryRun) {
    var entries = state.queue.filter(function (e) { return e.on; });
    if (!entries.length) { log('队列为空'); return; }
    var caps = entries.map(function (e) { return orderCount(e); });
    var done = entries.map(function () { return 0; });
    var plan = caps.reduce(function (s, c) { return s + c; }, 0);
    log('=== ' + (dryRun ? '干跑' : '真实下单') + '：' + entries.length + ' 条，按队列顺序轮转，计划 ' + plan + ' 单 ===');
    var round = 0, placed = 0, ready = 0, aborted = false;
    for (;;) {
      var pending = caps.filter(function (c, i) { return done[i] < c; }).length;
      if (!pending) break;
      round++;
      for (var i = 0; i < entries.length; i++) {
        if (done[i] >= caps[i]) continue;
        var e = entries[i];
        log('[第' + round + '轮 ' + (i + 1) + '/' + entries.length + '] ' + e.building + ' ' + e.label +
          ' x' + e.size + ' -> ' + e.line + '（' + (done[i] + 1) + '/' + caps[i] + '）');
        var res = null;
        try {
          res = await placeOnce(e, { dryRun: dryRun });
        } catch (err) {
          log('  失败：' + err.message);
          if (!dryRun) { log('真实下单出错即中止，避免继续误操作'); aborted = true; break; }
        }
        if (dryRun) {
          if (res && res.dry) ready++;
          done[i] = caps[i];
          continue;
        }
        if (res.placed) { done[i]++; placed++; }
        else {
          done[i] = caps[i];
          log('  「' + e.label + '」停止续填：' + (res.reason || '未成功'));
        }
      }
      if (aborted || dryRun) break;
      await nextFrame();
    }
    log('=== 结束：' + round + ' 轮，' +
      (dryRun ? '可下 ' + ready + ' / ' + entries.length + ' 条' : '成功 ' + placed + ' 单') +
      (aborted ? '，出错中止' : '') + ' ===');
    refreshStatus();
  }

  // ---------------------------------------------------------------- UI

  var panel = null;
  var refs = {};
  var realRun = false;

  function log(msg) {
    var line = (msg.indexOf('  ') === 0 ? '    ' : '') + '[' + new Date().toLocaleTimeString() + '] ' + msg.replace(/^ +/, '');
    state.log.push(line);
    if (state.log.length > 400) state.log.shift();
    if (refs.log) {
      refs.log.value = state.log.join('\n');
      refs.log.scrollTop = refs.log.scrollHeight;
    }
  }

  function refreshStatus() {
    if (!refs.status) return;
    var locs = uniq(state.scanned.map(function (t) { return t.loc; }));
    var where = locs.length ? '星球 ' + locs.join(' / ') : '未扫描，不知道星球';
    var tile = prodTile();
    if (!tile) { refs.status.textContent = where + ' · 未找到生产列表瓦片'; return; }
    refs.status.textContent = where + ' · ' + text(one(tile, 'TileFrame__cmd')) + ' · ' +
      listLines(tile).map(function (l) {
        return l.name + '（进行' + l.active + '/队列' + l.queued + '）';
      }).join('，');
  }

  function lineNames() {
    var tile = prodTile();
    if (!tile) return [];
    return listLines(tile).map(function (l) { return l.name; });
  }

  function buildPanel() {
    var style = el('style');
    style.textContent = [
      '#prun-panel{position:fixed;right:16px;top:64px;width:470px;max-height:82vh;display:flex;flex-direction:column;',
      'z-index:2147483000;background:#12161d;color:#d6dde8;border:1px solid #2f3a49;border-radius:8px;',
      'font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
      '#prun-panel header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2f3a49;cursor:move}',
      '#prun-panel header b{font-size:13px}',
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
      '#prun-panel details{border-bottom:1px solid #1d2531;padding:3px 0}',
      '#prun-panel summary{cursor:pointer;color:#8fb2e6;font-weight:600;padding:2px 0}',
      '#prun-panel details>.qitem{border-bottom:0;padding-left:12px}',
      '#prun-panel input,#prun-panel select,#prun-panel textarea{background:#1b222c;color:#d6dde8;border:1px solid #2f3a49;border-radius:4px;padding:2px 4px;font:inherit}',
      '#prun-panel textarea{width:100%;box-sizing:border-box;height:150px;font-family:ui-monospace,Consolas,monospace;font-size:11px;resize:vertical}',
      '#prun-panel button.act{background:#2d6cdf;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}',
      '#prun-panel button.warn{background:#b8860b;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}',
      '#prun-panel .dim{color:#7d8899}',
      '#prun-open{position:fixed;right:16px;top:16px;z-index:2147483000;background:#2d6cdf;color:#fff;border:0;border-radius:4px;padding:5px 10px;cursor:pointer;font:12px system-ui}',
      '.prun-hide{display:none!important}'
    ].join('\n');
    document.head.appendChild(style);

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
      state.scanned.forEach(function (t) { if (!seen[t.line]) seen[t.line] = t.loc || ''; });
      Object.keys(seen).sort().forEach(function (n) {
        var o = el('option', null, n + (seen[n] ? ' @ ' + seen[n] : ''));
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
        var sum = el('summary', null, k + (rows[0].loc ? ' @ ' + rows[0].loc : '') + '（' + rows.length + ' 个）');
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
      (t.loc ? ' · ' + t.loc : '') + (t.api ? ' · ' + t.api.building_ticker : ' · API 无此配方')));
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

    root.appendChild(el('div', 'dim', '↓ 队列：执行时按从上到下轮转，一轮里每条勾选的各下一单'));
    refs.queueList = el('div');
    root.appendChild(refs.queueList);
    scan.onclick = function () {
      scan.disabled = true;
      scanLineTemplates().then(function (found) {
        renderTemplates();
        log('扫描完成：' + found.length + ' 个模板');
        renderRecipes();
      }).catch(function (e) {
        log('扫描失败：' + e.message);
      }).then(function () { scan.disabled = false; });
    };
    var bar = el('div', 'row');
    var exp = el('button', 'act', '导出JSON');
    exp.onclick = function () {
      if (!state.queue.length) { log('队列是空的，没什么可导出'); return; }
      var name = exportName();
      try {
        var url = URL.createObjectURL(new Blob([JSON.stringify(state.queue, null, 2)], { type: 'application/json' }));
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
        renderQueue();
        log('从 ' + f.name + ' 导入 ' + list.length + ' 条');
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
    state.queue.forEach(function (e, idx) {
      var item = el('div', 'qitem');

      var top = el('div', 'qtop');
      var on = el('input');
      on.type = 'checkbox';
      on.checked = !!e.on;
      on.title = '参与执行';
      on.onchange = function () { e.on = on.checked; saveQueue(); sync(); };
      top.appendChild(on);
      var txt = el('div', 'txt');
      txt.appendChild(el('b', null, e.building + ' ' + e.label));
      txt.appendChild(el('div', 'dim', e.sig + ' · ' + fmtMs(e.time_ms)));
      top.appendChild(txt);
      item.appendChild(top);

      var bar = el('div', 'qbar');
      bar.appendChild(el('span', 'dim', '生产线'));

      var sel = el('select');
      var opts = ['自动'].concat(names);
      // 生产列表瓦片没打开时 lineNames() 为空，不能因此把用户选定的生产线抹掉
      if (opts.indexOf(e.line) < 0 && e.line && e.line !== '自动') opts.push(e.line);
      opts.forEach(function (n) {
        var o = el('option', null, n);
        o.value = n;
        sel.appendChild(o);
      });
      sel.value = e.line;
      if (sel.value !== e.line) { sel.value = '自动'; e.line = '自动'; }
      sel.onchange = function () { e.line = sel.value; saveQueue(); sync(); };
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

      bar.appendChild(el('span', 'dim', '上限'));
      var max = el('input');
      max.type = 'number';
      max.min = '1';
      max.max = '50';
      max.value = e.repeatMax || 20;
      max.style.width = '42px';
      max.title = '重复模式下的最大下单次数';
      max.onchange = function () {
        e.repeatMax = Math.max(1, Math.min(50, Number(max.value) || 20));
        max.value = e.repeatMax;
        saveQueue();
        sync();
      };
      bar.appendChild(max);

      var rep = el('label', 'dim');
      rep.title = '勾选后执行时按队列顺序轮转下单：一轮里每条勾选的各下一单，直到该线队列满、库存不足或达到上限';
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
      up.onclick = function () {
        if (idx === 0) return;
        state.queue.splice(idx - 1, 0, state.queue.splice(idx, 1)[0]);
        saveQueue(); renderQueue();
      };
      bar.appendChild(up);
      var dn = el('button', null, '↓');
      dn.onclick = function () {
        if (idx >= state.queue.length - 1) return;
        state.queue.splice(idx + 1, 0, state.queue.splice(idx, 1)[0]);
        saveQueue(); renderQueue();
      };
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
    });
    syncTotals();
    refs.queueList.appendChild(total);
  }

  function buildExecPane(root) {
    root.innerHTML = '';
    var r1 = el('div', 'row');
    refs.dryRun = el('input');
    refs.dryRun.type = 'checkbox';
    refs.dryRun.checked = true;
    refs.dryRun.onchange = function () {
      if (!refs.dryRun.checked) {
        var ok = window.confirm('关闭干跑会真实提交生产订单。\n确认要执行真实下单吗？');
        if (!ok) refs.dryRun.checked = true;
      }
    };
    var dl = el('label', null, '干跑（不提交，只验证能否下单）');
    dl.insertBefore(refs.dryRun, dl.firstChild);
    r1.appendChild(dl);
    root.appendChild(r1);

    var r2 = el('div', 'row');
    var run = el('button', 'act', '执行队列');
    run.onclick = function () {
      if (refs.dryRun.checked) {
        runQueue(true);
      } else {
        if (!window.confirm('最后一次确认：将向 APEX 真实提交最多 ' +
          state.queue.filter(function (e) { return e.on; }).reduce(function (s, e) { return s + orderCount(e); }, 0) +
          ' 张生产订单（' + state.queue.filter(function (e) { return e.on; }).length + ' 条配方按队列顺序轮转）。')) return;
        runQueue(false);
      }
    };
    r2.appendChild(run);
    var stat = el('button', null, '读取当前队列');
    stat.onclick = function () {
      var tile = prodTile();
      if (!tile) { log('找不到生产列表瓦片'); return; }
      listLines(tile).forEach(function (l) {
        log(l.name + '：进行 ' + l.active + '，队列 ' + l.queued);
        l.orders.slice(0, 5).forEach(function (o) {
          log('  ' + (o.queued ? '[队列]' : '[进行]') + ' ' + o.ticker + ' ' + o.name + ' ' + o.qty + ' ' + o.eta + ' ' + o.status);
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
    var b = el('button', null, '生产队列');
    b.id = 'prun-open';
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
})();
