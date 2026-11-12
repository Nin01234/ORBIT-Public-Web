const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const root = __dirname;
const target = path.join(root, ".python-deps");
const requirements = path.join(root, "requirements-ytmusic.txt");
const python = process.platform === "win32" ? "py" : "python3";
const args = process.platform === "win32"
  ? ["-3", "-m", "pip", "install", "--disable-pip-version-check", "--target", target, "-r", requirements]
  : ["-m", "pip", "install", "--disable-pip-version-check", "--target", target, "-r", requirements];
fs.mkdirSync(target, { recursive: true });
const result = spawnSync(python, args, { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error || result.status !== 0) {
  console.error("ORBIT could not install the YouTube Music Python dependencies.");
  process.exit(result.status || 1);
}
