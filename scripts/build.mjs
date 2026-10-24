import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { parseSubscription, UnsupportedFormatError } from './parser.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function request(url) {
  const isApi = new URL(url).hostname === 'api.github.com';
  const headers = { 'User-Agent': 'mahsa-subscription', Accept: isApi ? 'application/vnd.github+json' : 'text/plain' };
  if (isApi && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) throw new Error(`Response too large: ${url}`);
        chunks.push(chunk);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return isApi ? JSON.parse(text) : text;
    } catch (error) {
      if (attempt === 2) throw error;
      await setTimeout(500 * (attempt + 1));
    }
  }
  throw new Error('Request attempts exhausted');
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid sources.json');
  for (const key of ['owner', 'repository', 'branch']) {
    if (typeof config[key] !== 'string' || !/^[\w.-]+$/.test(config[key])) {
      throw new Error(`Invalid source ${key}`);
    }
  }
  for (const key of ['directories', 'optionalFormatDirectories', 'schemes']) {
    if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string' || !/^[\w.-]+$/.test(value))) {
      throw new Error(`Invalid source ${key}`);
    }
  }
  if (!config.directories.length || !config.schemes.length) throw new Error('Source directories and schemes cannot be empty');
  if (config.optionalFormatDirectories.some((dir) => !config.directories.includes(dir))) {
    throw new Error('Optional format directories must be included in directories');
  }
}

export async function buildSubscription(config, outputDirectory, fetcher = request) {
  validateConfig(config);
  const api = `https://api.github.com/repos/${config.owner}/${config.repository}`;
  const tree = await fetcher(`${api}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`);
  if (!tree || tree.truncated !== false || !/^[a-f0-9]{40}$/.test(tree.sha) || !Array.isArray(tree.tree)) {
    throw new Error('Invalid or truncated upstream tree; keeping previous subscription');
  }
  const paths = tree.tree.filter((entry) => entry.type === 'blob' && typeof entry.path === 'string'
    && config.directories.includes(entry.path.split('/')[0]) && entry.path.endsWith('.txt'))
    .map((entry) => entry.path).sort();
  const entries = new Set();
  const files = [];
  let totalCount = 0;
  for (const path of paths) {
    const url = `https://raw.githubusercontent.com/${config.owner}/${config.repository}/${tree.sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const content = await fetcher(url);
    if (typeof content !== 'string') throw new Error(`Non-text response for ${path}`);
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      const lines = parseSubscription(content, config.schemes);
      for (const line of lines) entries.add(line);
      totalCount += lines.length;
      files.push({ path, status: lines.length ? 'included' : 'empty', count: lines.length, sha256 });
    } catch (error) {
      if (!(error instanceof UnsupportedFormatError) || !config.optionalFormatDirectories.includes(path.split('/')[0])) {
        throw new Error(`Cannot parse ${path}; keeping previous subscription`, { cause: error });
      }
      files.push({ path, status: 'unsupported', count: 0, sha256, reason: error.message });
    }
  }
  if (!entries.size) throw new Error('No usable URI entries; keeping previous subscription');
  const plain = [...entries].join('\n') + '\n';
  const report = {
    upstream: `${config.owner}/${config.repository}`, revision: tree.sha,
    uniqueCount: entries.size, inputCount: totalCount, duplicatesRemoved: totalCount - entries.size,
    deduplication: 'exact URI lines; parameters and labels preserved',
    connectionTested: false, files,
  };
  await mkdir(outputDirectory, { recursive: true });
  const outputs = {
    'all.txt': plain,
    'all-base64.txt': Buffer.from(plain, 'utf8').toString('base64') + '\n',
    'report.json': JSON.stringify(report, null, 2) + '\n',
  };
  for (const [name, content] of Object.entries(outputs)) {
    const temporary = join(outputDirectory, `${name}.tmp`);
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, join(outputDirectory, name));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(await readFile(join(projectRoot, 'sources.json'), 'utf8'));
    const report = await buildSubscription(config, join(projectRoot, 'subscriptions'));
    console.log(`Generated ${report.uniqueCount} unique entries; ${report.duplicatesRemoved} exact duplicates removed.`);
    for (const file of report.files) console.log(`${file.path}: ${file.status} (${file.count})`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = `## Subscription update\n\nChecked: ${new Date().toISOString()}\n\nUpstream revision: \`${report.revision}\`\n\nUnique entries: ${report.uniqueCount}\n\n`
        + report.files.map((file) => `- \`${file.path}\`: ${file.status}, ${file.count} entries`).join('\n') + '\n';
      await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Subscription build failed');
    process.exitCode = 1;
  }
}
