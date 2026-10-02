const { execFile } = require('child_process');
const { git, localBranches, defaultBranch, tracksDefaultBranch } = require('./git');

// Pull-request info comes from the GitHub CLI (`gh api graphql`), so it reuses `gh auth login`
// and the app never handles a token. Results are cached briefly to stay far below rate limits.

const CACHE_MS = 60 * 1000;
const CHUNK = 25; // branches per GraphQL query
const cache = new Map(); // repoPath → { at, data }

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error((stderr || err.message).trim()), { code: err.code }));
      resolve(stdout);
    });
  });
}

// git@github.com:owner/repo.git, ssh://git@github.com/owner/repo, https://github.com/owner/repo(.git)
function parseGitHubRemote(url) {
  const m = url.trim().match(/^(?:[\w.-]+@([\w.-]+):|(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const host = m[1] || m[2];
  // github.com, or a GitHub Enterprise host gh is logged in to (gh reports the error otherwise).
  return { host, owner: m[3], name: m[4] };
}

const PR_FIELDS = `
  number title url state isDraft reviewDecision
  headRepositoryOwner { login }
  comments { totalCount }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }`;

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function summarizeChecks(rollup) {
  if (!rollup) return null;
  const out = { state: rollup.state, passed: 0, failed: 0, pending: 0, failing: [] };
  for (const c of rollup.contexts.nodes) {
    let result;
    if (c.__typename === 'CheckRun') result = c.status !== 'COMPLETED' ? 'pending' : PASS.has(c.conclusion) ? 'passed' : 'failed';
    else result = c.state === 'SUCCESS' ? 'passed' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending' : 'failed';
    out[result]++;
    if (result === 'failed') out.failing.push(c.name || c.context);
  }
  return out;
}

function summarizePr(n) {
  const threads = n.reviewThreads.nodes;
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    state: n.isDraft && n.state === 'OPEN' ? 'DRAFT' : n.state, // OPEN | DRAFT | MERGED | CLOSED
    review: n.reviewDecision, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    comments: n.comments.totalCount,
    threads: threads.length,
    unresolved: threads.filter((t) => !t.isResolved).length,
    checks: n.state === 'OPEN' ? summarizeChecks(n.commits.nodes[0]?.commit.statusCheckRollup) : null,
  };
}

// Several PRs can share a head branch name (old closed ones, forks). Prefer this repo's own, then open ones.
function pickPr(nodes, owner) {
  const rank = (n) => (n.headRepositoryOwner?.login?.toLowerCase() === owner.toLowerCase() ? 0 : 2) + (n.state === 'OPEN' ? 0 : 1);
  return [...nodes].sort((a, b) => rank(a) - rank(b))[0] || null;
}

async function fetchPrs(gh_, repo, heads) {
  const result = {};
  for (let i = 0; i < heads.length; i += CHUNK) {
    const chunk = heads.slice(i, i + CHUNK);
    const vars = chunk.map((_, j) => `$h${j}: String!`).join(', ');
    const fields = chunk
      .map((_, j) => `b${j}: pullRequests(headRefName: $h${j}, first: 3, orderBy: { field: CREATED_AT, direction: DESC }, states: [OPEN, MERGED, CLOSED]) { nodes { ${PR_FIELDS} } }`)
      .join('\n');
    const query = `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const args = ['api', 'graphql', '--hostname', gh_.host, '-F', `owner=${gh_.owner}`, '-F', `name=${gh_.name}`, '-f', `query=${query}`];
    chunk.forEach((h, j) => args.push('-f', `h${j}=${h}`));
    const data = JSON.parse(await gh(args)).data.repository;
    chunk.forEach((h, j) => {
      const pr = pickPr(data[`b${j}`].nodes, gh_.owner);
      if (pr) result[h] = summarizePr(pr);
    });
  }
  return result;
}

// { status: 'ok', byBranch: { localBranch: pr }, compareBase } or { status: 'unavailable' | 'no-github', message }
async function repoPullRequests(repoPath, { fresh = false } = {}) {
  const hit = cache.get(repoPath);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const originUrl = await git(repoPath, ['remote', 'get-url', 'origin']).catch(() => '');
  const remote = parseGitHubRemote(originUrl);
  if (!remote) return { status: 'no-github' };

  const locals = await localBranches(repoPath);
  const base = await defaultBranch(repoPath, new Set(locals.map((b) => b.name)));
  // The PR's head is the branch name on origin, which can differ from the local name.
  const headFor = new Map();
  const remotes = (await git(repoPath, ['remote'])).split('\n').filter(Boolean);
  for (const b of locals) {
    if (base && b.name === base.name) continue;
    // A branch tracking the default branch has no PR under that name (it would match old master PRs).
    if (tracksDefaultBranch(b, base, remotes)) headFor.set(b.name, b.name);
    else if (b.upstream?.startsWith('origin/')) headFor.set(b.name, b.upstream.slice('origin/'.length));
    else if (!b.upstream) headFor.set(b.name, b.name); // pushed-but-untracked, or never pushed (simply no PR)
  }

  let data;
  try {
    const prs = await fetchPrs(remote, repoPath, [...new Set(headFor.values())]);
    const byBranch = {};
    for (const [local, head] of headFor) if (prs[head]) byBranch[local] = prs[head];
    const web = remote.host === 'github.com' ? 'https://github.com' : `https://${remote.host}`;
    data = { status: 'ok', byBranch, compareBase: `${web}/${remote.owner}/${remote.name}/compare/` };
  } catch (e) {
    const message =
      e.code === 'ENOENT'
        ? 'Install the GitHub CLI (gh) to see pull requests here.'
        : /auth|login|401|credentials/i.test(e.message)
          ? 'Run `gh auth login` to see pull requests here.'
          : `Couldn't load pull requests: ${e.message.split('\n')[0]}`;
    data = { status: 'unavailable', message };
  }
  cache.set(repoPath, { at: Date.now(), data });
  return data;
}

module.exports = { repoPullRequests, parseGitHubRemote };
