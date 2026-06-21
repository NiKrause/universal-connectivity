#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const functionName = process.argv[2];
if (!functionName) {
  throw new Error("Usage: run-shared-aleph-node.mjs <exportName>");
}

const source = process.env.SHARED_ALEPH_NODE_SOURCE || "npm";
const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
const moduleUrl =
  source === "source"
    ? pathToFileURL(
        path.join(
          process.env.SHARED_ALEPH_NODE_LOCAL_PATH || "",
          "packages/node/src/index.ts",
        ),
      ).href
    : pathToFileURL(requireFromCwd.resolve("@le-space/node")).href;

if (source === "source" && !process.env.SHARED_ALEPH_NODE_LOCAL_PATH) {
  throw new Error("SHARED_ALEPH_NODE_LOCAL_PATH is required for source mode");
}

const module = await import(moduleUrl);
const runner = module[functionName];

if (typeof runner !== "function") {
  throw new Error(`@le-space/node export ${functionName} is not a function`);
}

await runner(process.env);
