import * as esbuild from "esbuild";
import fs from "node:fs/promises";

await fs.mkdir("dist/web/assets/fonts", { recursive: true });
await esbuild.build({
  entryPoints: ["src/hosted/app.js"],
  bundle: true,
  outfile: "dist/web/app.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
});
await fs.copyFile("src/hosted/index.html", "dist/web/index.html");
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
console.log("Headless browser build complete (all runtime assets local).");
