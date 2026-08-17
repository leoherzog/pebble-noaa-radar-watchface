// All four slot dropdowns and all four size dropdowns offer identical choices,
// so they share one array each. That is safe because the options array is only
// ever read: a select's state is its own value, never anything stored in options.
var SLOT_OPTIONS = [
  { "label": "Time",           "value": "0" },
  { "label": "Date",           "value": "1" },
  { "label": "Weekday",        "value": "5" },
  { "label": "ISO Date",       "value": "6" },
  { "label": "Steps",          "value": "2" },
  { "label": "Distance",       "value": "8" },
  { "label": "Active Calories","value": "9" },
  { "label": "Total Calories", "value": "10" },
  { "label": "Sleep",          "value": "11" },
  { "label": "Heart Rate",     "value": "12" },
  { "label": "Battery",        "value": "3" },
  { "label": "Bluetooth",      "value": "7" },
  { "label": "Radar Age",      "value": "13" },
  { "label": "Lat/Long",       "value": "14" },
  { "label": "Current Conditions",     "value": "15" },
  { "label": "Temperature",            "value": "22" },
  { "label": "Feels Like",             "value": "23" },
  { "label": "Dew Point",              "value": "24" },
  { "label": "Humidity",               "value": "25" },
  { "label": "Wind",                   "value": "26" },
  { "label": "Pressure",               "value": "27" },
  { "label": "Today's Forecast",       "value": "16" },
  { "label": "Tonight/Tomorrow Forecast", "value": "28" },
  { "label": "High / Low",             "value": "17" },
  { "label": "Sunrise / Sunset",       "value": "29" },
  { "label": "Golden Hour",            "value": "30" },
  { "label": "Active Alerts",          "value": "18" },
  { "label": "Alerts + Upcoming",      "value": "19" },
  { "label": "Alerts, else High / Low","value": "20" },
  { "label": "Alerts, else Conditions","value": "21" },
  { "label": "None",           "value": "4" }
];

// 0-4 are fixed sizes; 6-9 are auto with that size as the ceiling ("at most
// this size": the band is reserved at the ceiling, the glyphs shrink to fit).
// Value 5 (auto with an Extra Small ceiling) is identical to fixed Extra
// Small, so it is handled in code but omitted from the UI.
var SIZE_OPTIONS = [
  { "label": "Extra Small", "value": "0" },
  { "label": "Small",       "value": "1" },
  { "label": "Medium",      "value": "2" },
  { "label": "Large",       "value": "3" },
  { "label": "Extra Large", "value": "4" },
  { "label": "Small, shrink to fit",       "value": "6" },
  { "label": "Medium, shrink to fit",      "value": "7" },
  { "label": "Large, shrink to fit",       "value": "8" },
  { "label": "Extra Large, shrink to fit", "value": "9" }
];

// One line of the face: what it shows, and how big. The inner two lines keep
// the messageKeys they shipped with (TopSlot/TopFont, BottomSlot/BottomFont)
// so settings already saved on the phone survive the upgrade to four lines.
function line(label, slotKey, slotDefault, fontKey, fontDefault) {
  return [
    {
      "type": "select",
      "messageKey": slotKey,
      "label": label,
      "defaultValue": slotDefault,
      "options": SLOT_OPTIONS
    },
    {
      "type": "select",
      "messageKey": fontKey,
      "label": label + " Size",
      "defaultValue": fontDefault,
      "options": SIZE_OPTIONS
    }
  ];
}

