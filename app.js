/*
 * app.js —— 页面交互
 * 负责：画布绘制/色线统计（原排版台能力）、方案信息维护、
 *       送审/审核/确认弹窗、授权交付单列表与筛选。
 * 画布快照调用 CanvasSnap，授权判定调用 Authorization。
 */
(function () {
  "use strict";

  var DRAFT_KEY = "zfl31Pattern";
  var META_KEY = "zfl31Meta";

  var colors = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];

  /* ---------- DOM ---------- */
  var grid = document.querySelector("#grid");
  var palette = document.querySelector("#palette");
  var statsEl = document.querySelector("#stats");
  var preview = document.querySelector("#preview");
  var riskEl = document.querySelector("#risk");
  var modalMask = document.querySelector("#modalMask");
  var modalBox = document.querySelector("#modalBox");
  var toastEl = document.querySelector("#toast");
  var metaEls = {
    projectNo: document.querySelector("#projectNo"),
    versionNo: document.querySelector("#versionNo"),
    customer: document.querySelector("#customer"),
    maker: document.querySelector("#maker")
  };

  /* ---------- 画布状态 ---------- */
  var cols = 18, rows = 14, active = 1, block = "dot", dragging = false;
  var cells = [];
  var undoStack = [], redoStack = [];

  var esc = window.Authorization.esc;

  /* ---------- 初始化 ---------- */
  function init() {
    var saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (saved) {
      cols = saved.cols; rows = saved.rows; cells = saved.cells;
    } else {
      cols = Number(document.querySelector("#cols").value);
      rows = Number(document.querySelector("#rows").value);
      cells = Array(cols * rows).fill(0);
    }
    var meta = JSON.parse(localStorage.getItem(META_KEY) || "null");
    if (meta) Object.keys(metaEls).forEach(function (k) { metaEls[k].value = meta[k] || ""; });
    document.querySelector("#cols").value = cols;
    document.querySelector("#rows").value = rows;
    renderCanvas();
    refreshCustomerList();
    renderDeliveries();
  }

  /* ---------- 方案信息 ---------- */
  function readMeta() {
    return {
      projectNo: metaEls.projectNo.value.trim(),
      versionNo: metaEls.versionNo.value.trim(),
      customer: metaEls.customer.value.trim(),
      maker: metaEls.maker.value.trim()
    };
  }
  function saveMeta() {
    localStorage.setItem(META_KEY, JSON.stringify(readMeta()));
  }
  function refreshCustomerList() {
    document.querySelector("#customerList").innerHTML =
      window.Authorization.listCustomers().map(function (c) {
        return '<option value="' + esc(c) + '">';
      }).join("");
  }
  function refreshFilterCustomers() {
    var sel = document.querySelector("#filterCustomer");
    var keep = sel.value;
    sel.innerHTML = '<option value="">全部客户</option>' +
      window.Authorization.listCustomers().map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
      }).join("");
    sel.value = keep;
  }

  /* ---------- 画布渲染 ---------- */
  function renderCanvas() {
    palette.innerHTML = colors.map(function (c, i) {
      return '<button class="swatch ' + (i === active ? "active" : "") +
        '" data-color="' + i + '" style="background:' + c + '"></button>';
    }).join("");
    palette.querySelectorAll("[data-color]").forEach(function (el) {
      el.onclick = function () { active = Number(el.dataset.color); renderCanvas(); };
    });
    grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    grid.innerHTML = cells.map(function (v, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' + colors[v] + '"></div>';
    }).join("");
    grid.querySelectorAll(".cell").forEach(function (el) {
      el.onpointerdown = function () { dragging = true; paint(Number(el.dataset.i)); };
      el.onpointerenter = function () { if (dragging) paint(Number(el.dataset.i)); };
    });
    window.onpointerup = function () { dragging = false; };
    renderStats();
  }

  function pushUndo() {
    undoStack.push(cells.slice());
    redoStack = [];
    if (undoStack.length > 50) undoStack.shift();
  }

  // 画布/色线改动：记录撤销、保存草稿、自动失效同版本旧交付单
  function touch(reason) {
    saveDraft();
    var meta = readMeta();
    var stale = window.Authorization.invalidateStale(meta.projectNo, meta.versionNo, currentState(), reason);
    if (stale.length) {
      toast("画布已改动，原交付单「" + stale.map(function (r) { return r.deliveryNo || r.id; }).join("、") +
        "」自动失效并留存历史，须用新快照重新送审");
      renderDeliveries();
    }
  }

  function currentState() {
    return { cols: cols, rows: rows, cells: cells, colors: colors };
  }

  function paint(i) {
    pushUndo();
    patternTargets(i).forEach(function (t) {
      if (t >= 0 && t < cells.length) cells[t] = active;
    });
    renderCanvas();
    touch("填色操作改动了色线");
  }

  function patternTargets(i) {
    var x = i % cols, y = Math.floor(i / cols);
    if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter(notNull);
    if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter(notNull);
    return [i];
  }
  function notNull(v) { return v !== null; }
  function idx(x, y) {
    return x < 0 || x >= cols || y < 0 || y >= rows ? null : y * cols + x;
  }

  function renderStats() {
    var counts = colors.map(function (_, i) {
      return cells.filter(function (v) { return v === i; }).length;
    });
    statsEl.innerHTML = counts.map(function (n, i) {
      return '<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' +
        colors[i] + '"></span> 色线' + i + '</span><b>' + n + "</b></div>";
    }).join("");
    preview.innerHTML = Array.from({ length: 36 }, function (_, i) {
      var ci = cells[(i % 6) + Math.floor(i / 6) * cols] || colors[0];
      return '<div class="mini" style="background:' + colors[ci] + '"></div>';
    }).join("");
    var riskRows = [];
    for (var y = 0; y < rows; y++) {
      var switches = 0;
      for (var x = 1; x < cols; x++) {
        if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
      }
      if (switches > cols * 0.62) riskRows.push(y + 1);
    }
    riskEl.innerHTML = riskRows.length
      ? '<p class="warning">第' + riskRows.join("、") + "行换色过密，可能断线。</p>"
      : "<p>暂无明显断线风险。</p>";
  }

  /* ---------- 草稿 / 导出 ---------- */
  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ cols: cols, rows: rows, cells: cells }));
  }

  document.querySelector("#saveBtn").onclick = function () {
    saveDraft(); saveMeta();
    toast("方案已保存");
  };

  document.querySelector("#exportBtn").onclick = function () {
    var meta = readMeta();
    var data = {
      meta: meta,
      cols: cols, rows: rows, cells: cells,
      usage: colors.map(function (color, i) {
        return { color: color, count: cells.filter(function (v) { return v === i; }).length };
      })
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "brocade-pattern-" + (meta.versionNo || "draft") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ---------- 画布控制 ---------- */
  document.querySelectorAll("[data-block]").forEach(function (btn) {
    btn.onclick = function () { block = btn.dataset.block; };
  });

  document.querySelector("#newBtn").onclick = function () {
    undoStack = []; redoStack = [];
    cols = Number(document.querySelector("#cols").value);
    rows = Number(document.querySelector("#rows").value);
    cells = Array(cols * rows).fill(0);
    renderCanvas();
    touch("新建网格，网格尺寸发生改动");
  };

  document.querySelector("#undoBtn").onclick = function () {
    if (!undoStack.length) return;
    redoStack.push(cells.slice());
    cells = undoStack.pop();
    renderCanvas();
    touch("撤销改动了色线");
  };
  document.querySelector("#redoBtn").onclick = function () {
    if (!redoStack.length) return;
    undoStack.push(cells.slice());
    cells = redoStack.pop();
    renderCanvas();
    touch("重做改动了色线");
  };

  Object.keys(metaEls).forEach(function (k) {
    metaEls[k].addEventListener("change", saveMeta);
  });

  /* ---------- 送审 ---------- */
  document.querySelector("#submitBtn").onclick = function () {
    saveMeta();
    var snap;
    try {
      snap = window.CanvasSnap.capture(currentState());
    } catch (e) {
      toast(e.message);
      return;
    }
    var result = window.Authorization.createSubmission(Object.assign(readMeta(), { snapshot: snap }));
    if (!result.ok) {
      toast(result.errors.join("；"));
      return;
    }
    refreshCustomerList();
    refreshFilterCustomers();
    renderDeliveries();
    toast("已冻结快照并送审，送审单 " + result.record.id);
  };

  /* ---------- 交付单列表 ---------- */
  document.querySelector("#filterCustomer").onchange = renderDeliveries;
  document.querySelector("#filterStatus").onchange = renderDeliveries;

  function renderDeliveries() {
    refreshFilterCustomers();
    var list = window.Authorization.query({
      customer: document.querySelector("#filterCustomer").value,
      status: document.querySelector("#filterStatus").value
    });
    var host = document.querySelector("#deliveryList");
    if (!list.length) {
      host.innerHTML = '<p class="muted">没有符合筛选条件的交付单。填写项目编号/版本号后，点击「冻结快照并送审」开始。</p>';
      return;
    }
    host.innerHTML = list.map(cardHtml).join("");
  }

  function cardHtml(r) {
    var st = r.effectiveStatus;
    var body = [
      kv("项目 / 版本", esc(r.projectNo) + " / " + esc(r.versionNo)),
      kv("客户", esc(r.customer)),
      kv("制版人 / 审核人", esc(r.maker) + " / " + (r.reviewer ? esc(r.reviewer) : "—")),
      kv("快照", r.snapshot.cols + "×" + r.snapshot.rows + " · " + fmt(r.submittedAt)),
      '<div class="snapwrap"><div>' + snapGridHtml(r.snapshot, "small") + "</div></div>"
    ];
    if (r.scope) {
      body.push(kv("适用范围", r.scope.map(function (s) {
        return '<span class="scope">' + esc(s) + "</span>";
      }).join("")));
      body.push(kv("授权期限", esc(r.startDate) + " 至 " + esc(r.endDate)));
      var remain = remainingHtml(r);
      if (remain) body.push(kv("剩余期限", remain));
      if (r.deliveryNo) body.push(kv("交付单号", esc(r.deliveryNo)));
    }
    if (r.rejectReason) body.push(kv("驳回原因", esc(r.rejectReason)));
    if (r.status === "invalid") body.push(kv("失效原因", esc(r.invalidateReason || "画布改动")));

    var actions = [];
    if (st === "pending") actions.push(actBtn("review", r.id, "", "审核"));
    if (st === "delivered") actions.push(actBtn("confirm", r.id, "", "客户确认"));
    if (st === "rejected" || st === "invalid") actions.push(actBtn("resubmit", r.id, "", "用新快照重新送审"));
    actions.push(actBtn("detail", r.id, "secondary", "详情"));

    return '<div class="card' + (st === "invalid" ? " is-dead" : "") + '">' +
      '<div class="card-head"><b>' + esc(r.projectNo) + " · " + esc(r.versionNo) +
      '</b><span class="badge ' + st + '">' + window.Authorization.statusLabel(st) + "</span></div>" +
      body.join("") +
      '<div class="card-actions">' + actions.join("") + "</div></div>";
  }

  function actBtn(act, id, cls, text) {
    return '<button data-act="' + act + '" data-id="' + id + '"' +
      (cls ? ' class="' + cls + '"' : "") + ">" + text + "</button>";
  }

  function kv(k, v) {
    return '<div class="kv"><span>' + k + '</span><b>' + v + "</b></div>";
  }

  function remainingHtml(r) {
    if (r.remainingDays === null || r.remainingDays === undefined) return "";
    if (r.remainingDays < 0) return '<span class="warning">已到期</span>';
    if (r.remainingDays === 0) return '<span class="warning">今日到期</span>';
    return r.remainingDays + " 天";
  }

  function snapGridHtml(snap, cls) {
    var size = cls === "small" ? 5 : 8;
    return '<div class="snapgrid ' + (cls || "") +
      '" style="--cs:' + size + "px;grid-template-columns:repeat(" + snap.cols + ", var(--cs))\">" +
      snap.cells.map(function (v) {
        return '<i style="background:' + snap.colors[v] + '"></i>';
      }).join("") + "</div>";
  }

  function fmt(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------- 列表操作（事件代理） ---------- */
  document.querySelector("#deliveryList").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-act]");
    if (!b) return;
    var id = b.dataset.id;
    if (b.dataset.act === "review") openReview(id);
    if (b.dataset.act === "detail") openDetail(id);
    if (b.dataset.act === "confirm") doConfirm(id);
    if (b.dataset.act === "resubmit") prefillResubmit(id);
  });

  function prefillResubmit(id) {
    var r = getRecord(id);
    if (!r) return;
    metaEls.projectNo.value = r.projectNo;
    metaEls.versionNo.value = r.versionNo;
    metaEls.customer.value = r.customer;
    metaEls.maker.value = r.maker;
    saveMeta();
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("已带回该版项目信息，请在新画布/色线上确认后点击「冻结快照并送审」");
  }

  function doConfirm(id) {
    // 确认前再次校验：当前画布若已偏离快照，旧单先失效
    var result = window.Authorization.customerConfirm(id);
    if (!result.ok) { toast(result.errors.join("；")); renderDeliveries(); return; }
    toast("客户已确认，授权自 " + result.record.startDate + " 起生效");
    renderDeliveries();
  }

  /* ---------- 审核弹窗 ---------- */
  function openReview(id) {
    var r = getRecord(id);
    if (!r) return;
    var today = window.Authorization.todayStr();
    var weekLater = offsetDate(today, 364);
    openModal(
      '<h3>审核送审单 · ' + esc(r.projectNo) + " / " + esc(r.versionNo) + "</h3>" +
      kv("制版人", esc(r.maker)) +
      kv("客户", esc(r.customer)) +
      kv("送审时间", fmt(r.submittedAt)) +
      '<label>审核人（不可与制版人相同）</label>' +
      '<input id="rvReviewer" placeholder="审核人姓名">' +
      '<label>适用范围（通过后写入交付单）</label>' +
      '<div class="scope-pick" id="rvScope">' +
      window.Authorization.SCOPES.map(function (s, i) {
        return '<label><input type="checkbox" value="' + esc(s) + '"' + (i < 2 ? " checked" : "") + ">" + esc(s) + "</label>";
      }).join("") + "</div>" +
      '<div class="daterow"><div><label>授权开始</label><input id="rvStart" type="date" value="' + today + '"></div>' +
      '<div><label>授权到期</label><input id="rvEnd" type="date" value="' + weekLater + '"></div></div>' +
      '<label>驳回原因（仅驳回时填写）</label>' +
      '<input id="rvReason" placeholder="驳回原因">' +
      '<div class="snapwrap" style="justify-content:center">' + snapGridHtml(r.snapshot) + "</div>" +
      '<p class="muted">审核的是送审时冻结的快照，之后画布的改动不影响本单。</p>' +
      '<div class="modal-actions">' +
      '<button data-act="reject" data-id="' + id + '" class="secondary">驳回</button>' +
      '<button data-act="approve" data-id="' + id + '">通过并生成交付单</button>' +
      '<button data-act="close" class="secondary">取消</button></div>'
    );
    modalBox.querySelectorAll("button[data-act]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.act === "close") { closeModal(); return; }
        var scope = Array.prototype.map.call(
          modalBox.querySelectorAll("#rvScope input:checked"),
          function (c) { return c.value; }
        );
        var form = {
          reviewer: modalBox.querySelector("#rvReviewer").value,
          scope: scope,
          startDate: modalBox.querySelector("#rvStart").value,
          endDate: modalBox.querySelector("#rvEnd").value,
          reason: modalBox.querySelector("#rvReason").value
        };
        var result = window.Authorization.review(id, b.dataset.act, form);
        if (!result.ok) { toast(result.errors.join("；")); return; }
        closeModal();
        renderDeliveries();
        if (b.dataset.act === "approve") {
          toast("审核通过，已生成交付单 " + result.record.deliveryNo);
        } else {
          toast("已驳回，制版人可用新快照重新送审");
        }
      };
    });
  }

  /* ---------- 详情弹窗 ---------- */
  function openDetail(id) {
    var r = getRecord(id);
    if (!r) return;
    var st = window.Authorization.deriveStatus(r);
    var rows2 = [
      kv("状态", window.Authorization.statusLabel(st)),
      kv("项目 / 版本", esc(r.projectNo) + " / " + esc(r.versionNo)),
      kv("客户", esc(r.customer)),
      kv("制版人", esc(r.maker)),
      kv("审核人", r.reviewer ? esc(r.reviewer) : "—"),
      kv("送审时间", fmt(r.submittedAt)),
      kv("审核时间", fmt(r.reviewedAt))
    ];
    if (r.deliveryNo) rows2.push(kv("交付单号", esc(r.deliveryNo)));
    if (r.scope) {
      rows2.push(kv("适用范围", r.scope.map(function (s) {
        return '<span class="scope">' + esc(s) + "</span>";
      }).join("")));
      rows2.push(kv("授权期限", esc(r.startDate) + " 至 " + esc(r.endDate)));
      rows2.push(kv("剩余期限", remainingHtml({ remainingDays: window.Authorization.daysRemaining(r) }) || "—"));
      rows2.push(kv("签发时间", fmt(r.issuedAt)));
      rows2.push(kv("客户确认", r.confirmedAt ? fmt(r.confirmedAt) : "未确认"));
    }
    if (r.rejectReason) rows2.push(kv("驳回原因", esc(r.rejectReason)));
    if (r.status === "invalid") rows2.push(kv("失效时间", fmt(r.invalidatedAt)), kv("失效原因", esc(r.invalidateReason)));

    var usage = r.snapshot.usage || [];
    openModal(
      '<h3>交付单详情 · ' + esc(r.projectNo) + " / " + esc(r.versionNo) + "</h3>" +
      rows2.join("") +
      '<h3 style="font-size:15px;margin-top:14px">冻结快照用色用量</h3>' +
      usage.filter(function (u) { return u.count > 0; }).map(function (u) {
        return '<div class="usage-row"><i style="background:' + u.color + '"></i>色线' + u.index +
          " <b>" + u.count + "</b> 格</div>";
      }).join("") +
      '<div class="snapwrap" style="justify-content:center">' + snapGridHtml(r.snapshot) + "</div>" +
      '<div class="modal-actions"><button data-act="close" class="secondary">关闭</button></div>'
    );
    modalBox.querySelector('[data-act="close"]').onclick = closeModal;
  }

  function getRecord(id) {
    var r = window.Authorization.query({}).find(function (x) { return x.id === id; });
    if (!r) { toast("单据不存在"); renderDeliveries(); }
    return r;
  }

  /* ---------- 弹窗 / 提示 ---------- */
  function openModal(html) {
    modalBox.innerHTML = html;
    modalMask.hidden = false;
  }
  function closeModal() { modalMask.hidden = true; modalBox.innerHTML = ""; }
  modalMask.addEventListener("click", function (e) { if (e.target === modalMask) closeModal(); });

  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }

  function offsetDate(str, days) {
    var d = new Date(str);
    d.setDate(d.getDate() + days);
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  init();
})();
