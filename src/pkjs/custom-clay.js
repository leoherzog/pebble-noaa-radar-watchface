// Runs inside the generated Clay config page, not in pkjs: Clay injects this
// function by calling .toString() on it, so require() and everything else in
// this file's scope are unavailable in there — the function body must be
// self-contained (see "Custom Function" in Clay's README).
module.exports = function (minified) {
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

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    var gps = clayConfig.getItemByMessageKey('UseGps');
    var loc = clayConfig.getItemByMessageKey('ManualLoc');
    var err = clayConfig.getItemById('ManualLocError');
    var submit = clayConfig.getItemsByType('submit')[0];

    // Validation is enforced by disabling Save, not by intercepting submit:
    // the page's own submit handler (config-page.js) is registered before
    // this function runs and navigates to pebblejs://close unconditionally,
    // so a second submit listener could not stop it.
    function refresh() {
      if (gps.get()) {
        loc.hide();
        err.hide();
        submit.enable();
        return;
      }
      loc.show();
      if (parseLoc(loc.get())) {
        err.hide();
        submit.enable();
      } else {
        err.show();
        submit.disable();
      }
    }

    gps.on('change', refresh);
    // 'input' for per-keystroke feedback; 'change' (fires on blur) as the
    // safety net for runtimes that do not deliver 'input' events.
    loc.on('change input', refresh);
    refresh();
  });
};
