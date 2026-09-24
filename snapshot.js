/*
 * snapshot.js —— 画布快照业务
 * 负责：冻结当时的网格与色线快照（深拷贝、哈希、色线用量统计）。
 * 不依赖授权判定与页面交互，可独立使用。
 */
(function (global) {
  "use strict";

  // 冻结一份不可变快照：网格尺寸 + 逐格色线索引 + 色线板
  function capture(state) {
    if (!state || !Array.isArray(state.cells) || !Array.isArray(state.colors)) {
      throw new Error("快照数据不完整");
    }
    if (!Number.isInteger(state.cols) || !Number.isInteger(state.rows)) {
      throw new Error("网格尺寸不合法");
    }
    if (state.cells.length !== state.cols * state.rows) {
      throw new Error("网格与色线数据不一致");
    }
    var snap = {
      cols: state.cols,
      rows: state.rows,
      cells: state.cells.slice(),
      colors: state.colors.slice(),
      hash: "",
      usage: null,
      takenAt: new Date().toISOString()
    };
    snap.hash = hashOf(snap);
    snap.usage = usageOf(snap);
    return deepFreeze(snap);
  }

  // 判定当前画布是否相对冻结快照发生过改动
  function isStale(snap, state) {
    if (!snap) return true;
    try {
      return hashOf({
        cols: state.cols,
        rows: state.rows,
        cells: state.cells,
        colors: state.colors
      }) !== snap.hash;
    } catch (e) {
      return true;
    }
  }

  // 结构哈希：尺寸、色线板顺序、逐格色线索引全部一致才相同
  function hashOf(s) {
    var parts = [s.cols, "x", s.rows, "|", s.colors.join(","), "|", s.cells.join(".")];
    var str = parts.join("");
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return "h" + h.toString(16);
  }

  // 色线用量统计（按色线板逐色计数）
  function usageOf(s) {
    return s.colors.map(function (color, i) {
      return { index: i, color: color, count: s.cells.filter(function (v) { return v === i; }).length };
    });
  }

  function deepFreeze(obj) {
    if (obj && typeof obj === "object") {
      Object.values(obj).forEach(deepFreeze);
      Object.freeze(obj);
    }
    return obj;
  }

  global.CanvasSnap = { capture: capture, isStale: isStale, hashOf: hashOf, usageOf: usageOf };
})(window);
