#!/usr/bin/env node
/**
 * Publish assets/ to the Cloudflare R2 bucket behind assets.hellokar.org.
 *
 *   npm run assets:sync -- --dry-run          # show what would change
 *   npm run assets:sync                       # upload new/changed files
 *   npm run assets:sync -- --only audio/uk    # one subtree
 *   npm run assets:sync -- --force            # re-upload everything
 *
 * Credentials come from the environment (see .env.example):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Objects are keyed by their path in assets/, so a file lands at
 * https://assets.hellokar.org/<key> — exactly what web/src/lib/assets.ts builds.
 */
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";
import fs from "node:fs";
import path from "node:path";
import { ASSETS, contentType, scan } from "./manifest.mjs";

/** The SDK ignores the usual proxy variables, so honour them explicitly. */
function requestHandler() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return undefined;
  const agent = new HttpsProxyAgent(proxy);
  return new NodeHttpHandler({ httpsAgent: agent, httpAgent: agent });
}

const CACHE = "public, max-age=31536000, immutable";

function env() {
  const need = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}.`);
    console.error("Create an R2 API token with Object Read & Write, then export the three values");
    console.error("(or put them in .env.local and run with `node --env-file=.env.local`).");
    process.exit(2);
  }
  return {
    account: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET || "word-atlas-assets",
  };
}

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, only: null, concurrency: 24, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]) || opts.concurrency;
    else if (a === "--limit") opts.limit = Number(argv[++i]) || Infinity;
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** HEAD the object; true when the stored size already matches. */
async function upToDate(s3, bucket, item) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key }));
    return head.ContentLength === item.bytes;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
}

async function upload(s3, bucket, item) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: item.key,
      Body: fs.createReadStream(item.file),
      ContentLength: item.bytes,
      ContentType: contentType(item.key),
      CacheControl: CACHE,
    }),
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { account, bucket } = env();

  let items = scan();
  if (!items.length) {
    console.error(`Nothing to upload: ${path.relative(process.cwd(), ASSETS)}/ is empty.`);
    console.error("Run `npm run assets:pull` first.");
    process.exit(1);
  }
  if (opts.only) items = items.filter((i) => i.key.startsWith(opts.only));
  items = items.slice(0, opts.limit);
  if (!items.length) {
    console.error(`No files match --only ${opts.only}`);
    process.exit(1);
  }

  const total = items.reduce((n, i) => n + i.bytes, 0);
  console.log(`bucket ${bucket}: ${items.length} candidates, ${(total / 1048576).toFixed(1)} MB`);
  if (opts.dryRun) {
    for (const i of items.slice(0, 20)) console.log(`  ${i.key}`);
    if (items.length > 20) console.log(`  … and ${items.length - 20} more`);
    return;
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // R2's S3 API wants the bucket in the path; the default virtual-host style
    // resolves to <bucket>.<account>.r2.cloudflarestorage.com and fails the TLS
    // handshake instead of returning a useful error.
    forcePathStyle: true,
    requestHandler: requestHandler(),
  });

  let done = 0;
  let skipped = 0;
  let sent = 0;
  let failed = 0;
  const errors = [];

  const queue = [...items];
  const started = Date.now();

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        if (!opts.force && (await upToDate(s3, bucket, item))) {
          skipped++;
        } else {
          let attempt = 0;
          for (;;) {
            try {
              await upload(s3, bucket, item);
              break;
            } catch (err) {
              if (++attempt >= 3) throw err;
              await new Promise((r) => setTimeout(r, 500 * attempt));
            }
          }
          sent++;
          done += item.bytes;
        }
      } catch (err) {
        failed++;
        if (errors.length < 10) errors.push(`${item.key}: ${err.message}`);
      }
      const seen = sent + skipped + failed;
      if (seen % 500 === 0 || seen === items.length) {
        const pct = ((seen / items.length) * 100).toFixed(1);
        console.log(`  ${seen}/${items.length} (${pct}%)  uploaded ${sent}  skipped ${skipped}  ${(done / 1048576).toFixed(1)} MB`);
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nuploaded ${sent}, unchanged ${skipped}, failed ${failed} in ${secs}s`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
