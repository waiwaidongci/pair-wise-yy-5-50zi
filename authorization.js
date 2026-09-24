/*
 * authorization.js —— 授权判定业务
 * 管理方案（按「项目编号 + 版本号」唯一）、送审/审核/客户确认流转、
 * 交付单生成、状态筛选与到期判定。
 *
 * 方案状态：editing（送审中/有效交付）、confirmed（客户已确认）
 * 送审状态：in_review（送审中）、rejected（已驳回）、approved（审核通过，待客户确认）、
 *           confirmed（客户已确认）、invalidated（因画布/色线被改动而自动失效，留在历史）
 */
(function (global) {
  "use strict";

  var KEY = "zhijin.deliveries.v1";
  var STATUS = {
    IN_REVIEW: "in_review",
    REJECTED: "rejected",
    APPROVED: "approved",
    CONFIRMED: "confirmed",
    INVALIDATED: "invalidated"
  };
  var ACTIVE_STATES = [STATUS.IN_REVIEW, STATUS.APPROVED];

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  // ---------- 存取 ----------
  function read() {
    try {
      var data = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  function all() {
    return read().sort(function (a, b) {
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });
  }

  function find(key) {
    return read().filter(function (s) { return s.key === key; })[0] || null;
  }

  function keyOf(projectNo, version) {
    return String(projectNo).trim() + "::" + String(version).trim();
  }

  function latest(scheme) {
    if (!scheme || !scheme.submissions.length) return null;
    return scheme.submissions.slice().sort(byTimeDesc)[0];
  }

  function byTimeDesc(a, b) {
    return (b.submittedAt || "").localeCompare(a.submittedAt || "");
  }

  // ---------- 方案 ----------
  // 返回 { ok:false,error } 或 { ok:true,scheme }
  function createScheme(input) {
    var projectNo = String(input.projectNo || "").trim();
    var version = String(input.version || "").trim();
    var customer = String(input.customer || "").trim();
    var maker = String(input.maker || "").trim();
    var error;
    if (!projectNo) error = "请填写项目编号";
    else if (!version) error = "请填写版本号";
    else if (!customer) error = "请填写客户名称";
    else if (!maker) error = "请填写制版人";
    else if (find(keyOf(projectNo, version))) error = "项目编号 " + projectNo + " 的版本 " + version + " 已存在";
    if (error) return { ok: false, error: error };

    var now = new Date().toISOString();
    var scheme = {
      key: keyOf(projectNo, version),
      projectNo: projectNo,
      version: version,
      customer: customer,
      maker: maker,
      cols: input.cols,
      rows: input.rows,
      cells: input.cells,
      colors: input.colors,
      confirmed: false,
      submissions: [],
      createdAt: now,
      updatedAt: now
    };
    var list = read();
    list.push(scheme);
    write(list);
    return { ok: true, scheme: scheme };
  }

  // 画布/色线有任何改动都经此入口：
  // 客户确认前（送审中 或 已通过待确认）的送审单自动失效，留在历史里。
  // 返回被失效的送审单数。
  function updateCanvas(key, state) {
    var list = read();
    var scheme = list.filter(function (s) { return s.key === key; })[0];
    if (!scheme) return 0;

    var invalidated = 0;
    scheme.submissions.forEach(function (sub) {
      if (ACTIVE_STATES.indexOf(sub.status) !== -1) {
        sub.status = STATUS.INVALIDATED;
        sub.invalidReason = "客户确认前画布或色线被改动，快照指纹 " +
          (sub.snapshot ? sub.snapshot.fingerprint.slice(0, 8) : "") + " 已过时";
        sub.invalidatedAt = new Date().toISOString();
        invalidated++;
      }
    });
    scheme.cols = state.cols;
    scheme.rows = state.rows;
    scheme.cells = state.cells.slice();
    scheme.colors = state.colors.slice();
    scheme.updatedAt = new Date().toISOString();
    write(list);
    return invalidated;
  }

  // 已确认版本定稿，后续改动走同一项目编号下的新版本
  function createNextVersion(source, newVersion, state) {
    var ver = String(newVersion || "").trim();
    if (!ver) return { ok: false, error: "请填写新版本号" };
    if (!source.confirmed) return { ok: false, error: "只有客户确认定稿的版本才能派生新版本" };
    var newKey = keyOf(source.projectNo, ver);
    if (find(newKey)) return { ok: false, error: "版本 " + ver + " 已存在" };

    var now = new Date().toISOString();
    var scheme = {
      key: newKey,
      projectNo: source.projectNo,
      version: ver,
      customer: source.customer,
      maker: source.maker,
      cols: state.cols,
      rows: state.rows,
      cells: state.cells.slice(),
      colors: state.colors.slice(),
      confirmed: false,
      submissions: [],
      createdAt: now,
      updatedAt: now
    };
    var list = read();
    list.push(scheme);
    write(list);
    return { ok: true, scheme: scheme };
  }

  // ---------- 送审（冻结快照）----------
  function submit(key, snapshot) {
    var list = read();
    var scheme = list.filter(function (s) { return s.key === key; })[0];
    if (!scheme) return { ok: false, error: "方案不存在" };
    if (scheme.confirmed) return { ok: false, error: "该版本客户已确认定稿，请新建版本再送审" };

    var cur = latest(scheme);
    if (cur && ACTIVE_STATES.indexOf(cur.status) !== -1) {
      return { ok: false, error: cur.status === STATUS.IN_REVIEW ? "已有送审单在审核中" : "已有通过待确认的交付单" };
    }

    var nowIso = new Date().toISOString();
    var sub = {
      id: "S" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
      status: STATUS.IN_REVIEW,
      maker: scheme.maker,
      snapshot: snapshot,
      submittedAt: nowIso,
      history: [{ status: STATUS.IN_REVIEW, at: nowIso, note: "制版人送审" }]
    };
    scheme.submissions.push(sub);
    scheme.updatedAt = nowIso;
    write(list);
    return { ok: true, submission: sub };
  }

  // ---------- 审核：审核人不能与制版人相同 ----------
  function review(key, submissionId, decision, input) {
    var reviewer = String(input.reviewer || "").trim();
    var list = read();
    var scheme = list.filter(function (s) { return s.key === key; })[0];
    if (!scheme) return { ok: false, error: "方案不存在" };

    var sub = scheme.submissions.filter(function (x) { return x.id === submissionId; })[0];
    if (!sub) return { ok: false, error: "送审单不存在" };
    if (sub.status !== STATUS.IN_REVIEW) return { ok: false, error: "该送审单不在待审核状态" };
    if (!reviewer) return { ok: false, error: "请填写审核人" };
    if (reviewer === sub.maker) return { ok: false, error: "审核人不能与制版人相同（制版人：" + sub.maker + "）" };

    var nowIso = new Date().toISOString();
    sub.reviewer = reviewer;
    sub.reviewedAt = nowIso;

    if (decision === "reject") {
      var reason = String(input.rejectReason || "").trim();
      if (!reason) return { ok: false, error: "驳回必须填写原因" };
      sub.status = STATUS.REJECTED;
      sub.rejectReason = reason;
      sub.history.push({ status: STATUS.REJECTED, at: nowIso, by: reviewer, note: reason });
    } else {
      var scope = String(input.scope || "").trim();
      var startDate = String(input.startDate || "").trim();
      var endDate = String(input.endDate || "").trim();
      var dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!scope) return { ok: false, error: "请填写适用范围" };
      if (!dateRe.test(startDate) || !dateRe.test(endDate)) return { ok: false, error: "请选择授权起止日期" };
      if (endDate <= startDate) return { ok: false, error: "授权到期日必须晚于起始日" };

      sub.status = STATUS.APPROVED;
      sub.scope = scope;
      sub.startDate = startDate;
      sub.endDate = endDate;
      sub.deliveryNo = deliveryNo(startDate);
      sub.delivery = {
        deliveryNo: sub.deliveryNo,
        projectNo: scheme.projectNo,
        version: scheme.version,
        customer: scheme.customer,
        scope: scope,
        startDate: startDate,
        endDate: endDate,
        reviewer: reviewer,
        maker: sub.maker,
        fingerprint: sub.snapshot.fingerprint,
        issuedAt: nowIso
      };
      sub.history.push({ status: STATUS.APPROVED, at: nowIso, by: reviewer, note: "审核通过，生成交付单 " + sub.deliveryNo });
    }
    scheme.updatedAt = nowIso;
    write(list);
    return { ok: true, submission: sub };
  }

  // 交付单号：授权日期 + 当日序号（JS-YYYYMMDD-001）
  function deliveryNo(issuedDate) {
    var compact = issuedDate.replace(/-/g, "");
    var seq = 1;
    read().forEach(function (s) {
      s.submissions.forEach(function (sub) {
        if (sub.deliveryNo && sub.deliveryNo.indexOf("JS-" + compact + "-") === 0) seq++;
      });
    });
    return "JS-" + compact + "-" + String(seq).padStart(3, "0");
  }

  // ---------- 客户确认 ----------
  function confirmByCustomer(key, submissionId) {
    var list = read();
    var scheme = list.filter(function (s) { return s.key === key; })[0];
    if (!scheme) return { ok: false, error: "方案不存在" };
    var sub = scheme.submissions.filter(function (x) { return x.id === submissionId; })[0];
    if (!sub) return { ok: false, error: "交付单不存在" };
    if (sub.status !== STATUS.APPROVED) return { ok: false, error: "只有审核通过的交付单可确认" };
    if (isExpired(sub)) return { ok: false, error: "授权期限已到期，不能再确认" };

    var nowIso = new Date().toISOString();
    sub.status = STATUS.CONFIRMED;
    sub.confirmedAt = nowIso;
    sub.history.push({ status: STATUS.CONFIRMED, at: nowIso, note: "客户确认，版本定稿" });
    scheme.confirmed = true;
    scheme.updatedAt = nowIso;
    write(list);
    return { ok: true, submission: sub };
  }

  // ---------- 状态 / 期限 / 筛选 ----------
  function isExpired(sub) {
    return !!sub && sub.status === STATUS.APPROVED && !!sub.endDate && sub.endDate < todayISO();
  }

  function displayStatus(sub) {
    if (!sub) return "unsent";
    return isExpired(sub) ? "expired" : sub.status;
  }

  // 剩余天数（含今天）
  function daysLeft(sub) {
    if (!sub || !sub.endDate || (sub.status !== STATUS.APPROVED)) return null;
    var today = new Date(todayISO() + "T00:00:00");
    var end = new Date(sub.endDate + "T00:00:00");
    return Math.round((end - today) / 86400000);
  }

  // statusFilter 可传：all / unsent / in_review / rejected / approved / expired / confirmed / invalidated
  function filterBy(customerName, statusFilter) {
    var list = all();
    if (customerName) list = list.filter(function (s) { return s.customer === customerName; });
    if (statusFilter && statusFilter !== "all") {
      list = list.filter(function (s) { return displayStatus(latest(s)) === statusFilter; });
    }
    return list;
  }

  function customers() {
    var seen = {};
    all().forEach(function (s) { seen[s.customer] = true; });
    return Object.keys(seen).sort();
  }

  global.ZhijinAuth = {
    STATUS: STATUS,
    todayISO: todayISO,
    all: all,
    find: find,
    keyOf: keyOf,
    latest: latest,
    createScheme: createScheme,
    updateCanvas: updateCanvas,
    createNextVersion: createNextVersion,
    submit: submit,
    review: review,
    confirmByCustomer: confirmByCustomer,
    isExpired: isExpired,
    displayStatus: displayStatus,
    daysLeft: daysLeft,
    filterBy: filterBy,
    customers: customers
  };
})(window);
