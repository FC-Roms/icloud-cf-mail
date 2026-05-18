import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = "wrangler.toml";
const BINDING = "MAIL_DB";

function getWorkerName(config) {
  const match = config.match(/^name\s*=\s*"([^"]+)"/m);

  if (!match) {
    throw new Error(`Cannot find worker name in ${CONFIG_PATH}`);
  }

  return match[1];
}

function getDatabaseId(output) {
  const match = output.match(/database_id\s*=\s*"([^"]+)"/);

  if (!match) {
    throw new Error("Cannot find D1 database_id from Wrangler output");
  }

  return match[1];
}

function replaceMailDbBinding(config, databaseName, databaseId) {
  const blockRegex = /\[\[d1_databases\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g;
  const blocks = [...config.matchAll(blockRegex)];

  for (const blockMatch of blocks) {
    const block = blockMatch[0];

    if (!new RegExp(`^binding\\s*=\\s*"${BINDING}"`, "m").test(block)) {
      continue;
    }

    let nextBlock = block;

    if (/^database_name\s*=\s*"[^"]*"/m.test(nextBlock)) {
      nextBlock = nextBlock.replace(
        /^database_name\s*=\s*"[^"]*"/m,
        `database_name = "${databaseName}"`
      );
    } else {
      nextBlock = nextBlock.replace(
        new RegExp(`^(binding\\s*=\\s*"${BINDING}")`, "m"),
        `$1\ndatabase_name = "${databaseName}"`
      );
    }

    if (/^database_id\s*=\s*"[^"]*"/m.test(nextBlock)) {
      nextBlock = nextBlock.replace(
        /^database_id\s*=\s*"[^"]*"/m,
        `database_id = "${databaseId}"`
      );
    } else {
      nextBlock = nextBlock.replace(
        /^database_name\s*=\s*"[^"]*"/m,
        `database_name = "${databaseName}"\ndatabase_id = "${databaseId}"`
      );
    }

    return (
      config.slice(0, blockMatch.index) +
      nextBlock +
      config.slice(blockMatch.index + block.length)
    );
  }

  const suffix = config.endsWith("\n") ? "" : "\n";

  return `${config}${suffix}\n[[d1_databases]]\nbinding = "${BINDING}"\ndatabase_name = "${databaseName}"\ndatabase_id = "${databaseId}"\n`;
}

const config = readFileSync(CONFIG_PATH, "utf8");
const workerName = getWorkerName(config);
const databaseName = process.argv[2] || `${workerName}_mail`;

console.log(`Creating D1 database "${databaseName}"...`);

const result = spawnSync("wrangler", ["d1", "create", databaseName], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});

const output = `${result.stdout || ""}${result.stderr || ""}`;

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.status !== 0) {
  process.exit(result.status || 1);
}

const databaseId = getDatabaseId(output);
const nextConfig = replaceMailDbBinding(config, databaseName, databaseId);

writeFileSync(CONFIG_PATH, nextConfig);

console.log(`Updated ${CONFIG_PATH}: ${BINDING} -> ${databaseName} (${databaseId})`);
