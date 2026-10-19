import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

await fs.mkdir("dist/web/assets/fonts", { recursive: true });
await fs.copyFile("server/separation_worker.py", "dist/server/separation_worker.py");
await esbuild.build({
  entryPoints: ["src/hosted/app.js"],
  bundle: true,
  outfile: "dist/web/app.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
});
// Keep dashboard launch in the same document so its click unlocks TV audio.
const dashboard = await fs.readFile("src/hosted/dashboard.html", "utf8");
const appliance = await fs.readFile("src/hosted/index.html", "utf8");
const dashboardContent = dashboard.match(/<main>([\s\S]*?)<\/main>/)[1];
await fs.writeFile("dist/web/index.html", appliance
  .replace("<body>", '<body class="dashboard">')
  .replace("<main>", `<main><section id="dashboard">${dashboardContent}</section>`));
await fs.copyFile("src/hosted/index.html", "dist/web/app.html");
await esbuild.build({ entryPoints: ["src/hosted/tv.css"], bundle: true, outfile: "dist/web/tv.css", loader: { ".woff2": "file" }, assetNames: "assets/fonts/[name]" });
await fs.copyFile("src/hosted/style.css", "dist/web/style.css");
await fs.copyFile("src/icons/icon.png", "dist/web/assets/icon.png");
for (const font of [
  "rajdhani-v17-latin-600.woff2",
  "radio-canada-v26-latin-regular.woff2",
])
  await fs.copyFile(
    `src/assets/fonts/${font}`,
    `dist/web/assets/fonts/${font}`,
  );
console.log("Hosted browser build complete (core assets local; YouTube loads on demand).");

await fs.copyFile("LICENSE.txt", "dist/web/LICENSE.txt");
await fs.copyFile("THIRD_PARTY_NOTICES.md", "dist/web/THIRD_PARTY_NOTICES.txt");
// Ship the exact build inputs with every browser/container distribution.
execFileSync("tar", ["-czf", "dist/web/source.tar.gz", "--exclude=.DS_Store", "--exclude=__pycache__",
  "package.json", "package-lock.json", "tsconfig.server.json", "build-server.mjs",
  "eslint.config.js", "LICENSE.txt", "THIRD_PARTY_NOTICES.md", "README.md",
  "server", "shared", "src", "tests", "docs", "deploy/Dockerfile", "deploy/compose.yaml", "deploy/compose.gpu.yaml", "deploy/Caddyfile"]);
