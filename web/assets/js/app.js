/* =========================================================================
   LoRaMesh Monitor — application bootstrap
   ========================================================================= */
(function (global) {
  'use strict';

  var CFG = global.LoRaMonitor.config;
  var U = global.LoRaMonitor.utils;

  function currentView() {
    var hash = (global.location.hash || '#overview').replace(/^#/, '');
    return ['overview', 'nodes', 'events', 'charts', 'guide'].indexOf(hash) !== -1 ? hash : 'overview';
  }

  function applyStoredTheme() {
    try {
      var theme = global.localStorage.getItem('loramesh.monitor.theme');
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    } catch (err) { /* ignore */ }
  }

  function boot() {
    applyStoredTheme();

    var settings = CFG.loadSettings();
    var store = new global.LoRaMonitor.Store(settings);
    var bridge = new global.LoRaMonitor.MqttBridge(store);

    var ui = new global.LoRaMonitor.UI(store, bridge, {
      onConnect: function (nextSettings) {
        var clean = CFG.saveSettings(nextSettings);
        store.setSettings(clean);
        connect(clean);
        ui.toast('Connecting to ' + clean.brokerUrl, 'info');
      },
      onDisconnect: function () {
        bridge.disconnect(false);
        ui.toast('Disconnected from the broker.', 'info');
      }
    });

    var lastStatus = store.connection.status;
    store.subscribe(function () {
      var status = store.connection.status;
      if (status !== lastStatus) {
        if (status === 'connected' && lastStatus !== 'idle') {
          ui.toast('Connected. Listening for node telemetry.', 'success');
        } else if (status === 'reconnecting' && lastStatus === 'connected') {
          ui.toast('Broker connection lost. Telemetry may be stale.', 'warn');
        } else if (status === 'error') {
          ui.toast(store.connection.error || store.connection.detail || 'MQTT connection error.', 'error');
        }
        lastStatus = status;
      }
      ui.scheduleRender();
    });

    global.addEventListener('hashchange', function () {
      ui.setView(currentView());
    });

    ui.setView(currentView());
    connect(settings);

    setInterval(function () { ui.tick(); }, 1000);
    global.addEventListener('beforeunload', function () { bridge.disconnect(true); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) ui.tick();
    });

    function connect(config) {
      var error = CFG.validateSettings(config);
      if (error) {
        store.setConnection({
          status: 'error',
          detail: 'Configuration problem',
          error: error,
          brokerUrl: config.brokerUrl
        });
        ui.openSettings();
        return;
      }
      bridge.connect(config);
    }

    // Debug handle for the browser console; harmless in production.
    global.LoRaMonitor.app = {
      store: store,
      bridge: bridge,
      ui: ui,
      version: CFG.VERSION,
      reconnect: function () { connect(store.settings); },
      exportData: function () { return store.exportData(); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
