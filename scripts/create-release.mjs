import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Create (or reuse) the GitHub Release for the tag being built.
 *
 * Run by the `release-setup` CI job *before* the per-platform publish matrix, because
 * electron-builder jobs racing to create the same release get a 422 from GitHub and the
 * failure looks like a flaky pipeline rather than a design problem.
 *
 * Auth comes from the workflow's built-in `GH_TOKEN`; nothing is written to disk and no
 * personal credential is involved.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[release] 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return value;
}

async function readVersion() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  return pkg.version ?? '0.0.0';
}

// Node's global fetch, referenced explicitly: the eslint env for `scripts/` does not
// declare browser/DOM globals, so a bare `fetch` here would be an undefined name.
const fetchImpl = globalThis.fetch;

async function github(url, init, token) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('此 Node 版本没有全局 fetch，请使用 Node 18 及以上运行');
  }
  const response = await fetchImpl(`https://api.github.com${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON gateway errors come back as HTML */
  }
  return { ok: response.ok, status: response.status, json, text };
}

function emitOutput(id) {
  // GITHUB_OUTPUT lets the matrix jobs reference the release without re-querying.
  // Synchronous on purpose: an async append can be cut off by process exit.
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `release_id=${id}\n`);
}

async function main() {
  const token = required('GH_TOKEN');
  const repo = required('RELEASE_REPO');
  const tag = required('RELEASE_TAG');
  const version = await readVersion();
  // A tag that disagrees with package.json means the artifact will announce a version
  // the updater cannot match against, so say it out loud instead of failing silently.
  if (tag !== `v${version}`) {
    console.warn(`[release] 警告：标签 ${tag} 与 package.json 版本 v${version} 不一致`);
  }

  const body = {
    tag_name: tag,
    name: `FreeLLM Hub ${tag}`,
    draft: false,
    prerelease: false,
    // GitHub writes the contributor list; the hand-authored notes live in the
    // release description that a maintainer can amend afterwards.
    generate_release_notes: true,
  };

  const created = await github(`/repos/${repo}/releases`, { method: 'POST', body: JSON.stringify(body) }, token);
  if (created.ok && created.json?.id) {
    console.log(`[release] created ${tag} -> id ${created.json.id}`);
    emitOutput(created.json.id);
    return;
  }

  // 422 usually means the tag already has a release (re-running a failed job).
  const existing = await github(`/repos/${repo}/releases/tags/${tag}`, { method: 'GET' }, token);
  if (existing.ok && existing.json?.id) {
    console.log(`[release] reusing existing release id ${existing.json.id} for ${tag}`);
    // Keep the title/body in sync with the version actually being published.
    await github(
      `/repos/${repo}/releases/${existing.json.id}`,
      { method: 'PATCH', body: JSON.stringify({ name: `FreeLLM Hub ${tag}` }) },
      token
    );
    emitOutput(existing.json.id);
    return;
  }

  console.error(
    `[release] 无法创建或找到 release\nPOST -> ${created.status} ${created.text.slice(0, 400)}\nGET  -> ${existing.status} ${existing.text.slice(0, 200)}`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[release] 异常:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
