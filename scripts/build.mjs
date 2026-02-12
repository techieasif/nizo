import { mkdir, rm, copyFile, cp } from "node:fs/promises";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
      }
    });
  });
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await run("npx", ["tsc", "-p", "tsconfig.json"]);

await copyFile("manifest.json", "dist/manifest.json");
await copyFile("src/popup.html", "dist/popup.html");
await copyFile("src/popup.css", "dist/popup.css");
await cp("assets", "dist/assets", { recursive: true });

console.log("Build complete. Load /dist as unpacked extension.");
