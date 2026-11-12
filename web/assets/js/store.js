/* =========================================================================
   LoRaMesh Monitor — in-memory telemetry store
   ========================================================================= */
(function (global) {
  'use strict';

  var CFG = global.LoRaMonitor.config;
  var U = global.LoRaMonitor.utils;

  function createNode(id) {
    return {
      id: id,
      meta: { node_id: id },
      status: {},
      metrics: {},
      lastSeen: 0,
      lastMetricsAt: 0,
      lastStatusAt: 0,
      lastEventAt: 0,
      monitoringOnline: null,
      monitoringReason: '',
      bootId: null,
      history: [],
      events: [],
      logs: []
    };
  }

  function firstValue(object, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = object[keys[i]];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }

  function eventCategory(type) {
    switch (type) {
      case 'tx':
      case 'rx':
        return 'packets';
      case 'route_add':
      case 'route_remove':
        return 'routing';
      case 'network':
        return 'network';
      case 'error':
        return 'errors';
      case 'monitor':
        return 'monitor';
      default:
        return 'other';
    }
  }

  function MonitorStore(settings) {
    this.settings = settings;
    this.nodes = new Map();
    this.events = [];
    this.connection = {
      status: 'idle',
      detail: '',
      brokerUrl: settings ? settings.brokerUrl : '',
      attempts: 0,
      connectedAt: 0,
      error: ''
    };
    this.selectedNodeId = null;
    this.listeners = new Set();
    this._notifyTimer = null;
    this._pendingImmediate = false;
  }

  MonitorStore.prototype.subscribe = function (listener) {
    this.listeners.add(listener);
    var self = this;
    return function () { self.listeners.delete(listener); };
  };

  MonitorStore.prototype._emit = function () {
    var self = this;
    this.listeners.forEach(function (listener) {
      try { listener(self); } catch (err) { console.error(err); }
    });
  };

  MonitorStore.prototype.notify = function (immediate) {
    if (immediate) {
      if (this._notifyTimer) {
        clearTimeout(this._notifyTimer);
        this._notifyTimer = null;
      }
      this._emit();
      return;
    }
    if (this._notifyTimer) return;
    var self = this;
    this._notifyTimer = setTimeout(function () {
      self._notifyTimer = null;
      self._emit();
    }, 120);
  };

  MonitorStore.prototype.setSettings = function (settings) {
    this.settings = settings;
    this.notify(true);
  };

  MonitorStore.prototype.setConnection = function (patch) {
    Object.assign(this.connection, patch);
    this.notify(true);
  };

  MonitorStore.prototype.ensureNode = function (nodeId) {
    var id = U.text(nodeId).trim();
    if (!id) id = 'unknown';
    var node = this.nodes.get(id);
    if (!node) {
      node = createNode(id);
      this.nodes.set(id, node);
    }
    return node;
  };

  MonitorStore.prototype._mergeMeta = function (node, payload, now) {
    if (!payload || typeof payload !== 'object') return;
    var meta = node.meta;
    if (payload.node_id) meta.node_id = U.text(payload.node_id);
    if (payload.board) meta.board = U.text(payload.board);
    if (payload.fw) meta.fw = U.text(payload.fw);
    if (payload.schema !== undefined) meta.schema = payload.schema;
    if (payload.lora_addr !== undefined) meta.lora_addr = payload.lora_addr;
    if (payload.lora_addr_hex) meta.lora_addr_hex = payload.lora_addr_hex;
    if (payload.boot_id !== undefined) {
      var nextBoot = U.text(payload.boot_id);
      if (node.bootId !== null && node.bootId !== nextBoot) {
        node.history = [];
        node.events = [];
        node.logs = [];
      }
      node.bootId = nextBoot;
      meta.boot_id = payload.boot_id;
    }
    meta.last_message_at = now;
  };

  MonitorStore.prototype.ingestStatus = function (nodeId, payload) {
    if (!payload || typeof payload !== 'object') return;
    var node = this.ensureNode(nodeId);
    var now = Date.now();
    this._mergeMeta(node, payload, now);

    node.status = Object.assign({}, node.status, payload);
    node.lastStatusAt = now;
    node.lastSeen = now;

    if (payload.online === false) {
      node.monitoringOnline = false;
      node.monitoringReason = 'lwt';
    } else {
      node.monitoringOnline = true;
      node.monitoringReason = 'status';
    }
    this.notify();
  };

  MonitorStore.prototype.ingestMetrics = function (nodeId, payload) {
    if (!payload || typeof payload !== 'object') return;
    var node = this.ensureNode(nodeId);
    var now = Date.now();
    this._mergeMeta(node, payload, now);

    node.metrics = payload;
    node.lastMetricsAt = now;
    node.lastSeen = now;
    node.monitoringOnline = true;
    node.monitoringReason = 'metrics';

    var sample = {
      t: now,
      tx: U.numberOrNull(payload.tx_packets),
      rx: U.numberOrNull(payload.rx_packets),
      rssi: U.numberOrNull(payload.lora_rssi),
      snr: U.numberOrNull(payload.lora_snr),
      wifiRssi: payload.wifi_connected === true ? U.numberOrNull(payload.wifi_rssi) : null,
      wifiQuality: payload.wifi_connected === true ? U.numberOrNull(payload.wifi_quality) : null,
      heap: U.numberOrNull(payload.free_heap)
    };

    var history = node.history;
    var latest = history.length ? history[history.length - 1] : null;
    if (latest && now - latest.t < 500) {
      history[history.length - 1] = sample;
    } else {
      history.push(sample);
      if (history.length > CFG.MAX_HISTORY) history.splice(0, history.length - CFG.MAX_HISTORY);
    }
    this.notify();
  };

  MonitorStore.prototype.ingestEvent = function (nodeId, payload) {
    if (!payload || typeof payload !== 'object') return;
    var node = this.ensureNode(nodeId);
    var now = Date.now();
    this._mergeMeta(node, payload, now);

    var type = U.text(payload.event).toLowerCase() || 'event';
    var event = {
      id: now + '-' + Math.random().toString(36).slice(2, 7),
      nodeId: node.id,
      nodeName: U.text(payload.node_id) || node.meta.node_id || node.id,
      type: type,
      category: eventCategory(type),
      detail: U.text(payload.detail) || type,
      deviceMs: U.numberOrNull(payload.device_ms),
      src: U.numberOrNull(payload.src),
      dst: U.numberOrNull(payload.dst),
      size: U.numberOrNull(payload.size),
      msgType: U.numberOrNull(payload.msg_type),
      rssi: U.numberOrNull(payload.lora_rssi),
      snr: U.numberOrNull(payload.lora_snr),
      receivedAt: now
    };

    node.events.push(event);
    if (node.events.length > CFG.MAX_NODE_EVENTS) {
      node.events.splice(0, node.events.length - CFG.MAX_NODE_EVENTS);
    }
    node.lastEventAt = now;
    node.lastSeen = now;
    node.monitoringOnline = true;
    node.monitoringReason = 'event';

    this.events.push(event);
    if (this.events.length > CFG.MAX_EVENTS) {
      this.events.splice(0, this.events.length - CFG.MAX_EVENTS);
    }
    this.notify();
  };

  MonitorStore.prototype.ingestLog = function (nodeId, line) {
    var node = this.ensureNode(nodeId);
    var now = Date.now();
    node.logs.push({ t: now, line: U.text(line) });
    if (node.logs.length > CFG.MAX_LOGS) {
      node.logs.splice(0, node.logs.length - CFG.MAX_LOGS);
    }
    node.lastSeen = now;
    node.monitoringOnline = true;
    node.monitoringReason = 'log';
    this.notify();
  };

  MonitorStore.prototype.selectNode = function (nodeId) {
    this.selectedNodeId = nodeId || null;
    this.notify(true);
  };

  MonitorStore.prototype.getNode = function (nodeId) {
    return this.nodes.get(nodeId) || null;
  };

  MonitorStore.prototype.allNodes = function () {
    return Array.from(this.nodes.values());
  };

  MonitorStore.prototype.isMonitoringOnline = function (node, now) {
    if (!node) return false;
    var current = now || Date.now();
    if (node.monitoringOnline === false) return false;
    if (!node.lastSeen) return false;
    return current - node.lastSeen < CFG.STALE_MS;
  };

  MonitorStore.prototype.nodeState = function (node, now) {
    if (!node.lastSeen) return 'unknown';
    if (node.monitoringOnline === false) return 'stale';
    return this.isMonitoringOnline(node, now) ? 'online' : 'stale';
  };

  MonitorStore.prototype.nodeAddress = function (node) {
    if (!node) return null;
    var raw = firstValue(node.meta, ['lora_addr', 'lora_addr_hex']);
    if (raw === null) raw = firstValue(node.metrics, ['lora_addr', 'lora_addr_hex']);
    if (raw === null) raw = firstValue(node.status, ['lora_addr', 'lora_addr_hex']);
    return raw;
  };

  MonitorStore.prototype.nodeRoutes = function (node) {
    if (!node || !node.metrics || !Array.isArray(node.metrics.routes)) return [];
    return node.metrics.routes;
  };

  MonitorStore.prototype.totals = function () {
    var self = this;
    var now = Date.now();
    var totals = {
      nodes: 0,
      online: 0,
      stale: 0,
      tx: 0,
      rx: 0,
      errors: 0,
      routes: 0,
      wifiDown: 0
    };
    this.nodes.forEach(function (node) {
      totals.nodes++;
      if (self.isMonitoringOnline(node, now)) totals.online++;
      else totals.stale++;
      var m = node.metrics || {};
      totals.tx += U.numberOrNull(m.tx_packets) || 0;
      totals.rx += U.numberOrNull(m.rx_packets) || 0;
      totals.errors += (U.numberOrNull(m.tx_errors) || 0) +
                       (U.numberOrNull(m.rx_errors) || 0) +
                       (U.numberOrNull(m.publish_failures) || 0);
      totals.routes += self.nodeRoutes(node).length;
      if (m.wifi_connected === false) totals.wifiDown++;
    });
    return totals;
  };

  MonitorStore.prototype.clearEvents = function () {
    this.events = [];
    this.nodes.forEach(function (node) { node.events = []; });
    this.notify(true);
  };

  MonitorStore.prototype.exportData = function () {
    var self = this;
    return {
      exported_at: new Date().toISOString(),
      broker: this.settings ? this.settings.brokerUrl : '',
      topic_prefix: this.settings ? this.settings.topicPrefix : '',
      nodes: this.allNodes().map(function (node) {
        return {
          id: node.id,
          meta: node.meta,
          status: node.status,
          last_seen: node.lastSeen ? new Date(node.lastSeen).toISOString() : null,
          metrics: node.metrics,
          history: node.history
        };
      }),
      events: this.events
    };
  };

  global.LoRaMonitor.Store = MonitorStore;
  global.LoRaMonitor.eventCategory = eventCategory;
})(window);
