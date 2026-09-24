/*
 * snapshot.js —— 画布快照业务
 * 负责冻结送审当时的网格与色线：网格尺寸、每格色线编号、色板颜色、用色统计与指纹。
 * 快照一经生成即为只读数据，后续改动画布不会影响快照内容。
 */
(function (global) {
  "use strict";

  // 按色线编号统计用量
  function usage(cells, colors) {
    return colors.map(function (color, i) {
      return { color: color, count: cells.filter(function (v) { return v === i; }).length };
    });
  }

  // djb2 指纹：网格尺寸 + 色板 + 每格颜色 任一变化都会得到不同指纹
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function fingerprint(state) {
    return hash(JSON.stringify([state.cols, state.rows, state.colors, state.cells]));
  }

  // 冻结当前画布：全部数组深拷贝，外界之后再改动与快照无关
  function capture(state) {
    var cols = state.cols;
    var rows = state.rows;
    var cells = state.cells.slice();
    var colors = state.colors.slice();
    var frozen = {
      cols: cols,
      rows: rows,
      cells: cells,
      colors: colors,
      usage: usage(cells, colors),
      fingerprint: fingerprint({ cols: cols, rows: rows, cells: cells, colors: colors }),
      capturedAt: new Date().toISOString()
    };
    return frozen;
  }

  global.ZhijinSnapshot = {
    capture: capture,
    fingerprint: fingerprint,
    usage: usage
  };
})(window);
