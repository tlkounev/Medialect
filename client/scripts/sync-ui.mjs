// Copies the shared web UI (app/static) into the app and builds index.html from the server's page:
// the static <script> tags are replaced by the app entry, which installs the local /api first.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "..", "app", "static");
const out = join(root, "public", "static");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["app.js", "app.css", "i18n.js", "i18n", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "manifest.webmanifest"]) cpSync(join(ui, f), join(out, f), { recursive: true });
let html = readFileSync(join(ui, "index.html"), "utf8");
html = html.replace(/<script src="\/static\/(i18n|app)\.js"><\/script>\s*/g, "");
if (html.includes('src="/static/app.js"')) throw new Error("index.html: script tags not found/removed");
html = html.replace("</body>", '<script type="module" src="/src/main.ts"></script>\n</body>');
writeFileSync(join(root, "index.html"), html);
console.log("UI synced from app/static");
