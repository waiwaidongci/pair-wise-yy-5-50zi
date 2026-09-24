/*
 * app.js —— 页面交互业务
 * 串联画布操作、快照冻结（snapshot.js）与授权流转（authorization.js）：
 * 画布或色线的每一次改动都会同步登记到授权模块，由其判定在途交付单是否失效。
 */
(function () {
  "use strict";

  var Auth = window.ZhijinAuth;
  var Snap = window.ZhijinSnapshot;

  var DEFAULT_COLORS = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };
  var grid = $("grid"), palette = $("palette"), stats = $("stats"), risk = $("risk");
  var flow = $("flow"), ledgerBody = $("ledgerBody"), canvasBanner = $("canvasBanner");

  // ---- 工作状态 ----
  var colors = DEFAULT_COLORS.slice();
  var cols = 18, rows = 14, active = 1, block = "dot", dragging = false;
  var cells = [];
  var undoStack = [], redoStack = [];
  var workKey = null;          // 当前载入的方案 key（null = 未保存的新画布）
  var workScheme = null;

  // ---- 工具 ----
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  var STATUS_TEXT = {
    unsent: "未送审",
    in_review: "送审中",
    rejected: "已驳回",
    approved: "待客户确认",
    expired: "已到期",
    confirmed: "客户已确认",
    invalidated: "已失效"
  };
  function badge(status) {
    return '<span class="badge ' + status + '">' + STATUS_TEXT[status] + "</span>";
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 3200);
  }

  function currentState() {
    return { cols: cols, rows: rows, cells: cells, colors: colors };
  }

  // ---- 画布渲染 ----
  function renderPalette() {
    palette.innerHTML = colors.map(function (c, i) {
      return '<button type="button" class="swatch ' + (i === active ? "active" : "") +
        '" data-color="' + i + '" style="background:' + c + '" title="色线' + i + '"><span class="tag">' + i + "</span></button>";
    }).join("");
    var rep = $("colorReplace");
    if (rep) rep.value = colors[active];
  }

  function renderGrid() {
    grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    grid.innerHTML = cells.map(function (v, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' + colors[v] + '"></div>';
    }).join("");
  }

  function renderStats() {
    var counts = colors.map(function (_, i) {
      return cells.filter(function (v) { return v === i; }).length;
    });
    stats.innerHTML = counts.map(function (n, i) {
      return '<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' +
        colors[i] + '"></span> 色线' + i + "</span><b>" + n + "</b></div>";
    }).join("");

    var riskRows = [];
    for (var y = 0; y < rows; y++) {
      var switches = 0;
      for (var x = 1; x < cols; x++) if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
      if (switches > cols * 0.62) riskRows.push(y + 1);
    }
    risk.innerHTML = riskRows.length
      ? '<p class="warning">第' + riskRows.join("、") + "行换色过密，可能断线。</p>"
      : "<p>暂无明显断线风险。</p>";
  }

  function renderCanvas() {
    renderPalette();
    renderGrid();
    renderStats();
    renderBanner();
  }

  function renderBanner() {
    if (!workKey) {
      canvasBanner.innerHTML = '<div class="banner info">当前是未保存的新画布，填好左侧「项目编号 / 版本号 / 客户 / 制版人」后保存为方案，才能送审。</div>';
      return;
    }
    if (workScheme.confirmed) {
      canvasBanner.innerHTML = '<div class="banner ok">版本 ' + esc(workScheme.version) +
        " 已由客户确认定稿。画布可继续修改，但须「基于定稿建新版本」后才能再次送审。</div>";
      return;
    }
    var cur = Auth.latest(workScheme);
    if (cur && cur.status === Auth.STATUS.IN_REVIEW) {
      canvasBanner.innerHTML = '<div class="banner warn">送审单 ' + esc(cur.id) +
        " 审核中。此刻改动画布或色线，该送审单将立即自动失效并留在历史里。</div>";
    } else if (cur && cur.status === Auth.STATUS.APPROVED) {
      var d = Auth.daysLeft(cur);
      canvasBanner.innerHTML = '<div class="banner warn">交付单 ' + esc(cur.deliveryNo) +
        " 已通过、待客户确认。客户确认前改动将使其自动失效，只能拿新快照重新送审。" +
        (d < 0 ? "授权已到期。" : "剩余 " + d + " 天。") + "</div>";
    } else {
      canvasBanner.innerHTML = '<div class="banner info">方案 ' + esc(workScheme.projectNo) + " / " +
        esc(workScheme.version) + " 编辑中，可随时冻结快照送审。</div>";
    }
  }

  // ---- 画布编辑：每次改动登记到授权模块 ----
  function pushUndo() {
    undoStack.push(cells.slice());
    redoStack = [];
    if (undoStack.length > 50) undoStack.shift();
  }

  function syncCanvas(reason) {
    if (!workKey) { renderBanner(); return; }
    var n = Auth.updateCanvas(workKey, currentState());
    workScheme = Auth.find(workKey);
    if (n > 0) {
      toast("画布/色线已变更，" + n + " 份在途交付单自动失效并留档，需用新快照重新送审");
    } else if (reason) {
      // 静默编辑，不打扰
    }
    renderBanner();
    renderFlow();
    renderLedger();
  }

  function paint(i) {
    pushUndo();
    patternTargets(i).forEach(function (t) {
      if (t >= 0 && t < cells.length) cells[t] = active;
    });
    renderCanvas();
    syncCanvas();
  }

  function idx(x, y) {
    return x < 0 || x >= cols || y < 0 || y >= rows ? null : y * cols + x;
  }

  function patternTargets(i) {
    var x = i % cols, y = Math.floor(i / cols);
    if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter(function (v) { return v !== null; });
    if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter(function (v) { return v !== null; });
    return [i];
  }

  function resetCanvas(c, r, savedCells, savedColors, savedKey, savedScheme) {
    cols = c; rows = r;
    cells = savedCells ? savedCells.slice() : Array(c * r).fill(0);
    colors = (savedColors && savedColors.length === DEFAULT_COLORS.length) ? savedColors.slice() : DEFAULT_COLORS.slice();
    active = Math.min(active, colors.length - 1);
    undoStack = []; redoStack = [];
    workKey = savedKey || null;
    workScheme = savedScheme || null;
    $("cols").value = cols; $("rows").value = rows;
    renderCanvas();
    renderFlow();
  }

  // ---- 方案信息表单 ----
  function setMetaReadonly(locked) {
    ["projectNo", "version", "customer", "maker"].forEach(function (id) {
      $(id).readOnly = locked;
    });
    $("createSchemeBtn").classList.toggle("hidden", locked);
    $("newVersionBtn").classList.toggle("hidden", !(locked && workScheme && workScheme.confirmed));
    $("newCanvasBtn").classList.toggle("hidden", !locked);
  }

  function fillMeta(scheme) {
    $("projectNo").value = scheme.projectNo;
    $("version").value = scheme.version;
    $("customer").value = scheme.customer;
    $("maker").value = scheme.maker;
    setMetaReadonly(true);
  }

  function clearMetaForNewCanvas(keepProject) {
    workKey = null; workScheme = null;
    if (!keepProject) $("projectNo").value = "";
    $("version").value = "";
    $("customer").value = "";
    $("maker").value = "";
    setMetaReadonly(false);
    renderFlow();
    renderBanner();
  }

  // ---- 送审 / 审核 / 确认 流转面板 ----
  function renderFlow() {
    if (!workKey) {
      flow.innerHTML = '<p class="muted">先在左侧保存方案，再冻结快照送审。</p>';
      return;
    }
    var scheme = Auth.find(workKey);
    workScheme = scheme;
    var cur = Auth.latest(scheme);
    var html = '<div class="card"><b>' + esc(scheme.projectNo) + " / " + esc(scheme.version) + "</b><br>" +
      '<span class="muted">客户：' + esc(scheme.customer) + " · 制版人：" + esc(scheme.maker) + "</span></div>";

    html += cur ? submissionCard(cur, scheme) : unsentCard(scheme);
    html += historyList(scheme, cur);
    flow.innerHTML = html;
    bindFlowEvents();
  }

  function unsentCard(scheme) {
    var btn = scheme.confirmed
      ? '<button id="submitBtn" disabled>已定稿，请新建版本</button>'
      : '<button id="submitBtn">冻结当前网格与色线并送审</button>';
    return '<div class="card"><h3 style="margin-top:0">尚未送审</h3>' +
      '<p class="muted">送审将冻结此刻画布快照（' + cols + "×" + rows + "，" + colors.length +
      ' 种色线），之后改动画布不会影响已送审内容。</p>' + btn + "</div>";
  }

  function submissionCard(sub, scheme) {
    var status = Auth.displayStatus(sub);
    var cls = (sub.status === Auth.STATUS.INVALIDATED || sub.status === Auth.STATUS.REJECTED) ? " card inactive" : "";
    var h = '<div class="card' + cls + '">';
    h += '<h3 style="margin-top:0">最新送审单 ' + esc(sub.id) + " " + badge(status) + "</h3>";
    h += snapLine(sub.snapshot);
    h += "<dl>" +
      "<dt>制版人</dt><dd>" + esc(sub.maker) + "</dd>" +
      "<dt>送审时间</dt><dd>" + fmtTime(sub.submittedAt) + "</dd>";
    if (sub.reviewer) h += "<dt>审核人</dt><dd>" + esc(sub.reviewer) + "</dd>";
    if (sub.status === Auth.STATUS.REJECTED) h += "<dt>驳回原因</dt><dd>" + esc(sub.rejectReason) + "</dd>";
    if (sub.deliveryNo) h += "<dt>交付单号</dt><dd>" + esc(sub.deliveryNo) + "</dd>";
    if (sub.scope) h += "<dt>适用范围</dt><dd>" + esc(sub.scope) + "</dd>";
    if (sub.startDate) h += "<dt>授权期限</dt><dd>" + esc(sub.startDate) + " 至 " + esc(sub.endDate) + "</dd>";
    if (sub.status === Auth.STATUS.APPROVED) {
      var d = Auth.daysLeft(sub);
      h += "<dt>剩余期限</dt><dd>" + (d < 0 ? "已到期" : d + " 天") + "</dd>";
    }
    if (sub.confirmedAt) h += "<dt>确认时间</dt><dd>" + fmtTime(sub.confirmedAt) + "</dd>";
    if (sub.invalidReason) h += "<dt>失效原因</dt><dd>" + esc(sub.invalidReason) + "</dd>";
    h += "</dl>";

    if (sub.status === Auth.STATUS.IN_REVIEW) h += reviewForm(sub);
    if (sub.status === Auth.STATUS.APPROVED) h += approvedActions(sub);
    if (sub.delivery) h += '<div class="actions"><button id="exportDeliveryBtn" class="secondary tiny">导出交付单JSON</button></div>';
    if (sub.status === Auth.STATUS.REJECTED || sub.status === Auth.STATUS.INVALIDATED) {
      h += '<div class="actions"><button id="resubmitBtn">用当前画布重新送审</button></div>';
    }
    h += "</div>";
    return h;
  }

  function reviewForm(sub) {
    var start = Auth.todayISO();
    var end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    var endStr = end.getFullYear() + "-" + String(end.getMonth() + 1).padStart(2, "0") + "-" + String(end.getDate()).padStart(2, "0");
    return '<h3>审核</h3>' +
      '<p class="muted">审核人不能与制版人（' + esc(sub.maker) + "）相同。</p>" +
      '<label>审核人</label><input id="reviewer" placeholder="审核人姓名">' +
      '<label>适用范围</label><input id="scope" placeholder="如：仅限本款披肩量产，不含衍生周边">' +
      '<div class="row2"><div><label>授权起始</label><input id="startDate" type="date" value="' + start + '"></div>' +
      '<div><label>授权到期</label><input id="endDate" type="date" value="' + endStr + '"></div></div>' +
      '<label>驳回原因（仅驳回时填）</label><input id="rejectReason" placeholder="如：边缘色线密度需调整">' +
      '<div class="actions"><button id="approveBtn">审核通过并生成交付单</button>' +
      '<button id="rejectBtn" class="secondary">驳回</button></div>';
  }

  function approvedActions(sub) {
    var expired = Auth.isExpired(sub);
    return '<div class="actions">' +
      (expired
        ? '<button disabled>授权已到期，不可确认</button>'
        : '<button id="confirmBtn">客户确认定稿</button>') +
      "</div>";
  }

  function historyList(scheme, current) {
    var older = scheme.submissions.slice().sort(function (a, b) {
      return (b.submittedAt || "").localeCompare(a.submittedAt || "");
    }).filter(function (s) { return current && s.id !== current.id; });
    if (!older.length) return "";
    var h = "<h3>历史送审与交付单</h3>";
    older.forEach(function (sub) {
      var st = Auth.displayStatus(sub);
      h += '<div class="card inactive" style="padding:8px 10px">' +
        "<b>" + esc(sub.id) + "</b> " + badge(st) +
        '<div class="muted" style="margin-top:3px">' + fmtTime(sub.submittedAt) +
        (sub.deliveryNo ? " · 交付单 " + esc(sub.deliveryNo) : "") +
        (sub.scope ? " · 范围：" + esc(sub.scope) : "") +
        (sub.endDate ? " · 至 " + esc(sub.endDate) : "") +
        (sub.invalidReason ? " · " + esc(sub.invalidReason) : "") +
        (sub.rejectReason ? " · 驳回：" + esc(sub.rejectReason) : "") +
        "</div></div>";
    });
    return h;
  }

  function snapLine(snapshot) {
    if (!snapshot) return "";
    var maxW = 24, maxH = 16;
    var stepX = Math.max(1, Math.ceil(snapshot.cols / maxW));
    var stepY = Math.max(1, Math.ceil(snapshot.rows / maxH));
    var boxes = "";
    var w = Math.ceil(snapshot.cols / stepX);
    for (var y = 0; y < snapshot.rows; y += stepY) {
      for (var x = 0; x < snapshot.cols; x += stepX) {
        boxes += "<i style=\"background:" + snapshot.colors[snapshot.cells[y * snapshot.cols + x] || 0] + "\"></i>";
      }
    }
    return '<div class="snapline"><div class="snapshot" style="grid-template-columns:repeat(' + w + ',1fr)">' + boxes + "</div>" +
      '<div class="muted">冻结快照<br>' + snapshot.cols + "×" + snapshot.rows + " 格<br>指纹 " +
      esc(snapshot.fingerprint.slice(0, 10)) + "<br>" + fmtTime(snapshot.capturedAt) + "</div></div>";
  }

  function bindFlowEvents() {
    var submitBtn = $("submitBtn");
    if (submitBtn) submitBtn.onclick = doSubmit;
    var resubmitBtn = $("resubmitBtn");
    if (resubmitBtn) resubmitBtn.onclick = doSubmit;
    var approveBtn = $("approveBtn");
    if (approveBtn) approveBtn.onclick = doApprove;
    var rejectBtn = $("rejectBtn");
    if (rejectBtn) rejectBtn.onclick = doReject;
    var confirmBtn = $("confirmBtn");
    if (confirmBtn) confirmBtn.onclick = doConfirm;
    var exportDeliveryBtn = $("exportDeliveryBtn");
    if (exportDeliveryBtn) exportDeliveryBtn.onclick = doExportDelivery;
  }

  function doSubmit() {
    var snapshot = Snap.capture(currentState());
    // 送审前先确保画布登记内容与快照一致（无变更不会产生失效）
    Auth.updateCanvas(workKey, currentState());
    var res = Auth.submit(workKey, snapshot);
    if (!res.ok) { toast(res.error); return; }
    workScheme = Auth.find(workKey);
    toast("已冻结快照并送审，送审单 " + res.submission.id);
    renderFlow(); renderLedger(); renderBanner();
  }

  function reviewPayload() {
    return {
      reviewer: $("reviewer").value,
      scope: $("scope").value,
      startDate: $("startDate").value,
      endDate: $("endDate").value,
      rejectReason: $("rejectReason").value
    };
  }

  function doApprove() {
    var cur = Auth.latest(workScheme);
    var res = Auth.review(workKey, cur.id, "approve", reviewPayload());
    if (!res.ok) { toast(res.error); return; }
    workScheme = Auth.find(workKey);
    toast("审核通过，已生成交付单 " + res.submission.deliveryNo);
    renderFlow(); renderLedger(); renderBanner();
  }

  function doReject() {
    var cur = Auth.latest(workScheme);
    var res = Auth.review(workKey, cur.id, "reject", reviewPayload());
    if (!res.ok) { toast(res.error); return; }
    workScheme = Auth.find(workKey);
    toast("已驳回，制版人可修改后用新快照重新送审");
    renderFlow(); renderLedger(); renderBanner();
  }

  function doConfirm() {
    var cur = Auth.latest(workScheme);
    var res = Auth.confirmByCustomer(workKey, cur.id);
    if (!res.ok) { toast(res.error); return; }
    workScheme = Auth.find(workKey);
    toast("客户已确认，版本定稿");
    renderFlow(); renderLedger(); renderBanner();
  }

  function doExportDelivery() {
    var cur = Auth.latest(workScheme);
    if (!cur || !cur.delivery) return;
    var data = {
      delivery: cur.delivery,
      snapshot: {
        cols: cur.snapshot.cols, rows: cur.snapshot.rows,
        colors: cur.snapshot.colors, usage: cur.snapshot.usage,
        fingerprint: cur.snapshot.fingerprint
      },
      history: cur.history
    };
    downloadJSON(data, "delivery-" + cur.deliveryNo + ".json");
    toast("交付单已导出");
  }

  function downloadJSON(data, filename) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- 台账 ----
  function renderLedger() {
    var customer = $("filterCustomer").value;
    var statusF = $("filterStatus").value;
    var list = Auth.filterBy(customer, statusF);

    renderCustomerOptions();

    ledgerBody.innerHTML = list.map(function (s) {
      var cur = Auth.latest(s);
      var st = Auth.displayStatus(cur);
      var reviewer = cur && cur.reviewer ? esc(cur.reviewer) : "—";
      var no = cur && cur.deliveryNo ? esc(cur.deliveryNo) : "—";
      var scope = cur && cur.scope ? esc(cur.scope) : "—";
      var term = cur && cur.startDate ? esc(cur.startDate) + " 至 " + esc(cur.endDate) : "—";
      var remain = "—";
      if (cur && cur.status === Auth.STATUS.APPROVED) {
        var d = Auth.daysLeft(cur);
        remain = d < 0 ? "已到期" : d + " 天";
      } else if (cur && cur.status === Auth.STATUS.CONFIRMED) {
        remain = "已确认";
      }
      return '<tr class="live" data-key="' + esc(s.key) + '">' +
        "<td>" + esc(s.projectNo) + "</td>" +
        "<td>" + esc(s.version) + "</td>" +
        "<td>" + esc(s.customer) + "</td>" +
        "<td>" + esc(s.maker) + "</td>" +
        "<td>" + reviewer + "</td>" +
        "<td>" + badge(st) + "</td>" +
        "<td>" + no + "</td>" +
        "<td>" + scope + "</td>" +
        "<td>" + term + "</td>" +
        "<td>" + remain + "</td>" +
        '<td><button class="tiny secondary" data-load="' + esc(s.key) + '">载入</button></td>' +
        "</tr>";
    }).join("") || '<tr><td colspan="11" class="muted" style="text-align:center;padding:18px">没有符合筛选条件的方案</td></tr>';
  }

  function renderCustomerOptions() {
    var selected = $("filterCustomer").value;
    var known = Auth.customers();
    $("filterCustomer").innerHTML = '<option value="">全部客户</option>' +
      known.map(function (c) { return '<option value="' + esc(c) + '"' + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("");
    $("customerList").innerHTML = known.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
  }

  function loadScheme(key) {
    var scheme = Auth.find(key);
    if (!scheme) { toast("方案不存在"); return; }
    $("projectNo").value = scheme.projectNo;
    $("version").value = scheme.version;
    $("customer").value = scheme.customer;
    $("maker").value = scheme.maker;
    resetCanvas(scheme.cols, scheme.rows, scheme.cells, scheme.colors, scheme.key, scheme);
    setMetaReadonly(true);
    toast("已载入方案 " + scheme.projectNo + " / " + scheme.version);
  }

  // ---- 静态控件绑定 ----
  function bindStatic() {
    palette.onclick = function (e) {
      var btn = e.target.closest("[data-color]");
      if (!btn) return;
      active = Number(btn.dataset.color);
      renderPalette();
    };

    $("replaceColorBtn").onclick = function () {
      var val = $("colorReplace").value;
      if (colors[active].toLowerCase() === val.toLowerCase()) return;
      pushUndo();
      colors[active] = val;
      renderCanvas();
      syncCanvas();
      toast("色线" + active + " 已换色，在途交付单按规则失效");
    };

    grid.onpointerdown = function (e) {
      var el = e.target.closest(".cell");
      if (!el) return;
      dragging = true;
      paint(Number(el.dataset.i));
    };
    grid.onpointerover = function (e) {
      var el = e.target.closest(".cell");
      if (el && dragging) paint(Number(el.dataset.i));
    };
    window.addEventListener("pointerup", function () { dragging = false; });

    document.querySelectorAll("[data-block]").forEach(function (btn) {
      btn.onclick = function () {
        block = btn.dataset.block;
        document.querySelectorAll("[data-block]").forEach(function (b) { b.style.outline = ""; });
        btn.style.outline = "2px solid #8d3e37";
      };
    });

    $("newBtn").onclick = function () {
      var msg = cells.some(function (v) { return v !== 0; })
        ? "新建空网格将清空当前画布。"
        : "确定要新建一块空网格吗？";
      if (workKey) msg += "当前方案在途的送审单/交付单将随之自动失效并留档。";
      if (!confirm(msg + "（已确认定稿的交付单不受影响）继续？")) return;
      var c = Math.max(6, Math.min(36, Number($("cols").value) || 18));
      var r = Math.max(6, Math.min(32, Number($("rows").value) || 14));
      resetCanvas(c, r, null, colors.slice(), workKey, workScheme);
      syncCanvas();
    };

    $("undoBtn").onclick = function () {
      if (!undoStack.length) return;
      redoStack.push(cells.slice());
      cells = undoStack.pop();
      renderCanvas();
      syncCanvas();
    };
    $("redoBtn").onclick = function () {
      if (!redoStack.length) return;
      undoStack.push(cells.slice());
      cells = redoStack.pop();
      renderCanvas();
      syncCanvas();
    };

    $("createSchemeBtn").onclick = function () {
      var input = {
        projectNo: $("projectNo").value,
        version: $("version").value,
        customer: $("customer").value,
        maker: $("maker").value,
        cols: cols, rows: rows, cells: cells, colors: colors
      };
      var res = Auth.createScheme(input);
      if (!res.ok) { toast(res.error); return; }
      workKey = res.scheme.key;
      workScheme = res.scheme;
      setMetaReadonly(true);
      renderFlow(); renderLedger(); renderBanner();
      toast("方案已保存：" + res.scheme.projectNo + " / " + res.scheme.version);
    };

    $("newVersionBtn").onclick = function () {
      var nv = prompt("当前项目 " + workScheme.projectNo + " 的新版本号（如 v1.1）：", "v" + (Date.now() % 1000));
      if (nv === null) return;
      var res = Auth.createNextVersion(workScheme, nv, currentState());
      if (!res.ok) { toast(res.error); return; }
      workKey = res.scheme.key;
      workScheme = res.scheme;
      $("version").value = res.scheme.version;
      setMetaReadonly(true);
      renderFlow(); renderLedger(); renderBanner();
      toast("已基于定稿创建新版本 " + res.scheme.version + "，旧版本交付单保持有效");
    };

    $("newCanvasBtn").onclick = function () {
      if (!confirm("另开一块未保存的新画布？当前方案不会丢失，可随时从台账载入。")) return;
      clearMetaForNewCanvas(false);
      resetCanvas(18, 14, null, DEFAULT_COLORS.slice(), null, null);
    };

    $("exportPatternBtn").onclick = function () {
      var data = {
        projectNo: $("projectNo").value || null,
        version: $("version").value || null,
        cols: cols, rows: rows, cells: cells, colors: colors,
        usage: Snap.usage(cells, colors)
      };
      downloadJSON(data, "brocade-pattern-" + (data.projectNo || "draft") + "-" + (data.version || "") + ".json");
    };

    ledgerBody.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-load]");
      if (btn) { loadScheme(btn.dataset.load); return; }
      var tr = e.target.closest("tr[data-key]");
      if (tr) loadScheme(tr.dataset.key);
    });

    $("filterCustomer").onchange = renderLedger;
    $("filterStatus").onchange = renderLedger;
    $("clearFilterBtn").onclick = function () {
      $("filterCustomer").value = "";
      $("filterStatus").value = "all";
      renderLedger();
    };
  }

  // ---- 启动：优先恢复上次载入的方案，兼容旧排版台的单画布存档 ----
  function init() {
    bindStatic();
    var schemes = Auth.all();
    if (schemes.length) {
      loadScheme(schemes[0].key);
    } else {
      var legacy = null;
      try { legacy = JSON.parse(localStorage.getItem("zfl31Pattern") || "null"); } catch (e) { legacy = null; }
      if (legacy && legacy.cells) {
        resetCanvas(legacy.cols, legacy.rows, legacy.cells, DEFAULT_COLORS.slice(), null, null);
        toast("已从旧排版台恢复画布，请补全方案信息后保存送审");
      } else {
        resetCanvas(18, 14, null, DEFAULT_COLORS.slice(), null, null);
      }
      setMetaReadonly(false);
    }
    renderLedger();
    renderCustomerOptions();
  }

  init();
})();
