/* =========================================================================
   LoRaMesh Monitor — configuration and small shared helpers
   ========================================================================= */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'loramesh.monitor.settings.v1';
  var VERSION = '2.1.0';
  var STALE_MS = 45000;
  var MAX_HISTORY = 900;
  var MAX_EVENTS = 800;
  var MAX_NODE_EVENTS = 220;
  var MAX_LOGS = 140;

  var DEFAULTS = {
    brokerUrl: 'wss://broker.emqx.io:8084/mqtt',
    topicPrefix: 'loramesh',
    username: '',
    password: '',
    subscribeLogs: false
  };

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function sanitizePrefix(value) {
    var input = text(value).trim();
    var out = '';
    for (var i = 0; i < input.length && out.length < 32; i++) {
      var c = input.charAt(i);
      if (/[A-Za-z0-9_-]/.test(c)) out += c;
      else if (/[\s/:.@#$%^&*()+=[\]{};,'"\\|<>?]/.test(c)) out += '_';
    }
    return out || 'loramesh';
  }

  function normalizeBrokerUrl(value) {
    var url = text(value).trim();
    if (!url) return '';
    if (!/^wss?:\/\//i.test(url)) {
      url = 'wss://' + url;
    }
    return url.replace(/\/+$/, '');
  }

  function loadSettings() {
    var settings = Object.assign({}, DEFAULTS);
    try {
      var stored = global.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          settings.brokerUrl = normalizeBrokerUrl(parsed.brokerUrl || settings.brokerUrl);
          settings.topicPrefix = sanitizePrefix(parsed.topicPrefix || settings.topicPrefix);
          settings.username = text(parsed.username);
          settings.password = text(parsed.password);
          settings.subscribeLogs = Boolean(parsed.subscribeLogs);
        }
      }
    } catch (err) {
      /* localStorage can be unavailable in private/embedded contexts. */
    }

    try {
      var params = new URLSearchParams(global.location.search);
      if (params.has('broker')) settings.brokerUrl = normalizeBrokerUrl(params.get('broker'));
      if (params.has('prefix')) settings.topicPrefix = sanitizePrefix(params.get('prefix'));
      if (params.get('logs') === '1') settings.subscribeLogs = true;
    } catch (err) {
      /* ignore malformed query strings */
    }
    return settings;
  }

  function saveSettings(settings) {
    var clean = {
      brokerUrl: normalizeBrokerUrl(settings.brokerUrl),
      topicPrefix: sanitizePrefix(settings.topicPrefix),
      username: text(settings.username),
      password: text(settings.password),
      subscribeLogs: Boolean(settings.subscribeLogs)
    };
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch (err) {
      /* non-fatal */
    }
    return clean;
  }

  function validateSettings(settings) {
    var broker = normalizeBrokerUrl(settings && settings.brokerUrl);
    if (!broker) return 'Enter an MQTT WebSocket URL.';
    if (!/^wss?:\/\/[^\s]+$/i.test(broker)) return 'The broker URL must start with ws:// or wss://.';
    if (global.location.protocol === 'https:' && /^ws:\/\//i.test(broker)) {
      return 'This page is served over HTTPS. Browsers block plain ws:// as mixed content; use wss:// instead.';
    }
    var prefix = sanitizePrefix(settings && settings.topicPrefix);
    if (!prefix) return 'Enter a topic prefix.';
    return '';
  }

  function numberOrNull(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      var n = Number(value);
      if (isFinite(n)) return n;
    }
    return null;
  }

  function hexAddr(value) {
    var n = numberOrNull(value);
    if (n === null) return '—';
    var s = Math.max(0, Math.round(n)).toString(16).toUpperCase();
    while (s.length < 4) s = '0' + s;
    return '0x' + s;
  }

  function formatNumber(value) {
    var n = numberOrNull(value);
    if (n === null) return '—';
    return n.toLocaleString('en-US');
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatTime(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatDateTime(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString() + ' ' + formatTime(ms);
  }

  function timeAgo(ms) {
    var value = numberOrNull(ms);
    if (value === null || value <= 0) return 'never';
    var delta = Date.now() - value;
    if (delta < 0) delta = 0;
    var seconds = Math.round(delta / 1000);
    if (seconds < 3) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  function duration(seconds) {
    var n = numberOrNull(seconds);
    if (n === null || n < 0) return '—';
    n = Math.floor(n);
    var d = Math.floor(n / 86400);
    var h = Math.floor((n % 86400) / 3600);
    var m = Math.floor((n % 3600) / 60);
    var s = n % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function signalClass(rssi) {
    var n = numberOrNull(rssi);
    if (n === null) return '';
    if (n >= -67) return 'is-good';
    if (n >= -80) return 'is-fair';
    return 'is-weak';
  }

  function copyText(value) {
    if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
      return global.navigator.clipboard.writeText(value);
    }
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) resolve();
        else reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.LoRaMonitor = global.LoRaMonitor || {};
  global.LoRaMonitor.config = {
    VERSION: VERSION,
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    STALE_MS: STALE_MS,
    MAX_HISTORY: MAX_HISTORY,
    MAX_EVENTS: MAX_EVENTS,
    MAX_NODE_EVENTS: MAX_NODE_EVENTS,
    MAX_LOGS: MAX_LOGS,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    validateSettings: validateSettings,
    sanitizePrefix: sanitizePrefix,
    normalizeBrokerUrl: normalizeBrokerUrl
  };

  global.LoRaMonitor.utils = {
    text: text,
    numberOrNull: numberOrNull,
    hexAddr: hexAddr,
    formatNumber: formatNumber,
    formatTime: formatTime,
    formatDateTime: formatDateTime,
    timeAgo: timeAgo,
    duration: duration,
    escapeHtml: escapeHtml,
    signalClass: signalClass,
    copyText: copyText,
    download: download
  };
})(window);
