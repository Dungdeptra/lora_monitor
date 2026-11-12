/* =========================================================================
   LoRaMesh Monitor — MQTT over WebSocket client
   ========================================================================= */
(function (global) {
  'use strict';

  var U = global.LoRaMonitor.utils;

  function randomId() {
    var suffix = Math.random().toString(36).slice(2, 10);
    return 'loramesh-web-' + suffix;
  }

  function MqttBridge(store) {
    this.store = store;
    this.client = null;
    this.manualClose = false;
    this.connectedOnce = false;
    this.stats = { messages: 0, invalid: 0 };
  }

  MqttBridge.prototype.topics = function () {
    var prefix = this.store.settings.topicPrefix;
    var topics = [
      prefix + '/+/status',
      prefix + '/+/metrics',
      prefix + '/+/events'
    ];
    if (this.store.settings.subscribeLogs) {
      topics.push(prefix + '/+/logs');
    }
    return topics;
  };

  MqttBridge.prototype.connect = function (settings) {
    this.disconnect(true);
    this.manualClose = false;

    if (!global.mqtt || typeof global.mqtt.connect !== 'function') {
      this.store.setConnection({
        status: 'error',
        detail: 'MQTT.js failed to load',
        error: 'The bundled MQTT library is missing. Check assets/vendor/mqtt.min.js.'
      });
      return;
    }

    var brokerUrl = settings.brokerUrl;
    var options = {
      clientId: randomId(),
      clean: true,
      keepalive: 30,
      connectTimeout: 12000,
      reconnectPeriod: 4000,
      protocolVersion: 4,
      resubscribe: true
    };
    if (settings.username) options.username = settings.username;
    if (settings.password) options.password = settings.password;

    this.store.setConnection({
      status: 'connecting',
      detail: 'Opening WebSocket…',
      brokerUrl: brokerUrl,
      attempts: 0,
      connectedAt: 0,
      error: ''
    });

    var self = this;
    var client;
    try {
      client = global.mqtt.connect(brokerUrl, options);
    } catch (err) {
      this.store.setConnection({
        status: 'error',
        detail: 'Invalid broker URL',
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
    this.client = client;

    client.on('connect', function () {
      self.connectedOnce = true;
      self.store.setConnection({
        status: 'connected',
        detail: 'Subscribed to ' + settings.topicPrefix + '/+/…',
        attempts: 0,
        connectedAt: Date.now(),
        error: ''
      });
      client.subscribe(self.topics(), { qos: 0 }, function (err) {
        if (err) {
          self.store.setConnection({
            status: 'error',
            detail: 'Subscription failed',
            error: err.message || String(err)
          });
        }
      });
    });

    client.on('reconnect', function () {
      if (self.manualClose) return;
      var connection = self.store.connection;
      self.store.setConnection({
        status: 'reconnecting',
        detail: 'Reconnecting to broker…',
        attempts: (connection.attempts || 0) + 1
      });
    });

    client.on('offline', function () {
      if (self.manualClose) return;
      self.store.setConnection({
        status: 'reconnecting',
        detail: 'Broker unreachable · retrying'
      });
    });

    client.on('close', function () {
      if (self.manualClose) return;
      if (self.store.connection.status !== 'error') {
        self.store.setConnection({
          status: 'reconnecting',
          detail: 'Connection closed · retrying'
        });
      }
    });

    client.on('error', function (err) {
      if (self.manualClose) return;
      self.store.setConnection({
        status: 'error',
        detail: 'MQTT error',
        error: err && err.message ? err.message : String(err)
      });
    });

    client.on('message', function (topic, payload) {
      self._handleMessage(topic, payload);
    });
  };

  MqttBridge.prototype._handleMessage = function (topic, payload) {
    this.stats.messages++;
    var prefix = this.store.settings.topicPrefix + '/';
    if (topic.indexOf(prefix) !== 0) return;
    var rest = topic.slice(prefix.length);
    var parts = rest.split('/');
    if (parts.length < 2) return;
    var kind = parts.pop();
    var nodeId = parts.pop();
    if (!nodeId || nodeId === '+' || nodeId.charAt(0) === '$') return;

    if (kind === 'logs') {
      this.store.ingestLog(nodeId, payload.toString());
      return;
    }
    if (kind !== 'status' && kind !== 'metrics' && kind !== 'events') return;

    var parsed;
    try {
      parsed = JSON.parse(payload.toString());
    } catch (err) {
      this.stats.invalid++;
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    if (kind === 'status') this.store.ingestStatus(nodeId, parsed);
    else if (kind === 'metrics') this.store.ingestMetrics(nodeId, parsed);
    else this.store.ingestEvent(nodeId, parsed);
  };

  MqttBridge.prototype.disconnect = function (silent) {
    this.manualClose = true;
    if (this.client) {
      try { this.client.end(true); } catch (err) { /* already closed */ }
      this.client = null;
    }
    if (!silent) {
      this.store.setConnection({
        status: 'disconnected',
        detail: 'Disconnected',
        connectedAt: 0
      });
    }
  };

  MqttBridge.prototype.isConnected = function () {
    return Boolean(this.client && this.client.connected);
  };

  global.LoRaMonitor.MqttBridge = MqttBridge;
})(window);
