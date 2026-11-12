/* =========================================================================
   LoRaMesh Monitor — dependency-free canvas charts
   ========================================================================= */
(function (global) {
  'use strict';

  var U = global.LoRaMonitor.utils;
  var ROOT = document.documentElement;

  var COLOR_MAP = {
    accent: '--accent',
    green: '--green',
    blue: '--blue',
    amber: '--amber',
    red: '--red',
    purple: '--purple',
    text: '--text',
    muted: '--muted',
    faint: '--faint',
    border: '--border',
    borderStrong: '--border-strong',
    panel: '--panel-solid',
    bg: '--bg-deep'
  };

  function cssVar(name) {
    return getComputedStyle(ROOT).getPropertyValue(name).trim();
  }

  function resolveColor(color, fallback) {
    if (!color) return fallback || cssVar('--accent');
    if (/^#|^rgb|^hsl/i.test(color)) return color;
    var mapped = COLOR_MAP[color] || color;
    var value = getComputedStyle(ROOT).getPropertyValue(mapped).trim();
    return value || fallback || cssVar('--accent');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function niceNumber(range, round) {
    var exponent = Math.floor(Math.log(range) / Math.LN10);
    var fraction = range / Math.pow(10, exponent);
    var niceFraction;
    if (round) {
      if (fraction < 1.5) niceFraction = 1;
      else if (fraction < 3) niceFraction = 2;
      else if (fraction < 7) niceFraction = 5;
      else niceFraction = 10;
    } else {
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
    }
    return niceFraction * Math.pow(10, exponent);
  }

  function niceScale(min, max, targets) {
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min === max) {
      if (min === 0) { min = 0; max = 1; }
      else {
        var pad = Math.abs(min) * 0.08 || 1;
        min -= pad;
        max += pad;
      }
    }
    var range = niceNumber(max - min, false);
    var step = niceNumber(range / Math.max(1, (targets || 5) - 1), true);
    var niceMin = Math.floor(min / step) * step;
    var niceMax = Math.ceil(max / step) * step;
    return { min: niceMin, max: niceMax, step: step };
  }

  function decimalsForStep(step) {
    if (step >= 1) return 0;
    if (step >= 0.1) return 1;
    if (step >= 0.01) return 2;
    return 3;
  }

  function timeStep(span) {
    var steps = [
      1000, 2000, 5000, 10000, 15000, 30000,
      60000, 120000, 300000, 600000, 900000, 1800000, 3600000
    ];
    for (var i = 0; i < steps.length; i++) {
      if (span / steps[i] <= 6) return steps[i];
    }
    return steps[steps.length - 1];
  }

  function formatAxisTime(ms, span) {
    var d = new Date(ms);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    return span > 600000 ? hh + ':' + mm : hh + ':' + mm + ':' + ss;
  }

  function nearestPoint(points, x) {
    if (!points || !points.length) return null;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (p.y === null || p.y === undefined) continue;
      var dist = Math.abs(p.x - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  }

  function TimeSeriesChart(canvas, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = Object.assign({
      yFormat: function (v) { return U.formatNumber(v); },
      emptyText: 'No data in this window',
      yMin: null,
      yMax: null,
      minSpan: null,
      suggestedMin: null,
      suggestedMax: null,
      tooltipFormat: null,
      fill: true
    }, options || {});
    this.series = [];
    this.xMin = 0;
    this.xMax = 0;
    this._width = 0;
    this._height = 0;
    this._plot = null;
    this._nearest = null;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    canvas.parentElement.appendChild(this.tooltip);

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerleave', this._onPointerLeave);

    var self = this;
    if (global.ResizeObserver) {
      this._observer = new ResizeObserver(function () { self.resize(); });
      this._observer.observe(canvas.parentElement);
    } else {
      global.addEventListener('resize', function () { self.resize(); });
    }
    this.resize();
  }

  TimeSeriesChart.prototype.setData = function (series, xMin, xMax) {
    this.series = series || [];
    this.xMin = xMin;
    this.xMax = xMax;
    this._hideTooltip();
    this.draw();
  };

  TimeSeriesChart.prototype.resize = function () {
    var parent = this.canvas.parentElement;
    if (!parent) return;
    var rect = parent.getBoundingClientRect();
    var width = Math.max(0, Math.floor(rect.width));
    var height = Math.max(0, Math.floor(rect.height));
    if (!width || !height) return;
    if (width === this._width && height === this._height) {
      this.draw();
      return;
    }
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._width = width;
    this._height = height;
    this.draw();
  };

  TimeSeriesChart.prototype._bounds = function () {
    var hasLegend = this.series.length > 0;
    var top = hasLegend ? 30 : 14;
    return {
      left: 54,
      right: this._width - 12,
      top: top,
      bottom: this._height - 24,
      width: Math.max(1, this._width - 66),
      height: Math.max(1, this._height - top - 24)
    };
  };

  TimeSeriesChart.prototype._yRange = function () {
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < this.series.length; i++) {
      var points = this.series[i].points || [];
      for (var j = 0; j < points.length; j++) {
        var y = points[j].y;
        if (y === null || y === undefined || !isFinite(y)) continue;
        if (y < min) min = y;
        if (y > max) max = y;
      }
    }
    if (min === Infinity) {
      min = this.options.suggestedMin !== null ? this.options.suggestedMin : 0;
      max = this.options.suggestedMax !== null ? this.options.suggestedMax : 1;
    }
    if (this.options.suggestedMin !== null && this.options.suggestedMin !== undefined) min = Math.min(min, this.options.suggestedMin);
    if (this.options.suggestedMax !== null && this.options.suggestedMax !== undefined) max = Math.max(max, this.options.suggestedMax);
    var pad = (max - min) * 0.08;
    if (pad > 0) {
      min -= pad;
      max += pad;
    }
    var scale = niceScale(min, max, 5);
    if (this.options.yMin !== null && this.options.yMin !== undefined) scale.min = this.options.yMin;
    if (this.options.yMax !== null && this.options.yMax !== undefined) scale.max = this.options.yMax;
    if (scale.max === scale.min) scale.max = scale.min + 1;
    return scale;
  };

  TimeSeriesChart.prototype.draw = function () {
    var ctx = this.ctx;
    if (!this._width || !this._height) return;
    ctx.clearRect(0, 0, this._width, this._height);

    var plot = this._bounds();
    this._plot = plot;
    var textColor = resolveColor('faint');
    var gridColor = resolveColor('borderStrong');
    var font = '10px ' + cssVar('--font-mono');
    ctx.font = font;
    ctx.textBaseline = 'middle';

    var hasData = this.series.some(function (s) {
      return (s.points || []).some(function (p) { return p.y !== null && p.y !== undefined && isFinite(p.y); });
    });

    if (!hasData) {
      ctx.fillStyle = textColor;
      ctx.font = '12px ' + cssVar('--font-sans');
      ctx.textAlign = 'center';
      ctx.fillText(this.options.emptyText, this._width / 2, this._height / 2);
      ctx.textAlign = 'left';
      return;
    }

    var xMin = this.xMin || 0;
    var xMax = this.xMax || xMin + 1;
    if (xMax <= xMin) xMax = xMin + 1;
    var yScale = this._yRange();
    var yMin = yScale.min;
    var yMax = yScale.max;

    var xToPx = function (x) { return plot.left + ((x - xMin) / (xMax - xMin)) * plot.width; };
    var yToPx = function (y) { return plot.bottom - ((y - yMin) / (yMax - yMin)) * plot.height; };
    this._xToPx = xToPx;
    this._yToPx = yToPx;
    this._yMin = yMin;
    this._yMax = yMax;

    // Horizontal grid + Y labels.
    var ySteps = Math.max(1, Math.round((yMax - yMin) / yScale.step));
    var yDecimals = decimalsForStep(yScale.step);
    ctx.strokeStyle = gridColor;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';
    for (var i = 0; i <= ySteps; i++) {
      var value = yMin + i * yScale.step;
      if (value > yMax + yScale.step * 0.001) break;
      var py = yToPx(value);
      ctx.beginPath();
      ctx.moveTo(plot.left, py);
      ctx.lineTo(plot.right, py);
      ctx.stroke();
      var label = this.options.yFormat(value, yDecimals);
      ctx.fillText(label, plot.left - 8, py);
    }
    ctx.globalAlpha = 1;

    // Vertical grid + X labels.
    var span = xMax - xMin;
    var step = timeStep(span);
    var first = Math.ceil(xMin / step) * step;
    ctx.textAlign = 'center';
    ctx.fillStyle = textColor;
    for (var t = first; t <= xMax; t += step) {
      var px = xToPx(t);
      if (px < plot.left + 12 || px > plot.right - 12) continue;
      ctx.strokeStyle = gridColor;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(px, plot.top);
      ctx.lineTo(px, plot.bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(formatAxisTime(t, span), px, plot.bottom + 13);
    }
    ctx.textAlign = 'left';

    // Clip data to the plotting area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();

    for (var s = 0; s < this.series.length; s++) {
      var series = this.series[s];
      var color = resolveColor(series.color);
      var points = series.points || [];
      var segments = [];
      var current = [];
      for (var pIndex = 0; pIndex < points.length; pIndex++) {
        var point = points[pIndex];
        var valid = point.y !== null && point.y !== undefined && isFinite(point.y);
        if (valid) {
          current.push({ px: xToPx(point.x), py: yToPx(point.y), x: point.x, y: point.y });
        } else if (current.length) {
          segments.push(current);
          current = [];
        }
      }
      if (current.length) segments.push(current);

      for (var segIndex = 0; segIndex < segments.length; segIndex++) {
        var segment = segments[segIndex];
        if (segment.length < 2) continue;

        if (this.options.fill && this.series.length === 1) {
          var gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
          gradient.addColorStop(0, hexToRgba(color, 0.2));
          gradient.addColorStop(1, hexToRgba(color, 0.01));
          ctx.beginPath();
          ctx.moveTo(segment[0].px, plot.bottom);
          for (var g = 0; g < segment.length; g++) ctx.lineTo(segment[g].px, segment[g].py);
          ctx.lineTo(segment[segment.length - 1].px, plot.bottom);
          ctx.closePath();
          ctx.fillStyle = gradient;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = series.width || 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (series.dashed) ctx.setLineDash([5, 4]);
        for (var l = 0; l < segment.length; l++) {
          if (l === 0) ctx.moveTo(segment[l].px, segment[l].py);
          else ctx.lineTo(segment[l].px, segment[l].py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Last point marker.
      for (var lastIndex = points.length - 1; lastIndex >= 0; lastIndex--) {
        var last = points[lastIndex];
        if (last.y !== null && last.y !== undefined && isFinite(last.y)) {
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(xToPx(last.x), yToPx(last.y), 2.6, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
    }
    ctx.restore();

    // Axis lines.
    ctx.strokeStyle = gridColor;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(plot.left, plot.bottom + 0.5);
    ctx.lineTo(plot.right, plot.bottom + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Legend.
    if (this.series.length) {
      var lx = plot.left;
      var ly = 13;
      ctx.font = '10px ' + cssVar('--font-sans');
      ctx.textBaseline = 'middle';
      for (var k = 0; k < this.series.length; k++) {
        var item = this.series[k];
        var itemColor = resolveColor(item.color);
        ctx.strokeStyle = itemColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(lx + 14, ly);
        ctx.stroke();
        ctx.fillStyle = resolveColor('muted');
        ctx.fillText(item.name, lx + 19, ly);
        lx += 19 + ctx.measureText(item.name).width + 17;
      }
    }

    if (this._nearest) this._drawCrosshair(this._nearest);
  };

  TimeSeriesChart.prototype._drawCrosshair = function (point) {
    if (!this._plot || !point) return;
    var ctx = this.ctx;
    var plot = this._plot;
    var px = this._xToPx(point.x);
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();
    ctx.strokeStyle = resolveColor('accent');
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, plot.top);
    ctx.lineTo(px, plot.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    for (var i = 0; i < this.series.length; i++) {
      var series = this.series[i];
      var nearest = nearestPoint(series.points || [], point.x);
      if (!nearest) continue;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.fillStyle = resolveColor(series.color);
      ctx.arc(px, this._yToPx(nearest.y), 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = resolveColor('panel');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  };

  TimeSeriesChart.prototype._onPointerMove = function (event) {
    if (!this._plot || !this.series.length) return;
    var rect = this.canvas.getBoundingClientRect();
    var x = event.clientX - rect.left;
    var y = event.clientY - rect.top;
    if (x < this._plot.left || x > this._plot.right || y < this._plot.top || y > this._plot.bottom) {
      this._hideTooltip();
      return;
    }
    var time = this.xMin + ((x - this._plot.left) / this._plot.width) * (this.xMax - this.xMin);
    var nearest = nearestPoint(this.series[0].points || [], time);
    if (!nearest) {
      this._hideTooltip();
      return;
    }
    this._nearest = nearest;
    this.draw();

    var rows = this.series.map(function (series) {
      var p = nearestPoint(series.points || [], nearest.x);
      if (!p) return '';
      var formatted = series.tooltipFormat
        ? series.tooltipFormat(p.y)
        : U.formatNumber(p.y);
      var swatch = resolveColor(series.color);
      return '<div class="tt-row"><span><span class="tt-swatch" style="background:' + swatch + '"></span>' +
        U.escapeHtml(series.name) + '</span><b>' + U.escapeHtml(formatted) + '</b></div>';
    }).join('');

    this.tooltip.innerHTML =
      '<div class="tt-time">' + U.formatDateTime(nearest.x) + '</div>' + rows;
    this.tooltip.classList.add('is-visible');

    var px = this._xToPx(nearest.x);
    var tooltipWidth = this.tooltip.offsetWidth || 140;
    var left = clamp(px, tooltipWidth / 2 + 6, this._width - tooltipWidth / 2 - 6);
    this.tooltip.style.left = left + 'px';
    this.tooltip.style.top = '22px';
  };

  TimeSeriesChart.prototype._onPointerLeave = function () {
    this._hideTooltip();
  };

  TimeSeriesChart.prototype._hideTooltip = function () {
    if (!this._nearest && !this.tooltip.classList.contains('is-visible')) return;
    this._nearest = null;
    this.tooltip.classList.remove('is-visible');
    this.draw();
  };

  TimeSeriesChart.prototype.redraw = function () {
    this.draw();
  };

  function hexToRgba(color, alpha) {
    var value = color.trim();
    if (value.charAt(0) === '#') {
      var hex = value.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var int = parseInt(hex, 16);
      if (!isNaN(int)) {
        var r = (int >> 16) & 255;
        var g = (int >> 8) & 255;
        var b = int & 255;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
      }
    }
    if (/^rgba?\(/i.test(value)) {
      var nums = value.replace(/^rgba?\(|\)$/gi, '').split(',').map(function (n) { return n.trim(); });
      return 'rgba(' + nums[0] + ',' + nums[1] + ',' + nums[2] + ',' + alpha + ')';
    }
    return 'rgba(34,211,238,' + alpha + ')';
  }

  function drawSparkline(canvas, values, colorName) {
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    var width = Math.floor(rect.width);
    var height = Math.floor(rect.height);
    if (!width || !height) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    var clean = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined && isFinite(values[i])) clean.push(values[i]);
    }
    var color = resolveColor(colorName || 'accent');
    if (clean.length < 2) {
      ctx.strokeStyle = resolveColor('borderStrong');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, height - 2);
      ctx.lineTo(width, height - 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    var min = Math.min.apply(null, clean);
    var max = Math.max.apply(null, clean);
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
    var stepX = width / (values.length - 1);
    var points = [];
    for (var p = 0; p < values.length; p++) {
      var value = values[p];
      if (value === null || value === undefined || !isFinite(value)) {
        points.push(null);
      } else {
        var py = height - ((value - min) / (max - min)) * (height - 3) - 1.5;
        points.push({ x: p * stepX, y: py });
      }
    }
    // Area fill.
    var first = null;
    var last = null;
    for (var a = 0; a < points.length; a++) {
      if (points[a]) { if (first === null) first = a; last = a; }
    }
    if (first !== null && last !== null && last > first) {
      var gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, hexToRgba(color, 0.18));
      gradient.addColorStop(1, hexToRgba(color, 0.01));
      ctx.beginPath();
      ctx.moveTo(points[first].x, height);
      for (var f = first; f <= last; f++) {
        if (points[f]) ctx.lineTo(points[f].x, points[f].y);
      }
      ctx.lineTo(points[last].x, height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var drawing = false;
    for (var q = 0; q < points.length; q++) {
      if (!points[q]) { drawing = false; continue; }
      if (!drawing) { ctx.moveTo(points[q].x, points[q].y); drawing = true; }
      else ctx.lineTo(points[q].x, points[q].y);
    }
    ctx.stroke();
  }

  global.LoRaMonitor.Charts = {
    TimeSeriesChart: TimeSeriesChart,
    drawSparkline: drawSparkline,
    resolveColor: resolveColor
  };
})(window);
