/*
 * authorization.js —— 授权判定业务
 * 负责：送审唯一性（项目编号+版本号）、审核人回避判定、
 *       审核通过签发授权期限/适用范围交付单、客户确认、
 *       画布改动导致旧交付单自动失效、状态与剩余期限计算。
 * 只做判定与存取，不操作页面。
 */
(function (global) {
  "use strict";

  var STORE_KEY = "zfl31Deliveries";

  var STATUS = {
    PENDING: "pending",     // 待审核
    DELIVERED: "delivered", // 已签发，待客户确认
    ACTIVE: "active",       // 授权生效中（由已确认交付单按日期派生）
    EXPIRED: "expired",     // 已到期（派生）
    REJECTED: "rejected",   // 审核驳回
    INVALID: "invalid"      // 画布改动后自动失效，留存历史
  };

  // 适用范围候选项
  var SCOPES = ["真丝披肩", "壁挂挂屏", "服装面料", "丝巾领带", "文创礼盒", "数字展示"];

  /* ---------------- 存取 ---------------- */

  function loadAll() {
    try {
      var arr = JSON.parse(localStorage.getItem(STORE_KEY));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(records) {
    localStorage.setItem(STORE_KEY, JSON.stringify(records));
  }

  /* ---------------- 工具 ---------------- */

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function validDate(s) { return parseDate(s) !== null; }

  function dayDiff(fromStr, toStr) {
    var a = parseDate(fromStr), b = parseDate(toStr);
    return Math.round((b - a) / 86400000);
  }

  function slug(v) {
    return String(v || "").trim().replace(/[^\w一-龥]+/g, "-").replace(/^-+|-+$/g, "") || "X";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function findActiveSameVersion(records, projectNo, versionNo) {
    var p = String(projectNo).trim(), v = String(versionNo).trim();
    return records.find(function (r) {
      return r.projectNo === p && r.versionNo === v &&
        (r.status === STATUS.PENDING || r.status === STATUS.DELIVERED);
    });
  }

  /* ---------------- 派生状态与期限 ---------------- */

  // 按当天日期派生：交付单确认后，期限内=生效中，过期末日期=已到期
  function deriveStatus(record, today) {
    today = today || todayStr();
    if (record.status !== STATUS.DELIVERED) return record.status;
    if (!record.confirmedAt) return STATUS.DELIVERED;
    if (dayDiff(today, record.endDate) < 0) return STATUS.EXPIRED;
    return STATUS.ACTIVE;
  }

  // 剩余期限（天，含到期日当天）；非交付单返回 null
  function daysRemaining(record, today) {
    today = today || todayStr();
    if (record.status !== STATUS.DELIVERED) return null;
    return dayDiff(today, record.endDate);
  }

  /* ---------------- 送审 ---------------- */

  // 用冻结快照创建送审记录。项目编号+版本号在途唯一。
  function createSubmission(input) {
    var errors = [];
    var projectNo = String(input.projectNo || "").trim();
    var versionNo = String(input.versionNo || "").trim();
    var customer = String(input.customer || "").trim();
    var maker = String(input.maker || "").trim();
    var snap = input.snapshot;

    if (!projectNo) errors.push("项目编号必填");
    if (!versionNo) errors.push("版本号必填");
    if (!customer) errors.push("客户必填");
    if (!maker) errors.push("制版人必填");
    if (!snap || !snap.hash || !Array.isArray(snap.cells)) errors.push("缺少冻结快照");

    var records = loadAll();
    var dup = findActiveSameVersion(records, projectNo, versionNo);
    if (dup) {
      errors.push("项目 " + projectNo + " / " + versionNo + " 已有在途方案（" +
        statusLabel(deriveStatus(dup)) + "），不能重复送审");
    }
    if (errors.length) return { ok: false, errors: errors };

    var now = new Date().toISOString();
    var record = {
      id: "sub-" + Date.now() + "-" + Math.floor(Math.random() * 1e4),
      projectNo: projectNo,
      versionNo: versionNo,
      customer: customer,
      maker: maker,
      status: STATUS.PENDING,
      snapshot: snap,
      submittedAt: now,
      reviewedAt: null,
      reviewer: null,
      rejectReason: null,
      deliveryNo: null,
      scope: null,
      startDate: null,
      endDate: null,
      issuedAt: null,
      confirmedAt: null,
      invalidatedAt: null,
      invalidateReason: null
    };
    records.unshift(record);
    saveAll(records);
    return { ok: true, record: record };
  }

  /* ---------------- 审核判定 ---------------- */

  // 审核是否允许通过：审核人不能为空且不能与制版人相同；期限与范围须合法
  function evaluateReview(record, decision, form) {
    var errors = [];
    if (!record || record.status !== STATUS.PENDING) {
      errors.push("该送审单不在待审核状态");
      return { ok: false, errors: errors };
    }
    var reviewer = String((form && form.reviewer) || "").trim();
    if (!reviewer) errors.push("审核人必填");
    if (reviewer && reviewer === record.maker) {
      errors.push("审核人不能与制版人相同（制版人：" + record.maker + "）");
    }

    if (decision === "approve") {
      var scope = (form && form.scope || []).filter(Boolean);
      if (!scope.length) errors.push("至少选择一项适用范围");
      if (!validDate(form && form.startDate)) errors.push("授权开始日期不合法");
      if (!validDate(form && form.endDate)) errors.push("授权到期日期不合法");
      if (validDate(form && form.startDate) && validDate(form && form.endDate) &&
          dayDiff(form.startDate, form.endDate) < 0) {
        errors.push("到期日期不能早于开始日期");
      }
    } else if (decision === "reject") {
      if (!String((form && form.reason) || "").trim()) errors.push("驳回须填写原因");
    } else {
      errors.push("审核结论不明确");
    }
    return { ok: errors.length === 0, errors: errors, reviewer: reviewer };
  }

  // 执行审核。通过 => 生成含授权期限和适用范围的交付单
  function review(id, decision, form) {
    var records = loadAll();
    var record = records.find(function (r) { return r.id === id; });
    if (!record) return { ok: false, errors: ["送审单不存在"] };

    var verdict = evaluateReview(record, decision, form);
    if (!verdict.ok) return verdict;

    record.reviewer = verdict.reviewer;
    record.reviewedAt = new Date().toISOString();

    if (decision === "approve") {
      record.status = STATUS.DELIVERED;
      record.scope = form.scope.slice();
      record.startDate = form.startDate;
      record.endDate = form.endDate;
      record.issuedAt = new Date().toISOString();
      record.deliveryNo = makeDeliveryNo(records, record);
      record.rejectReason = null;
    } else {
      record.status = STATUS.REJECTED;
      record.rejectReason = String(form.reason).trim();
    }
    saveAll(records);
    return { ok: true, record: record };
  }

  function makeDeliveryNo(records, record) {
    var d = new Date();
    var base = "DLV-" + slug(record.projectNo) + "-" + slug(record.versionNo) +
      "-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    var seq = records.filter(function (r) {
      return r.deliveryNo && r.deliveryNo.indexOf(base) === 0;
    }).length + 1;
    return base + "-" + pad(seq);
  }

  /* ---------------- 客户确认 ---------------- */

  function customerConfirm(id) {
    var records = loadAll();
    var record = records.find(function (r) { return r.id === id; });
    if (!record) return { ok: false, errors: ["交付单不存在"] };
    if (record.status !== STATUS.DELIVERED || record.confirmedAt) {
      return { ok: false, errors: ["该交付单当前不能确认"] };
    }
    if (deriveStatus(record) === STATUS.EXPIRED) {
      return { ok: false, errors: ["授权已到期，不能确认"] };
    }
    record.confirmedAt = new Date().toISOString();
    saveAll(records);
    return { ok: true, record: record };
  }

  /* ---------------- 画布改动失效判定 ---------------- */

  // 客户确认前，当前画布/色线与冻结快照不一致时，同项目版本的待审、待确认单据自动失效，留在历史里。
  // 客户已确认（授权生效中）的交付单不再受画布改动影响。
  function invalidateStale(projectNo, versionNo, currentState, reason) {
    var p = String(projectNo || "").trim(), v = String(versionNo || "").trim();
    if (!p || !v || !currentState) return [];
    var records = loadAll();
    var changed = [];
    records.forEach(function (r) {
      if (r.projectNo !== p || r.versionNo !== v) return;
      if (r.status === STATUS.INVALID || r.status === STATUS.REJECTED) return;
      if (r.confirmedAt) return;
      if (r.status !== STATUS.PENDING && r.status !== STATUS.DELIVERED) return;
      if (global.CanvasSnap && global.CanvasSnap.isStale(r.snapshot, currentState)) {
        r.status = STATUS.INVALID;
        r.invalidatedAt = new Date().toISOString();
        r.invalidateReason = reason || "画布网格或色线在客户确认前发生改动，旧交付单自动失效";
        changed.push(r);
      }
    });
    if (changed.length) saveAll(records);
    return changed;
  }

  /* ---------------- 查询 ---------------- */

  function query(filter, today) {
    today = today || todayStr();
    filter = filter || {};
    var customer = String(filter.customer || "").trim();
    return loadAll()
      .filter(function (r) {
        if (customer && r.customer !== customer) return false;
        var st = deriveStatus(r, today);
        if (filter.status && st !== filter.status) return false;
        return true;
      })
      .map(function (r) {
        var view = Object.assign({}, r);
        view.effectiveStatus = deriveStatus(r, today);
        view.remainingDays = daysRemaining(r, today);
        return view;
      })
      .sort(function (a, b) {
        return (b.submittedAt || "").localeCompare(a.submittedAt || "");
      });
  }

  function listCustomers() {
    var seen = {};
    loadAll().forEach(function (r) { seen[r.customer] = true; });
    return Object.keys(seen).sort();
  }

  function statusLabel(st) {
    return {
      pending: "待审核",
      delivered: "待客户确认",
      active: "授权生效中",
      expired: "已到期",
      rejected: "已驳回",
      invalid: "已失效"
    }[st] || st;
  }

  global.Authorization = {
    STATUS: STATUS,
    SCOPES: SCOPES,
    createSubmission: createSubmission,
    evaluateReview: evaluateReview,
    review: review,
    customerConfirm: customerConfirm,
    invalidateStale: invalidateStale,
    deriveStatus: deriveStatus,
    daysRemaining: daysRemaining,
    query: query,
    listCustomers: listCustomers,
    statusLabel: statusLabel,
    todayStr: todayStr,
    esc: esc
  };
})(window);
