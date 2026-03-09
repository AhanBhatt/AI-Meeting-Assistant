const fs = require("node:fs");
const path = require("node:path");

const targets = ["dist-electron", "dist-server"];

for (const dir of targets) {
  const fullDir = path.resolve(process.cwd(), dir);
  fs.mkdirSync(fullDir, { recursive: true });
  fs.writeFileSync(
    path.join(fullDir, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
    "utf8"
  );
}

console.log("[build] Wrote runtime package.json files for CommonJS output.");
