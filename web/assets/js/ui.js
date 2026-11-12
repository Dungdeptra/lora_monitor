/* =========================================================================
   LoRaMesh Monitor — DOM rendering and interactions
   ========================================================================= */
(function (global) {
  'use strict';

  var U = global.LoRaMonitor.utils;
  var CFG = global.LoRaMonitor.config;
  var Charts = global.LoRaMonitor.Charts;

  var THEME_KEY = 'loramesh.monitor.theme';
  var VIEWS = ['overview', 'nodes', 'events', 'charts', 'guide'];

  function byId(id) { return document.getElementById(id); }

  function statusInfo(node, store) {
    var state = store.nodeState(node, Date.now());
    if (state === 'online') {
      return {
        state: state,
        label: 'Live',
        title: 'Telemetry received within the last 45 seconds.'
      };
    }
    if (state === 'stale') {
      return {
        state: state,
        label: 'Stale',
        title: 'No recent MQTT telemetry. The monitoring link may be down; LoRa state is unknown.'
      };
    }
    return {
      state: 'unknown',
      label: 'Waiting',
      title: 'No telemetry has been received from this node yet.'
    };
  }

  function wifiInfo(node) {
    var m = node.metrics || {};
    if (m.wifi_connected === true) {
      var rssi = U.numberOrNull(m.wifi_rssi);
      var quality = U.numberOrNull(m.wifi_quality);
      return {
        state: 'up',
        rssi: rssi,
        quality: quality,
        label: rssi === null ? 'Wi-Fi up' : 'Wi-Fi ' + Math.round(rssi) + ' dBm',
        className: U.signalClass(rssi)
      };
    }
    if (m.wifi_connected === false) {
      return { state: 'down', rssi: null, quality: null, label: 'Wi-Fi down', className: 'is-weak' };
    }
    return { state: 'unknown', rssi: null, quality: null, label: 'Wi-Fi n/a', className: '' };
  }

  function shortAddress(node, store) {
    var address = store.nodeAddress(node);
    var hex = U.hexAddr(address);
    if (hex === '—') {
      return U.text(node.id).slice(-4).toUpperCase() || '????';
    }
    return hex.replace(/^0x/, '').slice(-4);
  }

  function nodeName(node) {
    return U.text((node.meta && node.meta.node_id) || node.id) || 'unknown';
  }

  function formatRssi(value) {
    var n = U.numberOrNull(value);
    return n === null ? '—' : n.toFixed(1) + ' dBm';
  }

  function formatSnr(value) {
    var n = U.numberOrNull(value);
    return n === null ? '—' : n.toFixed(1) + ' dB';
  }

  function ratePoints(history, cutoff) {
    var points = [];
    for (var i = 1; i < history.length; i++) {
      var prev = history[i - 1];
      var cur = history[i];
      if (cur.t < cutoff) continue;
      var dt = (cur.t - prev.t) / 1000;
      if (!(dt > 0)) continue;
      var tx = null;
      var rx = null;
      if (cur.tx !== null && prev.tx !== null && cur.tx >= prev.tx) tx = (cur.tx - prev.tx) / dt;
      if (cur.rx !== null && prev.rx !== null && cur.rx >= prev.rx) rx = (cur.rx - prev.rx) / dt;
      points.push({ t: cur.t, tx: tx, rx: rx });
    }
    return points;
  }

  function seriesPoints(rows, key, transform) {
    return rows.map(function (row) {
      var value = row[key];
      if (value === null || value === undefined || !isFinite(value)) return { x: row.t, y: null };
      return { x: row.t, y: transform ? transform(value) : value };
    });
  }

  function UI(store, bridge, callbacks) {
    this.store = store;
    this.bridge = bridge;
    this.callbacks = callbacks || {};
    this.currentView = 'overview';
    this.overviewFilter = 'all';
    this.nodeSearch = '';
    this.nodeSort = 'lastSeen';
    this.eventFilter = 'all';
    this.eventNode = 'all';
    this.eventsPaused = false;
    this.chartNodeId = null;
    this.chartWindow = 300000;
    this.charts = {};
    this._raf = null;
    this._tick = 0;
    this._eventRenderKey = '';
    this._eventNodeOptionsKey = '';
    this._drawerOpen = false;
    this._settingsOpen = false;
    this._bind();
    this._initCharts();
  }

  UI.prototype._bind = function () {
    var self = this;

    byId('theme-toggle').addEventListener('click', function () { self.toggleTheme(); });
    byId('settings-btn').addEventListener('click', function () { self.openSettings(); });
    byId('connection-pill').addEventListener('click', function () { self.openSettings(); });
    byId('drawer-close').addEventListener('click', function () { self.closeDrawer(); });
    byId('drawer-backdrop').addEventListener('click', function () { self.closeDrawer(); });

    document.querySelectorAll('[data-open-settings]').forEach(function (button) {
      button.addEventListener('click', function () { self.openSettings(); });
    });
    document.querySelectorAll('[data-copy]').forEach(function (button) {
      button.addEventListener('click', function () { self._copySnippet(button); });
    });

    byId('overview-filter').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-filter]');
      if (!button) return;
      self.overviewFilter = button.dataset.filter;
      byId('overview-filter').querySelectorAll('button').forEach(function (item) {
        item.classList.toggle('is-active', item === button);
      });
      self.render();
    });

    byId('overview-alert-action').addEventListener('click', function () {
      var action = byId('overview-alert-action').dataset.action;
      if (action === 'guide') location.hash = '#guide';
      else if (action === 'stale') {
        self.overviewFilter = 'stale';
        byId('overview-filter').querySelectorAll('button').forEach(function (item) {
          item.classList.toggle('is-active', item.dataset.filter === 'stale');
        });
        self.render();
      } else {
        self.openSettings();
      }
    });

    byId('node-grid').addEventListener('click', function (event) {
      var card = event.target.closest('.node-card');
      if (card) self.openDrawer(card.dataset.nodeId);
    });
    byId('node-grid').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var card = event.target.closest('.node-card');
      if (!card) return;
      event.preventDefault();
      self.openDrawer(card.dataset.nodeId);
    });

    byId('node-search').addEventListener('input', function (event) {
      self.nodeSearch = event.target.value;
      self.render();
    });
    byId('node-sort').addEventListener('change', function (event) {
      self.nodeSort = event.target.value;
      self.render();
    });
    byId('nodes-tbody').addEventListener('click', function (event) {
      var row = event.target.closest('tr[data-node-id]');
      if (row) self.openDrawer(row.dataset.nodeId);
    });

    byId('event-filters').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-filter]');
      if (!button) return;
      self.eventFilter = button.dataset.filter;
      byId('event-filters').querySelectorAll('button').forEach(function (item) {
        item.classList.toggle('is-active', item === button);
      });
      self._eventRenderKey = '';
      self.render();
    });
    byId('event-node-filter').addEventListener('change', function (event) {
      self.eventNode = event.target.value;
      self._eventRenderKey = '';
      self.render();
    });
    byId('events-pause').addEventListener('change', function (event) {
      self.eventsPaused = event.target.checked;
      self._eventRenderKey = '';
      self.render();
    });
    byId('events-clear').addEventListener('click', function () {
      self.store.clearEvents();
      self.toast('Event stream cleared.', 'info');
    });
    byId('events-export').addEventListener('click', function () {
      var payload = self.store.exportData();
      U.download('loramesh-monitor-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
        JSON.stringify(payload, null, 2));
      self.toast('Exported nodes, history and events.', 'success');
    });

    byId('chart-node').addEventListener('change', function (event) {
      self.chartNodeId = event.target.value;
      self.render();
    });
    byId('chart-window').addEventListener('change', function (event) {
      self.chartWindow = Number(event.target.value) || 300000;
      self.render();
    });

    byId('settings-form').addEventListener('submit', function (event) {
      event.preventDefault();
      self._submitSettings();
    });
    byId('settings-close').addEventListener('click', function () { self.closeSettings(); });
    byId('settings-cancel').addEventListener('click', function () { self.closeSettings(); });
    byId('settings-disconnect').addEventListener('click', function () {
      self.closeSettings();
      if (self.callbacks.onDisconnect) self.callbacks.onDisconnect();
    });
    byId('settings-dialog').addEventListener('click', function (event) {
      if (event.target === byId('settings-dialog')) self.closeSettings();
    });
    byId('broker-preset').addEventListener('change', function (event) {
      if (event.target.value) byId('broker-url').value = event.target.value;
    });
    byId('topic-prefix').addEventListener('input', function (event) {
      var prefix = CFG.sanitizePrefix(event.target.value);
      byId('prefix-preview').textContent = prefix + '/+/metrics';
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && self._drawerOpen) self.closeDrawer();
    });
  };

  UI.prototype._initCharts = function () {
    var rate = new Charts.TimeSeriesChart(byId('chart-rate'), {
      emptyText: 'Waiting for metrics samples',
      yFormat: function (value, decimals) { return Number(value).toFixed(decimals === undefined ? 1 : decimals); }
    });
    var signal = new Charts.TimeSeriesChart(byId('chart-signal'), {
      emptyText: 'No RSSI/SNR reported yet',
      yFormat: function (value) { return Number(value).toFixed(1); }
    });
    var wifi = new Charts.TimeSeriesChart(byId('chart-wifi'), {
      emptyText: 'No Wi-Fi RSSI reported yet',
      yFormat: function (value) { return Number(value).toFixed(0); }
    });
    var heap = new Charts.TimeSeriesChart(byId('chart-heap'), {
      emptyText: 'No heap samples yet',
      yFormat: function (value) { return Number(value).toFixed(0); }
    });
    this.charts = { rate: rate, signal: signal, wifi: wifi, heap: heap };
  };

  UI.prototype.setView = function (view) {
    if (VIEWS.indexOf(view) === -1) view = 'overview';
    this.currentView = view;
    VIEWS.forEach(function (name) {
      var panel = byId('view-' + name);
      if (panel) panel.hidden = name !== view;
    });
    document.querySelectorAll('#main-nav a[data-view]').forEach(function (link) {
      link.classList.toggle('is-active', link.dataset.view === view);
    });
    this.render();
    if (view === 'charts') {
      var self = this;
      requestAnimationFrame(function () {
        Object.keys(self.charts).forEach(function (key) { self.charts[key].resize(); });
      });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  UI.prototype.scheduleRender = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      self.render();
    });
  };

  UI.prototype.render = function () {
    this._renderConnection();
    this._renderNavCount();
    this._renderFooter();

    if (this.currentView === 'overview') {
      this._renderOverview();
    } else if (this.currentView === 'nodes') {
      this._renderNodesTable();
    } else if (this.currentView === 'events') {
      this._renderEvents();
    } else if (this.currentView === 'charts') {
      this._renderCharts();
    }
    if (this._drawerOpen) this._renderDrawer();
  };

  UI.prototype._renderConnection = function () {
    var connection = this.store.connection;
    var pill = byId('connection-pill');
    var label = byId('connection-label');
    var status = connection.status;
    var className = 'conn-pill';
    var text = 'Not connected';
    var title = connection.detail || '';

    if (status === 'connected') {
      className += ' is-connected';
      var host = '';
      try { host = new URL(connection.brokerUrl).hostname; } catch (err) { host = connection.brokerUrl; }
      text = 'Live · ' + host;
    } else if (status === 'connecting') {
      className += ' is-connecting';
      text = 'Connecting…';
    } else if (status === 'reconnecting') {
      className += ' is-connecting';
      text = 'Reconnecting…';
    } else if (status === 'error') {
      className += ' is-error';
      text = 'Connection error';
      title = (connection.error || '') + (connection.detail ? ' · ' + connection.detail : '');
    } else if (status === 'disconnected') {
      className += ' is-error';
      text = 'Disconnected';
    } else if (status === 'idle') {
      text = 'Connecting…';
    }
    pill.className = className;
    label.textContent = text;
    pill.title = title || text;
  };

  UI.prototype._renderNavCount = function () {
    var badge = byId('event-nav-count');
    var count = this.store.events.length;
    badge.textContent = count > 999 ? '999+' : String(count);
    badge.classList.toggle('has-items', count > 0);
  };

  UI.prototype._renderFooter = function () {
    var broker = this.store.settings.brokerUrl;
    byId('footer-broker').textContent = this.store.connection.status === 'connected'
      ? broker
      : 'not connected · ' + broker;
    byId('footer-version').textContent = 'v' + CFG.VERSION;
    byId('overview-prefix').textContent = this.store.settings.topicPrefix + '/+/metrics';
  };

  UI.prototype._renderOverview = function () {
    var self = this;
    var totals = this.store.totals();
    var allNodes = this.store.allNodes().sort(function (a, b) { return b.lastSeen - a.lastSeen; });
    var visible = allNodes.filter(function (node) {
      if (self.overviewFilter === 'online') return self.store.isMonitoringOnline(node);
      if (self.overviewFilter === 'stale') return node.lastSeen > 0 && !self.store.isMonitoringOnline(node);
      return true;
    });

    byId('kpi-nodes').textContent = String(totals.online);
    byId('kpi-nodes-sub').textContent = totals.nodes === 0
      ? 'Waiting for telemetry'
      : totals.stale + ' stale · ' + totals.nodes + ' known';
    byId('kpi-packets').textContent = U.formatNumber(totals.tx + totals.rx);
    byId('kpi-packets-sub').textContent = 'TX ' + U.formatNumber(totals.tx) + ' · RX ' + U.formatNumber(totals.rx);
    byId('kpi-routes').textContent = U.formatNumber(totals.routes);
    byId('kpi-routes-sub').textContent = totals.nodes + ' reporting node' + (totals.nodes === 1 ? '' : 's');
    byId('kpi-errors').textContent = U.formatNumber(totals.errors);
    byId('kpi-errors-sub').textContent = totals.wifiDown > 0
      ? totals.wifiDown + ' node(s) report Wi-Fi down'
      : 'TX/RX errors · publish failures';

    this._renderOverviewAlert(totals);

    var grid = byId('node-grid');
    var empty = byId('overview-empty');
    if (!visible.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      if (allNodes.length === 0) {
        byId('overview-empty-text').textContent =
          'Connect to the broker and flash a node with NodeMonitor enabled. Nodes publish every few seconds.';
      } else {
        byId('overview-empty-text').textContent = 'No nodes match the "' + this.overviewFilter + '" filter.';
      }
      return;
    }
    empty.hidden = true;
    grid.innerHTML = visible.map(function (node) { return self._nodeCardHtml(node); }).join('');
    this._drawSparklines(grid);
  };

  UI.prototype._renderOverviewAlert = function (totals) {
    var alert = byId('overview-alert');
    var title = byId('overview-alert-title');
    var body = byId('overview-alert-text');
    var action = byId('overview-alert-action');
    var connection = this.store.connection;
    var status = connection.status;

    if (status !== 'connected') {
      alert.hidden = false;
      alert.className = 'alert ' + (status === 'error' ? 'alert-error' : 'alert-warn');
      if (status === 'connecting' || status === 'idle') {
        title.textContent = 'Connecting to the broker';
        body.textContent = (connection.detail || 'Opening WebSocket…') + ' ' + (connection.brokerUrl || '');
        action.textContent = 'Settings';
        action.dataset.action = 'settings';
      } else if (status === 'reconnecting') {
        title.textContent = 'Broker connection lost';
        body.textContent = 'The dashboard is retrying. Existing cards show the last telemetry received, which may be stale.';
        action.textContent = 'Settings';
        action.dataset.action = 'settings';
      } else if (status === 'error') {
        title.textContent = 'Cannot connect to the broker';
        body.textContent = connection.error || connection.detail || 'Check the WebSocket URL and credentials.';
        action.textContent = 'Settings';
        action.dataset.action = 'settings';
      } else {
        title.textContent = 'Dashboard disconnected';
        body.textContent = 'Open connection settings to subscribe to a broker.';
        action.textContent = 'Settings';
        action.dataset.action = 'settings';
      }
      return;
    }

    if (totals.nodes === 0) {
      alert.hidden = false;
      alert.className = 'alert alert-warn';
      title.textContent = 'Connected — waiting for nodes';
      body.textContent = 'Listening on ' + this.store.settings.topicPrefix +
        '/+/metrics. Make sure the firmware uses the same prefix and broker.';
      action.textContent = 'View guide';
      action.dataset.action = 'guide';
      return;
    }

    if (totals.stale > 0) {
      alert.hidden = false;
      alert.className = 'alert alert-warn';
      title.textContent = totals.stale + ' node' + (totals.stale === 1 ? '' : 's') + ' missing telemetry';
      body.textContent = 'No MQTT heartbeat within 45 seconds. This is a monitoring-link symptom, not proof of a LoRa or routing failure.';
      action.textContent = 'Show stale';
      action.dataset.action = 'stale';
      return;
    }

    alert.hidden = true;
  };

  UI.prototype._nodeCardHtml = function (node) {
    var store = this.store;
    var info = statusInfo(node, store);
    var wifi = wifiInfo(node);
    var metrics = node.metrics || {};
    var address = U.hexAddr(store.nodeAddress(node));
    var board = U.text(metrics.board || node.meta.board || 'Unknown board');
    var rssi = formatRssi(metrics.lora_rssi);
    var snr = formatSnr(metrics.lora_snr);
    var tx = U.formatNumber(metrics.tx_packets);
    var rx = U.formatNumber(metrics.rx_packets);
    var routeCount = store.nodeRoutes(node).length;
    var name = nodeName(node);
    var lastSeen = node.lastSeen || 0;
    var alert = '';
    if (info.state === 'stale') {
      alert = '<div class="node-card-alert"><svg class="icon" aria-hidden="true"><use href="#icon-alert"></use></svg>' +
        '<span>No telemetry for <span data-time="' + lastSeen + '">' + U.timeAgo(lastSeen) +
        '</span>. Monitoring link may be offline; LoRa state is unknown.</span></div>';
    }
    var wifiClass = wifi.state === 'up' ? 'node-link-chip ' + wifi.className : 'node-link-chip ' + wifi.className;
    return '' +
      '<article class="node-card ' + (info.state === 'stale' ? 'is-offline' : '') + '"' +
      ' data-node-id="' + U.escapeHtml(node.id) + '" tabindex="0" role="button"' +
      ' aria-label="Open details for ' + U.escapeHtml(name) + '">' +
        '<div class="node-card-head">' +
          '<div class="node-avatar">' + U.escapeHtml(shortAddress(node, store)) + '</div>' +
          '<div class="node-title">' +
            '<div class="node-name">' + U.escapeHtml(name) + '</div>' +
            '<div class="node-meta"><span class="mono">' + U.escapeHtml(address) + '</span>' +
              '<span class="dot-sep">·</span><span>' + U.escapeHtml(board) + '</span></div>' +
          '</div>' +
          '<span class="node-status is-' + info.state + '" title="' + U.escapeHtml(info.title) + '">' +
            '<span class="status-dot"></span>' + U.escapeHtml(info.label) + '</span>' +
        '</div>' +
        '<div class="node-metrics">' +
          '<div class="node-metric"><span class="node-metric-label">LoRa RSSI</span>' +
            '<span class="node-metric-value' + (rssi === '—' ? ' is-empty' : '') + '">' + U.escapeHtml(rssi) + '</span></div>' +
          '<div class="node-metric"><span class="node-metric-label">SNR</span>' +
            '<span class="node-metric-value' + (snr === '—' ? ' is-empty' : '') + '">' + U.escapeHtml(snr) + '</span></div>' +
          '<div class="node-metric"><span class="node-metric-label">TX</span>' +
            '<span class="node-metric-value">' + U.escapeHtml(tx) + '</span></div>' +
          '<div class="node-metric"><span class="node-metric-label">RX</span>' +
            '<span class="node-metric-value">' + U.escapeHtml(rx) + '</span></div>' +
        '</div>' +
        '<canvas class="node-spark" data-spark-node="' + U.escapeHtml(node.id) + '" aria-label="Node signal history"></canvas>' +
        alert +
        '<div class="node-card-foot">' +
          '<span class="' + wifiClass + '" title="Wi-Fi is a monitoring link; it is independent of LoRa radio health.">' +
            '<svg class="icon" aria-hidden="true"><use href="#icon-wifi"></use></svg>' + U.escapeHtml(wifi.label) + '</span>' +
          '<span class="node-foot-right"><svg class="icon" aria-hidden="true"><use href="#icon-route"></use></svg>' +
            routeCount + ' route' + (routeCount === 1 ? '' : 's') + '</span>' +
          '<span class="node-foot-right"><svg class="icon" aria-hidden="true"><use href="#icon-clock"></use></svg>' +
            '<span data-time="' + lastSeen + '">' + U.timeAgo(lastSeen) + '</span></span>' +
        '</div>' +
      '</article>';
  };

  UI.prototype._drawSparklines = function (container) {
    var self = this;
    container.querySelectorAll('canvas[data-spark-node]').forEach(function (canvas) {
      var node = self.store.getNode(canvas.dataset.sparkNode);
      if (!node) return;
      var values = [];
      var signalValues = node.history.map(function (sample) { return sample.rssi; })
        .filter(function (value) { return value !== null && value !== undefined; });
      if (signalValues.length >= 2) {
        values = node.history.map(function (sample) { return sample.rssi; });
      } else {
        for (var i = 1; i < node.history.length; i++) {
          var prev = node.history[i - 1];
          var cur = node.history[i];
          if (prev.rx === null || cur.rx === null || cur.rx < prev.rx) values.push(null);
          else values.push(cur.rx - prev.rx);
        }
      }
      Charts.drawSparkline(canvas, values, 'accent');
    });
  };

  UI.prototype._filteredNodes = function () {
    var self = this;
    var search = this.nodeSearch.trim().toLowerCase();
    var nodes = this.store.allNodes().filter(function (node) {
      if (!search) return true;
      var address = U.hexAddr(self.store.nodeAddress(node)).toLowerCase();
      var haystack = [node.id, nodeName(node), node.meta.board || '', node.meta.fw || '', address].join(' ').toLowerCase();
      return haystack.indexOf(search) !== -1;
    });

    var sortKey = this.nodeSort;
    nodes.sort(function (a, b) {
      if (sortKey === 'name') return nodeName(a).localeCompare(nodeName(b));
      if (sortKey === 'lastSeen') return b.lastSeen - a.lastSeen;
      if (sortKey === 'address') {
        return (U.numberOrNull(self.store.nodeAddress(a)) || 0) - (U.numberOrNull(self.store.nodeAddress(b)) || 0);
      }
      if (sortKey === 'rx' || sortKey === 'tx') {
        return (U.numberOrNull(b.metrics[sortKey + '_packets']) || 0) -
               (U.numberOrNull(a.metrics[sortKey + '_packets']) || 0);
      }
      if (sortKey === 'rssi') {
        var ar = U.numberOrNull(a.metrics.lora_rssi);
        var br = U.numberOrNull(b.metrics.lora_rssi);
        if (ar === null) return 1;
        if (br === null) return -1;
        return br - ar;
      }
      return 0;
    });
    return nodes;
  };

  UI.prototype._renderNodesTable = function () {
    var self = this;
    var tbody = byId('nodes-tbody');
    var nodes = this._filteredNodes();
    var empty = byId('nodes-empty');
    if (!nodes.length) {
      tbody.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = nodes.map(function (node) {
      var info = statusInfo(node, self.store);
      var wifi = wifiInfo(node);
      var m = node.metrics || {};
      var address = U.hexAddr(self.store.nodeAddress(node));
      var routes = self.store.nodeRoutes(node).length;
      var wifiCell = '—';
      if (wifi.state === 'up') {
        wifiCell = '<span class="' + (wifi.className === 'is-weak' ? 'status-label is-stale' : 'status-label is-online') + '">' +
          (wifi.rssi === null ? 'up' : Math.round(wifi.rssi) + ' dBm') + '</span>';
      } else if (wifi.state === 'down') {
        wifiCell = '<span class="status-label is-stale" title="Wi-Fi down at last sample; this does not imply LoRa failure.">down</span>';
      }
      return '<tr class="is-clickable" data-node-id="' + U.escapeHtml(node.id) + '">' +
        '<td><div class="cell-node"><span class="mini-avatar">' + U.escapeHtml(shortAddress(node, self.store)) + '</span>' +
          '<span><strong>' + U.escapeHtml(nodeName(node)) + '</strong>' +
          '<small>' + U.escapeHtml(m.fw || node.meta.fw || '') + '</small></span></div></td>' +
        '<td class="mono">' + U.escapeHtml(address) + '</td>' +
        '<td>' + U.escapeHtml(m.board || node.meta.board || '—') + '</td>' +
        '<td><span class="status-label is-' + info.state + '">' + U.escapeHtml(info.label) + '</span></td>' +
        '<td>' + wifiCell + '</td>' +
        '<td class="num">' + U.escapeHtml(formatRssi(m.lora_rssi)) + '</td>' +
        '<td class="num">' + U.escapeHtml(formatSnr(m.lora_snr)) + '</td>' +
        '<td class="num">' + U.escapeHtml(U.formatNumber(m.tx_packets)) + '</td>' +
        '<td class="num">' + U.escapeHtml(U.formatNumber(m.rx_packets)) + '</td>' +
        '<td class="num">' + routes + '</td>' +
        '<td><span data-time="' + (node.lastSeen || 0) + '">' + U.timeAgo(node.lastSeen) + '</span></td>' +
        '<td><span class="muted">Details →</span></td>' +
      '</tr>';
    }).join('');
  };

  UI.prototype._syncEventNodeFilter = function () {
    var select = byId('event-node-filter');
    var nodes = this.store.allNodes().sort(function (a, b) { return nodeName(a).localeCompare(nodeName(b)); });
    var key = nodes.map(function (node) { return node.id; }).join('|');
    if (key === this._eventNodeOptionsKey) return;
    this._eventNodeOptionsKey = key;
    var current = this.eventNode;
    select.innerHTML = '<option value="all">All nodes</option>' + nodes.map(function (node) {
      return '<option value="' + U.escapeHtml(node.id) + '">' + U.escapeHtml(nodeName(node)) + '</option>';
    }).join('');
    select.value = nodes.some(function (node) { return node.id === current; }) ? current : 'all';
    this.eventNode = select.value;
  };

  UI.prototype._renderEvents = function () {
    this._syncEventNodeFilter();
    var self = this;
    var filtered = this.store.events.filter(function (event) {
      if (self.eventNode !== 'all' && event.nodeId !== self.eventNode) return false;
      if (self.eventFilter === 'all') return true;
      return event.category === self.eventFilter;
    });
    var display = filtered.slice(-400).reverse();
    var key = this.eventFilter + '|' + this.eventNode + '|' +
      (this.eventsPaused ? 'paused' : display.length + '|' + (display[0] ? display[0].id : ''));
    if (key === this._eventRenderKey) return;
    this._eventRenderKey = key;

    var list = byId('event-list');
    var empty = byId('events-empty');
    if (!display.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var scrollTop = list.scrollTop;
    list.innerHTML = display.map(function (event) {
      var values = [];
      if (event.src !== null || event.dst !== null) {
        values.push('<span>' + U.escapeHtml(U.hexAddr(event.src)) + ' → ' + U.escapeHtml(U.hexAddr(event.dst)) + '</span>');
      }
      if (event.size !== null) values.push('<span>' + event.size + ' B</span>');
      if (event.type === 'rx' && event.rssi !== null) values.push('<span>' + event.rssi.toFixed(1) + ' dBm</span>');
      if (event.type === 'rx' && event.snr !== null) values.push('<span>' + event.snr.toFixed(1) + ' dB</span>');
      return '<div class="event-row">' +
        '<span class="event-time" title="' + U.escapeHtml(U.formatDateTime(event.receivedAt)) + '">' +
          U.escapeHtml(U.formatTime(event.receivedAt)) + '</span>' +
        '<span class="event-node" title="' + U.escapeHtml(event.nodeName) + '">' + U.escapeHtml(event.nodeName) + '</span>' +
        '<span class="event-badge type-' + U.escapeHtml(event.type) + '">' + U.escapeHtml(event.type) + '</span>' +
        '<span class="event-detail" title="' + U.escapeHtml(event.detail) + '">' + U.escapeHtml(event.detail) + '</span>' +
        '<span class="event-values">' + values.join('') + '</span>' +
      '</div>';
    }).join('');
    list.scrollTop = scrollTop;
  };

  UI.prototype._syncChartNodeSelect = function () {
    var select = byId('chart-node');
    var nodes = this.store.allNodes().sort(function (a, b) { return b.lastSeen - a.lastSeen; });
    var key = nodes.map(function (node) { return node.id; }).join('|');
    if (select.dataset.optionsKey !== key) {
      select.dataset.optionsKey = key;
      select.innerHTML = nodes.map(function (node) {
        return '<option value="' + U.escapeHtml(node.id) + '">' + U.escapeHtml(nodeName(node)) + '</option>';
      }).join('');
    }
    if (!this.chartNodeId || !this.store.getNode(this.chartNodeId)) {
      var withHistory = nodes.find(function (node) { return node.history.length > 1; });
      this.chartNodeId = withHistory ? withHistory.id : (nodes[0] ? nodes[0].id : '');
    }
    if (this.chartNodeId) select.value = this.chartNodeId;
    return this.chartNodeId ? this.store.getNode(this.chartNodeId) : null;
  };

  UI.prototype._renderCharts = function () {
    var node = this._syncChartNodeSelect();
    var empty = byId('charts-empty');
    var grid = byId('chart-grid');
    if (!node || node.history.length < 2) {
      empty.hidden = false;
      grid.hidden = true;
      byId('chart-sample-info').textContent = '0 samples';
      return;
    }
    empty.hidden = true;
    grid.hidden = false;

    var cutoff = Date.now() - this.chartWindow;
    var history = node.history.filter(function (sample) { return sample.t >= cutoff; });
    var rates = ratePoints(node.history, cutoff);
    var xMin = cutoff;
    var xMax = Date.now();
    byId('chart-sample-info').textContent = history.length + ' samples in tab · window ' + Math.round(this.chartWindow / 60000) + ' min';

    var rateSeries = [
      { name: 'TX / s', color: 'blue', points: rates.map(function (row) { return { x: row.t, y: row.tx }; }) },
      { name: 'RX / s', color: 'green', points: rates.map(function (row) { return { x: row.t, y: row.rx }; }) }
    ];
    this.charts.rate.setData(rateSeries, xMin, xMax);

    this.charts.signal.setData([
      { name: 'RSSI (dBm)', color: 'accent', points: seriesPoints(history, 'rssi') },
      { name: 'SNR (dB)', color: 'amber', points: seriesPoints(history, 'snr') }
    ], xMin, xMax);

    this.charts.wifi.setData([
      { name: 'Wi-Fi RSSI (dBm)', color: 'purple', points: seriesPoints(history, 'wifiRssi') }
    ], xMin, xMax);

    this.charts.heap.setData([
      { name: 'Free heap (KB)', color: 'green', points: seriesPoints(history, 'heap', function (value) { return value / 1024; }) }
    ], xMin, xMax);

    var lastRate = rates.length ? rates[rates.length - 1] : null;
    byId('chart-rate-latest').textContent = lastRate
      ? 'TX ' + (lastRate.tx === null ? '—' : lastRate.tx.toFixed(2)) + '/s · RX ' + (lastRate.rx === null ? '—' : lastRate.rx.toFixed(2)) + '/s'
      : '—';
    var lastSignal = latestSample(history);
    byId('chart-signal-latest').textContent = lastSignal
      ? formatRssi(lastSignal.rssi) + ' · ' + formatSnr(lastSignal.snr)
      : '—';
    var lastWifi = latestSample(history);
    var wifi = wifiInfo(node);
    byId('chart-wifi-latest').textContent = lastWifi && lastWifi.wifiRssi !== null
      ? Math.round(lastWifi.wifiRssi) + ' dBm' + (wifi.quality !== null ? ' · ' + Math.round(wifi.quality) + '%' : '')
      : '—';
    byId('chart-heap-latest').textContent = lastWifi && lastWifi.heap !== null
      ? Math.round(lastWifi.heap / 1024) + ' KB'
      : '—';
  };

  function latestSample(history) {
    for (var i = history.length - 1; i >= 0; i--) {
      var sample = history[i];
      if (sample.rssi !== null || sample.snr !== null || sample.wifiRssi !== null || sample.heap !== null) return sample;
    }
    return history.length ? history[history.length - 1] : null;
  }

  UI.prototype.openDrawer = function (nodeId) {
    if (!this.store.getNode(nodeId)) return;
    this.store.selectNode(nodeId);
    this._drawerOpen = true;
    var backdrop = byId('drawer-backdrop');
    var drawer = byId('node-drawer');
    backdrop.hidden = false;
    requestAnimationFrame(function () {
      backdrop.classList.add('is-open');
      drawer.classList.add('is-open');
    });
    drawer.setAttribute('aria-hidden', 'false');
    this._renderDrawer();
  };

  UI.prototype.closeDrawer = function () {
    this._drawerOpen = false;
    var backdrop = byId('drawer-backdrop');
    var drawer = byId('node-drawer');
    backdrop.classList.remove('is-open');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    this.store.selectNode(null);
    setTimeout(function () {
      if (!backdrop.classList.contains('is-open')) backdrop.hidden = true;
    }, 280);
  };

  UI.prototype._renderDrawer = function () {
    var node = this.store.getNode(this.store.selectedNodeId);
    if (!node) {
      this.closeDrawer();
      return;
    }
    var self = this;
    var info = statusInfo(node, this.store);
    var wifi = wifiInfo(node);
    var m = node.metrics || {};
    var routes = this.store.nodeRoutes(node);
    var name = nodeName(node);
    byId('drawer-title').textContent = name;
    byId('drawer-subtitle').textContent = U.hexAddr(this.store.nodeAddress(node)) + ' · ' + (m.board || node.meta.board || 'Unknown board');

    var statusCopy = info.state === 'online'
      ? 'Last MQTT message <span data-time="' + node.lastSeen + '">' + U.timeAgo(node.lastSeen) + '</span>. Monitoring heartbeats are healthy.'
      : 'No MQTT telemetry for <span data-time="' + node.lastSeen + '">' + U.timeAgo(node.lastSeen) + '</span>. This does not prove the LoRa radio or routing failed — the node may still be operating while its Wi-Fi/MQTT link is down.';

    var routeRows = routes.length ? routes.map(function (route) {
      var dest = U.hexAddr(route.dest);
      var isSelf = U.numberOrNull(route.dest) === U.numberOrNull(self.store.nodeAddress(node));
      return '<tr><td class="' + (isSelf ? 'route-self' : '') + '">' + dest + '</td>' +
        '<td>' + U.hexAddr(route.next) + '</td>' +
        '<td>' + U.escapeHtml(route.hops === null || route.hops === undefined ? '—' : route.hops) + '</td>' +
        '<td class="' + (route.valid ? 'route-valid' : 'route-invalid') + '">' + (route.valid ? 'valid' : 'stale') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">No routes reported by this node yet.</td></tr>';

    var recentEvents = node.events.slice(-8).reverse().map(function (event) {
      return '<div class="mini-event"><time>' + U.escapeHtml(U.formatTime(event.receivedAt)) + '</time>' +
        '<span class="mini-badge">' + U.escapeHtml(event.type) + '</span>' +
        '<span class="mini-detail" title="' + U.escapeHtml(event.detail) + '">' + U.escapeHtml(event.detail) + '</span></div>';
    }).join('');

    var rawLogs = '';
    if (this.store.settings.subscribeLogs && node.logs.length) {
      rawLogs = '<section class="drawer-section"><h3>Raw logs</h3><div class="raw-logs">' +
        node.logs.slice(-80).map(function (entry) {
          return U.escapeHtml(U.formatTime(entry.t) + '  ' + entry.line);
        }).join('\n') + '</div></section>';
    }

    var detail = function (label, value, mono) {
      return '<div class="detail-cell"><span>' + U.escapeHtml(label) + '</span><strong class="' +
        (mono ? 'mono' : '') + '">' + value + '</strong></div>';
    };

    byId('drawer-content').innerHTML =
      '<div class="drawer-status ' + (info.state === 'online' ? 'is-online' : '') + '">' +
        '<svg class="icon" aria-hidden="true"><use href="#icon-' + (info.state === 'online' ? 'radio' : 'alert') + '"></use></svg>' +
        '<div><strong>' + (info.state === 'online' ? 'Telemetry online' : 'Telemetry offline') + '</strong>' + statusCopy + '</div>' +
      '</div>' +

      '<section class="drawer-section"><h3>Identity</h3><div class="detail-grid">' +
        detail('Node ID', U.escapeHtml(name), true) +
        detail('LoRa address', U.escapeHtml(U.hexAddr(this.store.nodeAddress(node))), true) +
        detail('Board', U.escapeHtml(m.board || node.meta.board || '—'), false) +
        detail('Firmware', U.escapeHtml(m.fw || node.meta.fw || '—'), true) +
        detail('Uptime', U.escapeHtml(U.duration(m.uptime_s)), true) +
        detail('Last telemetry', '<span data-time="' + node.lastSeen + '">' + U.timeAgo(node.lastSeen) + '</span>', false) +
        detail('Boot ID', U.escapeHtml(m.boot_id !== undefined ? m.boot_id : node.meta.boot_id || '—'), true) +
        detail('Schema', U.escapeHtml(m.schema !== undefined ? 'v' + m.schema : '—'), true) +
      '</div></section>' +

      '<section class="drawer-section"><h3>Monitoring link</h3><div class="detail-grid">' +
        detail('Wi-Fi', U.escapeHtml(wifi.state === 'up' ? 'Connected' : wifi.state === 'down' ? 'Down at last sample' : 'Unknown'), false) +
        detail('Wi-Fi RSSI', U.escapeHtml(wifi.rssi === null ? '—' : Math.round(wifi.rssi) + ' dBm'), true) +
        detail('Wi-Fi quality', U.escapeHtml(wifi.quality === null ? '—' : Math.round(wifi.quality) + '%'), true) +
        detail('IP address', U.escapeHtml(m.ip || node.status.ip || '—'), true) +
        detail('Wi-Fi channel', U.escapeHtml(m.wifi_channel !== undefined ? m.wifi_channel : '—'), true) +
        detail('SSID', U.escapeHtml(m.wifi_ssid || '—'), false) +
        detail('MQTT connects', U.escapeHtml(U.formatNumber(m.mqtt_connects)), true) +
        detail('MQTT failures', U.escapeHtml(U.formatNumber(m.mqtt_failures)), true) +
        detail('MQTT drops', U.escapeHtml(U.formatNumber(m.mqtt_disconnects)), true) +
        detail('Wi-Fi drops', U.escapeHtml(U.formatNumber(m.wifi_disconnects)), true) +
        detail('Publish failures', U.escapeHtml(U.formatNumber(m.publish_failures)), true) +
        detail('Free heap', m.free_heap !== undefined ? U.escapeHtml(Math.round(m.free_heap / 1024) + ' KB') : '—', true) +
      '</div></section>' +

      '<section class="drawer-section"><h3>LoRa telemetry</h3><div class="detail-grid">' +
        detail('TX packets', U.escapeHtml(U.formatNumber(m.tx_packets)), true) +
        detail('RX packets', U.escapeHtml(U.formatNumber(m.rx_packets)), true) +
        detail('TX errors', U.escapeHtml(U.formatNumber(m.tx_errors)), true) +
        detail('RX errors', U.escapeHtml(U.formatNumber(m.rx_errors)), true) +
        detail('Last RSSI', U.escapeHtml(formatRssi(m.lora_rssi)), true) +
        detail('Last SNR', U.escapeHtml(formatSnr(m.lora_snr)), true) +
        detail('Last activity', m.last_activity_ago_s === undefined || m.last_activity_ago_s < 0 ? '—' : U.escapeHtml(U.duration(m.last_activity_ago_s)), true) +
        detail('Last source', U.escapeHtml(U.hexAddr(m.last_src)), true) +
        detail('Last destination', U.escapeHtml(U.hexAddr(m.last_dst)), true) +
        detail('Network manager', U.escapeHtml(U.hexAddr(m.network_manager)), true) +
        detail('Network state', U.escapeHtml(m.network_state !== undefined ? m.network_state : '—'), true) +
        detail('Routes', String(routes.length), true) +
      '</div></section>' +

      '<section class="drawer-section"><h3>Routing table</h3><div class="table-scroll"><table class="route-table">' +
        '<thead><tr><th>Destination</th><th>Next hop</th><th>Hops</th><th>State</th></tr></thead><tbody>' +
        routeRows + '</tbody></table></div></section>' +

      '<section class="drawer-section"><h3>Recent events</h3><div class="mini-events">' +
        (recentEvents || '<span class="muted">No events received yet.</span>') + '</div></section>' +
      rawLogs +
      '<div class="drawer-section"><button class="btn btn-ghost btn-sm" type="button" id="drawer-copy-json">' +
        '<svg class="icon" aria-hidden="true"><use href="#icon-copy"></use></svg> Copy node JSON</button></div>';

    var copyButton = byId('drawer-copy-json');
    if (copyButton) {
      copyButton.addEventListener('click', function () {
        U.copyText(JSON.stringify({
          id: node.id,
          meta: node.meta,
          status: node.status,
          metrics: node.metrics,
          last_seen: node.lastSeen ? new Date(node.lastSeen).toISOString() : null
        }, null, 2)).then(function () {
          self.toast('Node JSON copied.', 'success');
        }).catch(function () {
          self.toast('Could not access the clipboard.', 'error');
        });
      });
    }
  };

  UI.prototype.toggleTheme = function () {
    var root = document.documentElement;
    var next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
    var self = this;
    requestAnimationFrame(function () {
      Object.keys(self.charts).forEach(function (key) { self.charts[key].redraw(); });
    });
  };

  UI.prototype.openSettings = function () {
    var settings = this.store.settings;
    byId('broker-url').value = settings.brokerUrl;
    byId('topic-prefix').value = settings.topicPrefix;
    byId('mqtt-username').value = settings.username || '';
    byId('mqtt-password').value = settings.password || '';
    byId('subscribe-logs').checked = Boolean(settings.subscribeLogs);
    byId('broker-preset').value = '';
    var preset = byId('broker-preset');
    Array.prototype.forEach.call(preset.options, function (option) {
      if (option.value && option.value === settings.brokerUrl) preset.value = option.value;
    });
    byId('prefix-preview').textContent = settings.topicPrefix + '/+/metrics';
    byId('settings-error').hidden = true;
    var status = this.store.connection.status;
    byId('settings-disconnect').disabled = status === 'idle' || status === 'disconnected';
    var dialog = byId('settings-dialog');
    if (!dialog.open) dialog.showModal();
  };

  UI.prototype.closeSettings = function () {
    var dialog = byId('settings-dialog');
    if (dialog.open) dialog.close();
  };

  UI.prototype._submitSettings = function () {
    var settings = {
      brokerUrl: CFG.normalizeBrokerUrl(byId('broker-url').value),
      topicPrefix: CFG.sanitizePrefix(byId('topic-prefix').value),
      username: byId('mqtt-username').value.trim(),
      password: byId('mqtt-password').value,
      subscribeLogs: byId('subscribe-logs').checked
    };
    var error = CFG.validateSettings(settings);
    if (error) {
      var box = byId('settings-error');
      box.textContent = error;
      box.hidden = false;
      return;
    }
    this.closeSettings();
    if (this.callbacks.onConnect) this.callbacks.onConnect(settings);
  };

  UI.prototype._copySnippet = function (button) {
    var block = button.closest('.code-block');
    if (!block) return;
    var code = block.querySelector('code');
    if (!code) return;
    var self = this;
    U.copyText(code.textContent).then(function () {
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = old; }, 1400);
      self.toast('Snippet copied.', 'success');
    }).catch(function () {
      self.toast('Could not access the clipboard.', 'error');
    });
  };

  UI.prototype.tick = function () {
    this._tick++;
    var clock = byId('overview-clock');
    if (clock) clock.textContent = U.formatTime(Date.now());
    document.querySelectorAll('[data-time]').forEach(function (element) {
      var value = Number(element.dataset.time || 0);
      var next = U.timeAgo(value);
      if (element.textContent !== next) element.textContent = next;
    });
    // Re-evaluate stale/online transitions even without new MQTT messages.
    if (this._tick % 10 === 0) this.scheduleRender();
  };

  UI.prototype.toast = function (message, type, duration) {
    var stack = byId('toast-stack');
    if (!stack) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'info');
    var icon = type === 'error' || type === 'warn' ? 'alert' : type === 'success' ? 'radio' : 'activity';
    toast.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-' + icon + '"></use></svg>' +
      '<span></span>';
    toast.querySelector('span').textContent = message;
    stack.appendChild(toast);
    var timeout = duration || (type === 'error' ? 6500 : 3800);
    setTimeout(function () {
      toast.classList.add('is-leaving');
      setTimeout(function () {
        if (toast.parentElement) toast.parentElement.removeChild(toast);
      }, 240);
    }, timeout);
  };

  global.LoRaMonitor.UI = UI;
})(window);
