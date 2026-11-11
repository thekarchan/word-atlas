/** Publish crawlable word entries and their sitemap alongside the learning app. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const origin = "https://words.hellokar.org";
const base = process.env.ATLAS_BASE || "/";
const env = loadEnv("production", root);
const assetBase = (
  env.VITE_ASSET_BASE?.trim() || "https://assets.hellokar.org"
).replace(/\/+$/, "");
const index = JSON.parse(readFileSync(join(dist, "atlas/index.json"), "utf8"));
const count = new Intl.NumberFormat("zh-CN").format(index.count);
const sitemap = [origin + "/"];

const entities = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escape = (value) =>
  String(value).replace(/[&<>"']/g, (char) => entities[char]);
const wordPath = (id) => `word/${id}/`;
const letterPath = (letter) => `dictionary/${letter}/`;

function href(route, target = "") {
  if (base === "." || base === "./") {
    const prefix =
      "../".repeat(route.split("/").filter(Boolean).length) || "./";
    return escape(prefix + target);
  }
  return escape(base.replace(/\/?$/, "/") + target);
}

function publish(route, title, description, content, { missing = false } = {}) {
  const url = `${origin}/${route}`;
  const head = missing
    ? ""
    : `
    <meta name="description" content="${escape(description)}">
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="词光">
    <meta property="og:title" content="${escape(title)}">
    <meta property="og:description" content="${escape(description)}">
    <meta property="og:url" content="${url}">`;
  const directory = join(dist, route);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, missing ? "404.html" : "index.html"),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title>${head}
    <link rel="icon" href="${href(route, "favicon.svg")}" type="image/svg+xml">
    <link rel="stylesheet" href="${href(route, "dictionary.css")}">
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="${href(route)}">词光 <span lang="en">Word Atlas</span></a>
      <a href="${href(route, "dictionary/")}">雅思词典</a>
    </header>
    <main>
      ${content}
    </main>
  </body>
</html>
`,
  );
  if (!missing) sitemap.push(url);
}

function pronunciation(id, accent, label, ipa, hasAudio) {
  if (!ipa && !hasAudio) return "";
  const player = hasAudio
    ? `<audio aria-label="${label}发音" controls preload="none" src="${escape(`${assetBase}/audio/${accent}/${id}.mp3`)}"></audio>`
    : "";
  return `<div><h3>${label} <span lang="en-fonipa">${escape(ipa)}</span></h3>${player}</div>`;
}

function publishWord(entry, summary, level, topic) {
  const { id, w, uk, us, senses, ex, col, tip, note, m } = entry;
  const route = wordPath(id);
  const title = `${w} 的中文释义、发音和例句 · 词光雅思词典`;
  const description = `${w}：${summary}。查看中英释义、双语例句和常用搭配。`;
  const sounds =
    pronunciation(id, "uk", "英音", uk, m & 2) +
    pronunciation(id, "us", "美音", us, m & 4);
  const meanings = senses
    .map(
      ({ pos, zh, en }) =>
        `<li><strong>${escape(pos)} ${escape(zh)}</strong>${en ? `<div lang="en">${escape(en)}</div>` : ""}</li>`,
    )
    .join("\n");
  const examples = ex
    .map(
      ({ en, zh }) =>
        `<li><div lang="en">${escape(en)}</div><div>${escape(zh)}</div></li>`,
    )
    .join("\n");
  const illustration =
    m & 1
      ? `<img class="illustration" src="${escape(`${assetBase}/illustrations/img/${id}.webp`)}" alt="${escape(w)} 的词条插画" loading="lazy" decoding="async">`
      : "";

  publish(
    route,
    title,
    description,
    `
      <p class="breadcrumb"><a href="${href(route, letterPath(id[0]))}">${id[0].toUpperCase()} 开头的单词</a></p>
      <h1 lang="en">${escape(w)}</h1>
      <p class="subtitle">${escape(level)} · ${escape(topic)}</p>
      <a class="study" href="${href(route, `#/atlas?w=${id}`)}">在词光里学习这个词</a>
      ${illustration}
      <section>
        <h2>中文释义</h2>
        <ol class="entry-list">${meanings}</ol>
      </section>
      ${sounds ? `<section><h2>发音</h2><div class="pronunciations">${sounds}</div></section>` : ""}
      <section>
        <h2>双语例句</h2>
        <ol class="entry-list">${examples}</ol>
      </section>
      ${col.length ? `<section><h2>常用搭配</h2><ul>${col.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section>` : ""}
      ${
        tip || note
          ? `<section><h2>用法提示</h2>${[tip, note]
              .filter(Boolean)
              .map((item) => `<p>${escape(item)}</p>`)
              .join("")}</section>`
          : ""
      }`,
  );
}

const letters = new Map();
const ids = new Set();
let entries;
for (const [i, [id, word, summary, , level, topic]] of index.words.entries()) {
  if (!/^[a-z0-9-]{1,64}$/.test(id) || ids.has(id))
    throw new Error(`Invalid or duplicate word ID: ${id}`);
  ids.add(id);
  if (i % index.chunk === 0) {
    entries = JSON.parse(
      readFileSync(
        join(dist, `atlas/entries/${Math.floor(i / index.chunk)}.json`),
        "utf8",
      ),
    );
  }
  const entry = entries[i % index.chunk];
  if (entry?.id !== id || entry.w !== word)
    throw new Error(`Missing or mismatched entry: ${id}`);
  publishWord(entry, summary, index.cefr[level], index.topics[topic][1]);

  const letter = id[0];
  if (!letters.has(letter)) letters.set(letter, []);
  letters.get(letter).push({ id, word, summary });
}
if (ids.size !== index.count)
  throw new Error("Word index count does not match the dataset");

for (const [letter, words] of letters) {
  const label = `${letter.toUpperCase()} 开头的雅思单词`;
  const route = letterPath(letter);
  words.sort((a, b) => a.word.localeCompare(b.word, "en"));
  publish(
    route,
    `${label} · 词光雅思词典`,
    `按字母浏览 ${words.length} 个${label}，查看中文释义、发音和双语例句。`,
    `
      <h1>${label}</h1>
      <p class="subtitle">${words.length} 个词条</p>
      <ul class="word-list">${words
        .map(
          ({ id, word, summary }) =>
            `<li><a href="${href(route, wordPath(id))}"><span lang="en">${escape(word)}</span><small>${escape(summary)}</small></a></li>`,
        )
        .join("\n")}</ul>`,
  );
}

publish(
  "dictionary/",
  "雅思词典 · 词光 Word Atlas",
  `按字母浏览 ${count} 个雅思单词。查看中文释义、英美发音、原创插画和双语例句。`,
  `
      <h1>雅思词典</h1>
      <p class="subtitle">按字母浏览 ${count} 个词条，查看中文释义、英美发音、插画和双语例句。</p>
      <ul class="letter-list">${[...letters.keys()]
        .sort()
        .map(
          (letter) =>
            `<li><a href="${href("dictionary/", letterPath(letter))}">${letter.toUpperCase()}</a></li>`,
        )
        .join("\n")}</ul>`,
);

if (base === "/") {
  publish(
    "",
    "找不到页面 · 词光 Word Atlas",
    "",
    `
      <h1>找不到这个页面</h1>
      <p><a href="/">回到词光首页</a> · <a href="/dictionary/">浏览雅思词典</a></p>`,
    { missing: true },
  );
  writeFileSync(
    join(dist, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
  );
  writeFileSync(
    join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap
  .sort()
  .map((url) => `  <url><loc>${escape(url)}</loc></url>`)
  .join("\n")}
</urlset>
`,
  );
}

console.log(
  `Built ${ids.size} word pages and ${letters.size + 1} dictionary pages.`,
);
