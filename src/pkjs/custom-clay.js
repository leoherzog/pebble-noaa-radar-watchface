// Runs inside the generated Clay config page, not in pkjs: Clay injects this
// function by calling .toString() on it, so require() and everything else in
// this file's scope are unavailable in there: the function body must be
// self-contained (see "Custom Function" in Clay's README).
module.exports = function () {
  var clayConfig = this;

  // Must stay in sync with parseManualLoc() in index.js, which cannot be
  // shared for the toString() reason above. Accepts "lat, lon" or "lat lon"
  // in decimal degrees and checks the ranges.
  function parseLoc(s) {
    var m = /^\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*$/
              .exec(String(s || ''));
    if (!m) return null;
    var lat = parseFloat(m[1]);
    var lon = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat: lat, lon: lon };
  }

  // Clay's capability filter dereferences activeWatchInfo, so on a runtime
  // that supplies none the first gated item throws and the page never builds.
  // Keep every platform's items but chalk's instead; the watch still clamps.
  if (!clayConfig.meta.activeWatchInfo) {
    (function ungate(items) {
      for (var i = items.length - 1; i >= 0; i--) {
        var caps = items[i].capabilities || [];
        if (caps.indexOf('PLATFORM_CHALK') >= 0) {
          items.splice(i, 1);
          continue;
        }
        if (caps.indexOf('NOT_PLATFORM_CHALK') >= 0) delete items[i].capabilities;
        if (items[i].items) ungate(items[i].items);
      }
    })(clayConfig.config);
  }

  // chalk's outer size dropdowns stop at Small. A size saved or reported by the
  // watch that a select lacks leaves it blank, and a blank saves as 0 (Extra
  // Small), so show its clamp: fixed to Small, auto to Small, shrink to fit.
  var CHALK_OUTER_CLAMP = { '2': '1', '3': '1', '4': '1', '10': '1',
                            '7': '6', '8': '6', '9': '6', '11': '6' };

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    var saved = window.claySettings || {};
    ['TopFont1', 'BottomFont2'].forEach(function (key) {
      var size = clayConfig.getItemByMessageKey(key);
      var to = CHALK_OUTER_CLAMP[String(saved[key])];
      if (size && to && size.get() !== String(saved[key])) size.set(to);
    });

    var gps = clayConfig.getItemByMessageKey('UseGps');
    var loc = clayConfig.getItemByMessageKey('ManualLoc');
    var err = clayConfig.getItemById('ManualLocError');
    var submit = clayConfig.getItemsByType('submit')[0];

    // Validation is enforced by disabling Save, not by intercepting submit:
    // the page's own submit handler (config-page.js) is registered before
    // this function runs and navigates to pebblejs://close unconditionally,
    // so a second submit listener could not stop it.
    function refresh() {
      var gpsOn = gps.get();
      var ok = gpsOn || parseLoc(loc.get());
      if (gpsOn) loc.hide(); else loc.show();
      if (ok) { err.hide(); submit.enable(); }
      else { err.show(); submit.disable(); }
    }

    gps.on('change', refresh);
    // 'input' for per-keystroke feedback; 'change' (fires on blur) as the
    // safety net for runtimes that do not deliver 'input' events.
    loc.on('change input', refresh);
    refresh();
  });
};
