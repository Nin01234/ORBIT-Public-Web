const fs = require("node:fs");
const path = require("node:path");
const { minify } = require("terser");

const files = ["app.js", "mobile-bridge.js", "live-podcast.js"];
(async () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const result = await minify(source, {
      compress: { passes: 2 },
      mangle: true,
      format: { comments: false },
      sourceMap: false
    });
    if (!result.code) throw new Error("Terser returned empty output for " + file);
    fs.writeFileSync(path.join(__dirname, file.replace(/\.js$/, ".min.js")), result.code + "\n", "utf8");
    console.log("Minified " + file);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });