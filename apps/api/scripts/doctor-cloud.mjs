#!/usr/bin/env node

import { HeadBucketCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const argv = process.argv.slice(2);
const strictOnline = argv.includes("--strict-online");
const writeSmoke = argv.includes("--write-smoke");

function parseArgValue(prefix) {
  const found = argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function readBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function logResult(level, label, detail) {
  const padded = `${label}:`.padEnd(22, " ");
  if (detail) {
    console.log(`[${level}] ${padded} ${detail}`);
    return;
  }
  console.log(`[${level}] ${padded}`);
}

function fail(message) {
  logResult("fail", "doctor", message);
  process.exit(1);
}

const thisFile = fileURLToPath(import.meta.url);
const apiDir = path.resolve(path.dirname(thisFile), "..");
const defaultEnvFile = path.join(apiDir, ".env");
const envFile = parseArgValue("--env-file=") ?? defaultEnvFile;

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, override: false });
  logResult("ok", "env file", envFile);
} else {
  logResult("skip", "env file", `not found (${envFile}), using process env only`);
}

const cfg = {
  appStoreProvider: (process.env.APP_STORE_PROVIDER ?? "memory").toLowerCase(),
  favoritesProvider: (process.env.FAVORITES_PROVIDER ?? "local").toLowerCase(),
  postgresUrl: process.env.POSTGRES_URL ?? "",
  postgresSsl: readBoolean(process.env.POSTGRES_SSL, false),
  objectStorageProvider: (process.env.OBJECT_STORAGE_PROVIDER ?? "none").toLowerCase(),
  s3Endpoint: process.env.S3_ENDPOINT ?? "",
  s3Region: process.env.S3_REGION ?? "auto",
  s3Bucket: process.env.S3_BUCKET ?? "",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  s3PublicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? "",
  s3ForcePathStyle: readBoolean(process.env.S3_FORCE_PATH_STYLE, true),
};

if (strictOnline) {
  if (cfg.appStoreProvider !== "postgres") {
    fail(`APP_STORE_PROVIDER must be postgres in strict mode (current: ${cfg.appStoreProvider}).`);
  }
  if (cfg.favoritesProvider !== "postgres") {
    fail(`FAVORITES_PROVIDER must be postgres in strict mode (current: ${cfg.favoritesProvider}).`);
  }
  if (cfg.objectStorageProvider !== "s3") {
    fail(
      `OBJECT_STORAGE_PROVIDER must be s3 in strict mode (current: ${cfg.objectStorageProvider}).`,
    );
  }
}

if (
  (cfg.appStoreProvider === "postgres" || cfg.favoritesProvider === "postgres") &&
  cfg.postgresUrl.trim() === ""
) {
  fail("POSTGRES_URL is required when APP_STORE_PROVIDER or FAVORITES_PROVIDER uses postgres.");
}

if (cfg.objectStorageProvider === "s3") {
  const missing = [];
  if (!cfg.s3Bucket.trim()) missing.push("S3_BUCKET");
  if (!cfg.s3Endpoint.trim()) missing.push("S3_ENDPOINT");
  if (!cfg.s3AccessKeyId.trim()) missing.push("S3_ACCESS_KEY_ID");
  if (!cfg.s3SecretAccessKey.trim()) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    fail(`Missing required S3 config: ${missing.join(", ")}`);
  }
}

async function checkPostgres() {
  const requiresPostgres =
    cfg.appStoreProvider === "postgres" || cfg.favoritesProvider === "postgres";
  if (!requiresPostgres) {
    logResult("skip", "postgres", "not required by current provider settings");
    return;
  }

  const client = new Client({
    connectionString: cfg.postgresUrl,
    ssl: cfg.postgresSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    const result = await client.query("select now() as now, current_database() as db");
    const row = result.rows[0];
    logResult("ok", "postgres", `connected (db=${row.db}, now=${row.now})`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkObjectStorage() {
  if (cfg.objectStorageProvider !== "s3") {
    logResult("skip", "object storage", "OBJECT_STORAGE_PROVIDER is not s3");
    return;
  }

  const client = new S3Client({
    region: cfg.s3Region,
    endpoint: cfg.s3Endpoint,
    forcePathStyle: cfg.s3ForcePathStyle,
    credentials: {
      accessKeyId: cfg.s3AccessKeyId,
      secretAccessKey: cfg.s3SecretAccessKey,
    },
  });

  await client.send(new HeadBucketCommand({ Bucket: cfg.s3Bucket }));
  logResult("ok", "r2/s3 bucket", `connected (${cfg.s3Bucket})`);

  if (!cfg.s3PublicBaseUrl.trim()) {
    logResult(
      "skip",
      "public base url",
      "S3_PUBLIC_BASE_URL is empty. Public cover URLs may be inaccessible from browser.",
    );
  }

  if (writeSmoke) {
    const key = `prismflow-health/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.s3Bucket,
        Key: key,
        Body: Buffer.from("ok", "utf8"),
        ContentType: "text/plain",
      }),
    );
    await client.send(
      new DeleteObjectCommand({
        Bucket: cfg.s3Bucket,
        Key: key,
      }),
    );
    logResult("ok", "r2 write smoke", "put+delete succeeded");
  }
}

async function main() {
  logResult("ok", "mode", strictOnline ? "strict-online" : "soft");
  try {
    await checkPostgres();
    await checkObjectStorage();
    logResult("ok", "doctor", "all required checks passed");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(detail);
  }
}

main();