// Section headings default to h4, so the page title is bumped one level up to
// keep Map and Overlay reading as subordinate to it.
module.exports = [
  {
    "type": "heading",
    "size": 3,
    "defaultValue": "NOAA US Weather Radar"
  },
  {
    "type": "text",
    // The $ in the URL is %24-encoded: Clay injects this config as the
    // replacement string of a String.replace ($$CONFIG$$ in index.js), where
    // a literal "$'" would splice in the page template's tail and destroy the
    // settings UI.
    "defaultValue":
      "Like this watchface? Consider " +
      "<a href='https://herzog.tech/%24' target='_blank'>buying the author a tea</a>."
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Map"
      },
      // RadarMode is phone-side only, like Zoom and WxUnits: pkjs blends the
      // radar into the basemap and sends one composite image, so Disabled and
      // the translucency rewrite are both applied before anything is
      // transferred and the watch has no use for the value. The messageKey is
      // deliberately unchanged -- renaming a Clay key resets every saved
      // config -- only its destination moved, from the watch's Settings blob
      // to localStorage.RadarMode, which index.js reads on every refresh.
      {
        "type": "select",
        "messageKey": "RadarMode",
        "label": "Radar",
        "defaultValue": "1",
        "options": [
          { "label": "Disabled",    "value": "0" },
          { "label": "Translucent", "value": "1" },
          { "label": "Opaque",      "value": "2" }
        ]
      },
      {
        "type": "select",
        "messageKey": "Zoom",
        "label": "Zoom",
        "defaultValue": "1",
        "options": [
          { "label": "City (100 km)",   "value": "0" },
          { "label": "State (250 km)",  "value": "1" },
          { "label": "Region (500 km)", "value": "2" }
        ]
      },
      // UseGps and ManualLoc are phone-side only, like Zoom, RadarMode and
      // WxUnits:
      // pkjs owns all coordinate math, so neither is a package.json
      // messageKey and neither ever reaches the watch. custom-clay.js hides
      // the input while the toggle is on and disables Save while the text
      // does not parse as a valid coordinate pair.
      // RefreshInterval IS watch-bound (unlike Zoom/WxUnits): the watch owns
      // the heartbeat that drives both imagery and weather, so the value has
      // to reach tick_handler. Values must divide 60 -- the watch fires on
      // tm_min % value, and a non-divisor would tick unevenly across the hour.
      {
        "type": "select",
        "messageKey": "RefreshInterval",
        "label": "Refresh Interval",
        "defaultValue": "10",
        "options": [
          { "label": "Every 5 minutes",  "value": "5" },
          { "label": "Every 10 minutes", "value": "10" },
          { "label": "Every 15 minutes", "value": "15" },
          { "label": "Every 20 minutes", "value": "20" },
          { "label": "Every 30 minutes", "value": "30" },
          { "label": "Every hour",       "value": "60" }
        ],
        "description": "How often the radar, weather, and alerts refresh. Longer intervals use less battery."
      },
      {
        "type": "toggle",
        "messageKey": "UseGps",
        "label": "Use GPS",
        "defaultValue": true,
        "description": "Center the map and weather on the phone's location."
      },
      {
        "type": "input",
        "messageKey": "ManualLoc",
        "label": "Latitude, Longitude",
        "defaultValue": "",
        "attributes": { "placeholder": "e.g. 40.69, -74.04" },
        "description": "Decimal degrees, as copied from a long-press in most map apps."
      },
      {
        "type": "text",
        "id": "ManualLocError",
        "defaultValue": "&#9888; Enter as latitude, longitude in decimal degrees (latitude −90 to 90, longitude −180 to 180)."
      }
    ]
  },
  {
    "type": "section",
    "items": [].concat(
      [{ "type": "heading", "defaultValue": "Overlay" }],
      line("Top Line 1",    "TopSlot1",     "4", "TopFont1",     "2"),
      line("Top Line 2",    "TopSlot",      "0", "TopFont",      "4"),
      line("Bottom Line 1", "BottomSlot",   "1", "BottomFont",   "3"),
      line("Bottom Line 2", "BottomSlot2",  "4", "BottomFont2",  "2"),
      // The outline is an 8-direction halo the watch paints under the glyphs
      // so text stays readable over busy map areas. Both are plain pickers;
      // matching the two colors renders as slightly bolded solid text.
      [
        {
          "type": "color",
          "messageKey": "TextColor",
          "label": "Text Color",
          "defaultValue": "000000"
        },
        {
          "type": "color",
          "messageKey": "OutlineColor",
          "label": "Text Outline Color",
          "defaultValue": "FFFFFF"
        },
        // Watch-bound, like RefreshInterval: the badge is drawn watch-side
        // from connection_service state the phone never sees. Sent as a plain
        // boolean and stored as one. Defaults on.
        {
          "type": "toggle",
          "messageKey": "BtIndicator",
          "label": "Bluetooth Disconnection Indicator",
          "defaultValue": true
        }
      ]
    )
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Weather"
      },
      // WxUnits is phone-side only -- stored in localStorage by webviewclosed,
      // never forwarded to the watch, exactly like Zoom. A units change
      // invalidates the cached weather payload and refetches.
      //
      // This one setting drives EVERY unit the face renders, which is why the
      // label is "Units" and not "Temperature" any more: a user who asked for
      // Celsius wants km/h and millibars with it. Only the label and the
      // option text changed -- the messageKey and the 0/1 values are
      // deliberately untouched, because Clay prefills the page from
      // localStorage['clay-settings'] keyed by messageKey, so a rename would
      // silently reset every saved config (the same hazard recorded against
      // RadarMode above).
      {
        "type": "select",
        "messageKey": "WxUnits",
        "label": "Units",
        "defaultValue": "0",
        "options": [
          { "label": "Imperial (°F, mph, inHg)",   "value": "0" },
          { "label": "Metric (°C, km/h, mb)",      "value": "1" }
        ]
      },
      // Phone-side only, exactly like WxUnits above: pkjs owns the NWS alert
      // fetch and the timeline PUT, so this value never reaches the watch and
      // costs it no heap. It is deliberately NOT in package.json's messageKeys.
      // Defaults ON, which is why index.js reads it through numSetting()'s
      // explicit-default branch rather than a bare Number() -- the key is null
      // on a fresh install and Number(null) is 0.
      {
        "type": "toggle",
        "messageKey": "TimelineAlerts",
        "label": "Send Severe Weather Alerts to Timeline",
        "defaultValue": true,
        "description": "Pushes NWS Severe and Extreme alerts into the Pebble timeline as pins. Pins can take up to 15 minutes to appear, so this is not a real-time alerting channel."
      }
    ]
  },
  {
    // Attribution. The NSSL MRMS and USGS National Map pages block or time
    // out for non-browser clients but resolve in a real browser (confirmed by
    // hand, Aug 2026); the NWS API docs link verifies mechanically too.
    "type": "text",
    "defaultValue":
      "Radar data by <a href='https://www.nssl.noaa.gov/projects/mrms/' target='_blank'>NOAA</a>, " +
      "basemaps by the <a href='https://www.usgs.gov/programs/national-geospatial-program/national-map' target='_blank'>USGS</a>, " +
      "and weather data by the <a href='https://www.weather.gov/documentation/services-web-api' target='_blank'>NWS</a>."
  },
  {
    "type": "submit",
    "defaultValue": "Save Settings"
  }
];
