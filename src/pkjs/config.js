// The Clay settings page. RadarMode, Zoom, UseGps, ManualLoc, WxUnits and
// TimelineAlerts are phone-side, not package.json messageKeys: webviewclosed
// stores them in localStorage, with UseGps folded into ManualLoc ('' = GPS).
// Clay prefills by messageKey, so renaming a key or renumbering a value resets
// or changes every saved config.

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
  { "label": "Alerts, else Upcoming, else Conditions", "value": "31" },
  { "label": "None",           "value": "4" }
];

// 0-4 are fixed Extra Small..Extra Large; 6-9 are auto with ceiling value - 5
// ("at most this size": the band is reserved at the ceiling, the glyphs shrink
// to fit). Value 5, auto with an Extra Small ceiling, renders as fixed Extra
// Small, so code handles it but the UI omits it. Super Large is 10 (fixed) and
// 11 (auto), appended rather than renumbered: Clay prefills from saved values,
// so a renumbered code would silently change every saved size.
var SIZE_OPTIONS = [
  { "label": "Extra Small", "value": "0" },
  { "label": "Small",       "value": "1" },
  { "label": "Medium",      "value": "2" },
  { "label": "Large",       "value": "3" },
  { "label": "Extra Large", "value": "4" },
  { "label": "Super Large", "value": "10" },
  { "label": "Small, shrink to fit",       "value": "6" },
  { "label": "Medium, shrink to fit",      "value": "7" },
  { "label": "Large, shrink to fit",       "value": "8" },
  { "label": "Extra Large, shrink to fit", "value": "9" },
  { "label": "Super Large, shrink to fit", "value": "11" }
];

// chalk's outer lines sit where the visible chord is narrowest, so the watch
// caps them at Small (slot_font() in main.c) and chalk's dropdown offers only
// what renders. custom-clay.js maps a size this list lacks to its clamp.
var SIZE_OPTIONS_CHALK_OUTER = [
  { "label": "Extra Small", "value": "0" },
  { "label": "Small",       "value": "1" },
  { "label": "Small, shrink to fit", "value": "6" }
];

// One line of the face: what it shows, and how big. TopSlot/TopFont is Top
// Line 2 and BottomSlot/BottomFont is Bottom Line 1; like every key, they must
// not be renamed to match.
//
// An outer line passes chalkFontDefault and gets two size items on one
// messageKey. Clay builds only the item whose capabilities match the watch,
// and the two capabilities are exact complements, so every platform sees
// exactly one; serialize() and getItemByMessageKey() are keyed by messageKey
// and would silently keep only the last if both were ever built.
function line(label, slotKey, slotDefault, fontKey, fontDefault, chalkFontDefault) {
  var items = [
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
  if (chalkFontDefault !== undefined) {
    items[1].capabilities = ["NOT_PLATFORM_CHALK"];
    items.push({
      "type": "select",
      "messageKey": fontKey,
      "label": label + " Size",
      "defaultValue": chalkFontDefault,
      "options": SIZE_OPTIONS_CHALK_OUTER,
      "capabilities": ["PLATFORM_CHALK"]
    });
  }
  return items;
}

// Section headings default to h4, so the page title is bumped one level up to
// keep the section headings reading as subordinate to it.
module.exports = [
  {
    "type": "heading",
    "size": 3,
    "defaultValue": "NOAA US Weather Radar"
  },
  {
    "type": "text",
    // The $ in the URL is %24-encoded: Clay injects this config as the
    // replacement string of a String.replace ($$CONFIG$$ in Clay's own
    // index.js), where a literal "$'" would splice in the page template's
    // tail and destroy the settings UI.
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
      // Values must divide 60, because tick_handler fires on tm_min % value.
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
      // custom-clay.js hides ManualLoc while UseGps is on, shows ManualLocError
      // and disables Save until the text parses as a coordinate pair.
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
      // These defaults mirror load_settings() in main.c at the default Text
      // Size; sizes the watch reported (onWatchFonts in index.js) outrank them.
      // chalk's outer default is Small, the watch's clamp of Medium.
      line("Top Line 1",    "TopSlot1",     "4", "TopFont1",     "2", "1"),
      line("Top Line 2",    "TopSlot",      "0", "TopFont",      "4"),
      line("Bottom Line 1", "BottomSlot",   "1", "BottomFont",   "3"),
      line("Bottom Line 2", "BottomSlot2",  "4", "BottomFont2",  "2", "1"),
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
      // One setting drives every unit, because a user who asks for Celsius
      // wants km/h and millibars too.
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
      // Defaults on, so index.js reads it through numSetting()'s explicit
      // default: the key is null on a fresh install and Number(null) is 0.
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
    // Attribution. The NSSL and USGS links block or time out for non-browser
    // clients, so a link checker reports them dead; they resolve in a browser.
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
