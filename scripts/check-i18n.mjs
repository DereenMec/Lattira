// 扫描 src 中的 t("…") 与 msg("…")，列出 src/i18n/en.ts 里缺少的英文翻译。
// 用法：npm run i18n:check
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(name) && !p.includes(`${path.sep}i18n${path.sep}`)) files.push(p);
  }
})(path.join(root, "src"));

const used = new Map();
const pattern = /\b(?:t|msg)\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
for (const file of files) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(pattern)) {
    const key = m[2].replace(/\\n/g, "\n").replace(/\\(["'\\])/g, "$1");
    if (!used.has(key)) used.set(key, path.relative(root, file));
  }
}

const enSource = fs.readFileSync(path.join(root, "src/i18n/en.ts"), "utf8");
const defined = new Set();
for (const m of enSource.matchAll(/^\s*(["'])((?:\\.|(?!\1).)*)\1\s*:/gm)) {
  defined.add(m[2].replace(/\\n/g, "\n").replace(/\\(["'\\])/g, "$1"));
}

const missing = [...used].filter(([k]) => !defined.has(k));
const unused = [...defined].filter((k) => !used.has(k));
for (const [k, f] of missing) console.log(`缺少翻译  ${JSON.stringify(k)}  (${f})`);
if (unused.length) console.log(`\n未使用的翻译 ${unused.length} 条：\n${unused.map((k) => "  " + JSON.stringify(k)).join("\n")}`);
console.log(`\n共 ${used.size} 条文本，缺少 ${missing.length} 条翻译`);
process.exit(missing.length ? 1 : 0);
