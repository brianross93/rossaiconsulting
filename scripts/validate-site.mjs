import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const errors = [];

async function findHtml(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findHtml(entryPath)));
    } else if (entry.name === "index.html") {
      files.push(entryPath);
    }
  }

  return files;
}

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

function fail(file, message) {
  errors.push(`${path.relative(root, file)}: ${message}`);
}

function targetForHref(href) {
  const cleaned = href.split("#")[0].split("?")[0];
  if (!cleaned || !cleaned.startsWith("/")) {
    return null;
  }

  if (cleaned === "/") {
    return path.join(root, "index.html");
  }

  if (cleaned.endsWith("/")) {
    return path.join(root, cleaned.slice(1), "index.html");
  }

  return path.join(root, cleaned.slice(1));
}

const files = await findHtml(root);
const titles = new Map();
const descriptions = new Map();

if (files.length !== 27) {
  errors.push(`Expected 27 HTML routes, found ${files.length}.`);
}

for (const file of files) {
  const html = await fs.readFile(file, "utf8");
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  const routePath =
    relativeFile === "index.html"
      ? "/"
      : "/" + relativeFile.slice(0, -"index.html".length);
  const expectedCanonical = "https://rossapplied.ai" + routePath;

  if (count(html, /<h1\b/g) !== 1) {
    fail(file, "must contain exactly one H1");
  }
  if (count(html, /<main id="main-content"/g) !== 1) {
    fail(file, "must contain exactly one main landmark");
  }
  if (count(html, /data-site-header/g) !== 1) {
    fail(file, "must contain exactly one shared site header");
  }
  if (!html.includes('src="/site.js"')) {
    fail(file, "is missing site.js");
  }
  if (!html.includes('href="/refresh.css"')) {
    fail(file, "is missing refresh.css");
  }
  if (!html.includes('href="/fixes.css"')) {
    fail(file, "is missing fixes.css");
  }
  const canonical = html.match(
    /<link\s+[\s\S]*?rel="canonical"[\s\S]*?href="([^"]+)"[\s\S]*?>/,
  )?.[1];
  if (count(html, /rel="canonical"/g) !== 1 || canonical !== expectedCanonical) {
    fail(file, "must contain one canonical URL matching " + expectedCanonical);
  }
  if (count(html, /name="theme-color"/g) !== 1) {
    fail(file, "must contain exactly one theme-color meta tag");
  }
  if (count(html, /rel="icon"/g) !== 1) {
    fail(file, "must contain exactly one favicon link");
  }
  if (/class="[^"]*\beyebrow\b/.test(html)) {
    fail(file, "contains forbidden eyebrow text");
  }
  if (/class="[^"]*\b(?:tag|badge|project-sector|brief-kicker|report-kicker)\b/.test(html)) {
    fail(file, "contains an eyebrow-style label treatment");
  }
  if (html.includes("AI Opportunity Score")) {
    fail(file, "contains the removed pseudo-score");
  }
  if (html.includes("Overwhelmed Owner Owen")) {
    fail(file, "contains the removed internal persona copy");
  }
  if (/[\u00c2\u00c3\u00e2\ufffd]/u.test(html)) {
    fail(file, "contains mojibake");
  }

  const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim();
  const description = html
    .match(/<meta\s+name="description"\s+content="([^"]+)"/)?.[1]
    ?.trim();

  if (!title) {
    fail(file, "is missing a title");
  } else if (titles.has(title)) {
    fail(file, `duplicates title from ${titles.get(title)}`);
  } else {
    titles.set(title, path.relative(root, file));
  }

  if (!description) {
    fail(file, "is missing a meta description");
  } else if (descriptions.has(description)) {
    fail(file, `duplicates description from ${descriptions.get(description)}`);
  } else {
    descriptions.set(description, path.relative(root, file));
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    fail(file, `contains duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`);
  }

  const anchors = [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)];
  for (const [, href] of anchors) {
    const target = targetForHref(href);
    if (!target) {
      continue;
    }

    try {
      await fs.access(target);
    } catch {
      fail(file, `links to missing local target ${href}`);
    }
  }

  const inlineScripts = [
    ...html.matchAll(
      /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];

  for (const [, source] of inlineScripts) {
    try {
      new vm.Script(source, { filename: path.relative(root, file) });
    } catch (error) {
      fail(file, `contains invalid inline JavaScript: ${error.message}`);
    }
  }
}

const sitemap = await fs.readFile(path.join(root, "sitemap.xml"), "utf8");
if (!sitemap.startsWith("<?xml")) {
  errors.push("sitemap.xml must start with its XML declaration");
}

for (const required of ["refresh.css", "fixes.css", "site.js", "og.png"]) {
  try {
    await fs.access(path.join(root, required));
  } catch {
    errors.push(`Missing required asset: ${required}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${files.length} routes: unique metadata, one H1/main, shared shell, internal links, IDs, and inline scripts.`,
  );
}
