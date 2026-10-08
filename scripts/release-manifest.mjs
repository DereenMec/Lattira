// 生成在线更新用的 latest.json，与安装包一起上传到 GitHub Release。
// 用法：先带签名私钥构建（见 docs/DEVELOPMENT.md「发布」），再运行
//   npm run release:manifest -- [更新说明文件.md]
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const exe = `${conf.productName}_${version}_x64-setup.exe`;
const dir = path.join(root, "src-tauri/target/release/bundle/nsis");
const sigPath = path.join(dir, `${exe}.sig`);
if (!fs.existsSync(sigPath)) {
  console.error(`找不到签名文件 ${sigPath}\n构建前需要设置 TAURI_SIGNING_PRIVATE_KEY，见 docs/DEVELOPMENT.md「发布」。`);
  process.exit(1);
}
const notesFile = process.argv[2];
const manifest = {
  version,
  notes: notesFile ? fs.readFileSync(notesFile, "utf8").trim() : "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/DereenMec/Lattira/releases/download/v${version}/${exe}`,
    },
  },
};
const out = path.join(dir, "latest.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`已生成 ${out}\n上传到 Release v${version}：${exe} 和 latest.json`);
