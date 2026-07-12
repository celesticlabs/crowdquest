import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skippedDirectories = new Set([".git", ".next", ".vinext", ".wrangler", "dist", "node_modules", "coverage"]);
const skippedExtensions = new Set([".jpeg", ".jpg", ".mp4", ".png", ".woff", ".woff2", ".sqlite", ".db"]);
const signatures = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private-key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["TxLINE API token", /\btxoracle_api_[A-Za-z0-9_-]{8,}\b/],
  ["live secret key", /\b(?:sk|rk)_live_[A-Za-z0-9_-]{12,}\b/],
  ["serialized secret key", /["'](?:privateKey|secretKey|seedPhrase|mnemonic)["']\s*:\s*["'][^"']{12,}["']/i],
];

const findings = [];
await walk(root);
if (findings.length) {
  for (const finding of findings) process.stderr.write(`${finding.file}: possible ${finding.label}\n`);
  process.exit(1);
}
process.stdout.write("No high-confidence secret signatures found.\n");

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile() || skippedExtensions.has(extname(entry.name).toLowerCase())) continue;
    const content = await readFile(absolute, "utf8").catch(() => "");
    for (const [label, pattern] of signatures) {
      if (pattern.test(content)) findings.push({ file: relative(root, absolute), label });
    }
  }
}
