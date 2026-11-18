// After `tauri android init`: Google TV / Android TV support and the app icons.
// - LEANBACK_LAUNCHER so the app shows on the TV home screen, banner 320x180 dp
// - leanback and touchscreen declared as not required, so one APK serves phones, tablets and TVs
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");
const manifestPath = join(res, "..", "AndroidManifest.xml");

for (const dir of ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi", "mipmap-anydpi-v26", "values"]) {
  cpSync(join(root, "src-tauri", "icons", "android", dir), join(res, dir), { recursive: true });
}
mkdirSync(join(res, "drawable-xhdpi"), { recursive: true });
cpSync(join(root, "src-tauri", "icons", "android", "tv-banner.png"), join(res, "drawable-xhdpi", "banner.png"));

let m = readFileSync(manifestPath, "utf8");
const must = (cond, what) => { if (!cond) throw new Error(`AndroidManifest.xml: ${what} not found`); };

must(/<application\b/.test(m), "<application>");
for (const feature of ["android.software.leanback", "android.hardware.touchscreen"]) {
  if (m.includes(`"${feature}"`)) continue;
  m = m.replace(/(\s*)<application\b/, `$1<uses-feature android:name="${feature}" android:required="false" />$1<application`);
}
must(/android\.hardware\.touchscreen" android:required="false"/.test(m), "touchscreen not required");
if (!m.includes("android:banner=")) m = m.replace(/<application\b/, '<application android:banner="@drawable/banner"');
// media servers on the home network are often plain http (posters are loaded by the WebView)
// (the Tauri template sets it from a build placeholder that is false in release builds)
m = m.replace(/android:usesCleartextTraffic="[^"]*"/, 'android:usesCleartextTraffic="true"');
if (!m.includes("android:usesCleartextTraffic=")) m = m.replace(/<application\b/, '<application android:usesCleartextTraffic="true"');
if (!m.includes("LEANBACK_LAUNCHER")) {
  const launcher = /(\s*)<category android:name="android\.intent\.category\.LAUNCHER"\s*\/>/;
  must(launcher.test(m), "LAUNCHER category");
  m = m.replace(launcher, (all, ws) => `${all}${ws}<category android:name="android.intent.category.LEANBACK_LAUNCHER" />`);
}
// keyboard: the window shrinks above it, so the top bar and the search field stay in place (the window
// background below is in the app's colour, so no black strip shows)
if (!m.includes("windowSoftInputMode")) {
  must(/android:name="\.MainActivity"/.test(m), "MainActivity");
  m = m.replace(/android:name="\.MainActivity"/, 'android:name=".MainActivity"\n            android:windowSoftInputMode="adjustResize"');
}
writeFileSync(manifestPath, m);

// window background in the app's colour, so nothing black shows around the keyboard or while loading
for (const dir of ["values", "values-night"]) {
  const themes = join(res, dir, "themes.xml");
  let x;
  try { x = readFileSync(themes, "utf8"); } catch { continue; }
  if (!x.includes("android:windowBackground")) {
    x = x.replace(/(<style name="Theme\.[^"]+"[^>]*>)/, '$1\n        <item name="android:windowBackground">#FF0F1115</item>');
    writeFileSync(themes, x);
    console.log(`${dir}/themes.xml:\n${x}`);
  }
}
console.log(m);
