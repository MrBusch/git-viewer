const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Running git ──────────────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0', // never hang waiting for a credential prompt
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
};

// Arguments are passed as an array (no shell), so ref names can't inject commands.
// Resolves with stdout, or with { stdout, stderr } when withStderr is set (push reports on stderr).
function git(cwd, args, { timeout = 30000, withStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, env: GIT_ENV, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Hooks and "nothing to commit" report on stdout, so keep both.
        const out = [stderr, stdout].map((x) => (x || '').trim()).filter(Boolean).join('\n');
        const msg = out ? out.slice(-4000) : err.killed ? 'git timed out' : err.message;
        const e = new Error(msg);
        e.code = err.code;
        return reject(e);
      }
      resolve(withStderr ? { stdout, stderr } : stdout);
    });
  });
}

// Run async fn over items with limited concurrency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Repository discovery ─────────────────────────────────────────────────────

// A main repository is a directory directly under a root whose `.git` is a directory.
// Linked worktrees (`.git` is a file) are found through `git worktree list` instead.
// Repositories added by hand are listed too; a name clash gets the parent folder appended.
function discoverRepos(roots, extraPaths = []) {
  const repos = [];
  const seen = new Set();
  for (const repoPath of extraPaths) {
    if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
    seen.add(repoPath);
    repos.push({ name: path.basename(repoPath), path: repoPath, added: true });
  }
  for (const r of scanRoots(roots)) if (!seen.has(r.path)) repos.push(r);

  const counts = new Map();
  for (const r of repos) counts.set(r.name, (counts.get(r.name) || 0) + 1);
  for (const r of repos) if (counts.get(r.name) > 1 && r.added) r.name = `${r.name} (${path.basename(path.dirname(r.path))})`;

  return repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function scanRoots(roots) {
  const repos = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      try {
        if (fs.statSync(path.join(dir, '.git')).isDirectory()) {
          repos.push({ name: entry.name, path: dir });
        }
      } catch {
        // no .git here
      }
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseWorktrees(out) {
  const worktrees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      worktrees.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  worktrees.forEach((w, i) => (w.isMain = i === 0));
  return worktrees;
}

function parseStatus(out) {
  const s = { upstream: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        s.ahead = +m[1];
        s.behind = +m[2];
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') s.staged++;
      if (xy[1] !== '.') s.unstaged++;
    } else if (line.startsWith('u ')) s.conflicts++;
    else if (line.startsWith('? ')) s.untracked++;
  }
  s.dirty = s.staged + s.unstaged + s.conflicts > 0;
  return s;
}

function parseTrack(track) {
  // "%(upstream:track,nobracket)" → "ahead 2, behind 1" | "gone" | ""
  const r = { ahead: 0, behind: 0, gone: false };
  if (!track) return r;
  if (track === 'gone') r.gone = true;
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  if (a) r.ahead = +a[1];
  if (b) r.behind = +b[1];
  return r;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

async function listWorktrees(repoPath) {
  return parseWorktrees(await git(repoPath, ['worktree', 'list', '--porcelain']));
}

function inProgressOperation(gitDir) {
  const checks = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ];
  for (const [file, label] of checks) {
    if (fs.existsSync(path.join(gitDir, file))) return label;
  }
  return null;
}

async function worktreeStatus(wt) {
  if (wt.bare || wt.prunable || !fs.existsSync(wt.path)) {
    return { ...wt, missing: !fs.existsSync(wt.path), status: null };
  }
  try {
    const [statusOut, gitDir, lastCommit] = await Promise.all([
      git(wt.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
      git(wt.path, ['rev-parse', '--absolute-git-dir']),
      git(wt.path, ['log', '-1', '--format=%h%x00%s%x00%ct%x00%an']).catch(() => ''),
    ]);
    const [hash, subject, date, author] = lastCommit.trim().split('\0');
    return {
      ...wt,
      status: parseStatus(statusOut),
      operation: inProgressOperation(gitDir.trim()),
      lastCommit: hash ? { hash, subject, date: +date, author } : null,
    };
  } catch (e) {
    return { ...wt, status: null, error: e.message };
  }
}

async function defaultBranch(repoPath, localNames) {
  const remote = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    .then((s) => s.trim())
    .catch(() => null);
  if (remote) {
    const short = remote.replace(/^origin\//, '');
    return { ref: localNames.has(short) ? short : remote, name: short, remoteRef: remote };
  }
  for (const n of ['main', 'master', 'develop']) {
    if (localNames.has(n)) return { ref: n, name: n };
  }
  return null;
}

// Has `branch` landed in `base`? "merged" (its commits are in base), "squash-merged" (a commit in
// base has the same combined change, as GitHub's squash merge produces) or "not-merged".
async function mergedState(repoPath, base, branch) {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', branch, base]);
    return 'merged';
  } catch {
    // not an ancestor; try the squash check
  }
  try {
    const mergeBase = (await git(repoPath, ['merge-base', base, branch])).trim();
    const tree = (await git(repoPath, ['rev-parse', `${branch}^{tree}`])).trim();
    // A throwaway commit with the branch's net change; git cherry marks it "-" if base has an equivalent patch.
    const squash = (
      await git(repoPath, ['-c', 'user.name=git-viewer', '-c', 'user.email=git-viewer@localhost', 'commit-tree', tree, '-p', mergeBase, '-m', 'squash check'])
    ).trim();
    if ((await git(repoPath, ['cherry', base, squash])).trim().startsWith('-')) return 'squash-merged';
  } catch {
    // fall through
  }
  return 'not-merged';
}

const SEP = '%00';

async function localBranches(repoPath) {
  const fmt = ['%(refname:short)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(authorname)', '%(subject)'].join(SEP);
  const out = await git(repoPath, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, hash, upstream, track, date, author, subject] = line.split('\0');
      return { name, hash, upstream: upstream || null, ...parseTrack(track), lastCommit: { hash, subject, date: +date, author } };
    });
}

async function remoteBranches(repoPath) {
  const remotes = (await git(repoPath, ['remote'])).split('\n').filter(Boolean);
  const fmt = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(committerdate:unix)', '%(authorname)', '%(subject)', '%(symref)'].join(SEP);
  const out = await git(repoPath, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/remotes']);
  const branches = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, short, hash, date, author, subject, symref] = line.split('\0');
    if (symref) continue; // origin/HEAD
    const rest = ref.replace(/^refs\/remotes\//, '');
    // Longest matching remote name wins (remote names may contain "/").
    const remote = remotes.filter((r) => rest.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
    if (!remote) continue;
    branches.push({ name: short, remote, branch: rest.slice(remote.length + 1), hash, lastCommit: { hash, subject, date: +date, author } });
  }
  return { remotes, branches };
}

function lastFetched(repoPath) {
  try {
    return Math.floor(fs.statSync(path.join(repoPath, '.git', 'FETCH_HEAD')).mtimeMs / 1000);
  } catch {
    return null;
  }
}

async function repoSummary(repo) {
  try {
    const worktrees = await listWorktrees(repo.path);
    return { ...repo, branch: worktrees[0]?.branch || null, worktreeCount: worktrees.length };
  } catch (e) {
    return { ...repo, error: e.message };
  }
}

async function repoDetail(repo) {
  const [worktreesRaw, locals, remoteInfo, userName] = await Promise.all([
    listWorktrees(repo.path),
    localBranches(repo.path),
    remoteBranches(repo.path),
    git(repo.path, ['config', 'user.name']).then((s) => s.trim(), () => null),
  ]);

  const worktrees = await mapLimit(worktreesRaw, 6, worktreeStatus);

  const checkedOutIn = new Map();
  for (const w of worktrees) if (w.branch) checkedOutIn.set(w.branch, w.path);

  const localNames = new Set(locals.map((b) => b.name));
  const base = await defaultBranch(repo.path, localNames);

  const remoteNames = new Set(remoteInfo.branches.map((r) => r.name));
  const aheadBehind = async (left, right) => {
    try {
      const [behind, ahead] = (await git(repo.path, ['rev-list', '--left-right', '--count', `${left}...${right}`])).trim().split(/\s+/).map(Number);
      return { ahead, behind };
    } catch {
      return null;
    }
  };

  await mapLimit(locals, 8, async (b) => {
    b.worktree = checkedOutIn.get(b.name) || null;
    // Relative to the default branch.
    if (base && b.name !== base.name) b.base = await aheadBehind(base.ref, b.name);
    // No upstream configured, but a remote branch with the same name exists: compare against that.
    if (!b.upstream) {
      const match = remoteInfo.remotes.map((r) => `${r}/${b.name}`).find((n) => remoteNames.has(n));
      if (match) b.remoteMatch = { name: match, ...(await aheadBehind(match, b.name)) };
    }
    // Never pushed: no upstream and no remote branch with the same name.
    b.neverPushed = !b.upstream && !b.remoteMatch;
    // A never-pushed branch with no commits of its own was usually just created, not finished.
    b.noCommits = b.neverPushed && b.base?.ahead === 0;
    // Upstream deleted or never pushed: check whether the work landed, so it can be cleaned up safely.
    if ((b.gone || b.neverPushed) && base && b.name !== base.name) b.merged = await mergedState(repo.path, base.remoteRef || base.ref, b.name);
  });

  // Which local branch (if any) tracks each remote branch.
  const trackedBy = new Map();
  for (const b of locals) if (b.upstream) trackedBy.set(b.upstream, b.name);
  for (const r of remoteInfo.branches) {
    r.trackedBy = trackedBy.get(r.name) || null;
    r.localSameName = localNames.has(r.branch);
  }

  return {
    ...repo,
    defaultBranch: base?.name || null,
    mergeTarget: base ? base.remoteRef || base.ref : null,
    userName,
    lastFetched: lastFetched(repo.path),
    remotes: remoteInfo.remotes,
    worktrees,
    localBranches: locals,
    remoteBranches: remoteInfo.branches,
  };
}

// ─── Commit details & changed files ───────────────────────────────────────────

async function commitDetail(repoPath, hash) {
  const out = await git(repoPath, ['show', '-s', '--format=%H%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%B', hash, '--']);
  const [full, author, email, authorDate, committer, commitDate, ...body] = out.split('\0');
  return { hash: full, author, email, authorDate: +authorDate, committer, commitDate: +commitDate, message: body.join('\0').trim() };
}

// "added\tremoved\tpath\0" records → Map(path → { added, removed, binary })
function parseNumstat(out) {
  const map = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const [added, removed, ...p] = rec.split('\t');
    const binary = added === '-';
    map.set(p.join('\t'), { added: binary ? null : +added, removed: binary ? null : +removed, binary });
  }
  return map;
}

const STATUS_LABELS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

// Count lines of a new, untracked file (skips large and binary files).
function countLines(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return { added: null, binary: false };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { added: null, binary: true };
    let n = 0;
    for (const byte of buf) if (byte === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return { added: n, binary: false };
  } catch {
    return { added: null, binary: false };
  }
}

async function worktreeChanges(wtPath) {
  const [statusOut, unstagedOut, stagedOut] = await Promise.all([
    git(wtPath, ['status', '--porcelain=v2', '-z', '--no-renames', '--untracked-files=all']),
    git(wtPath, ['diff', '--numstat', '-z', '--no-renames']),
    git(wtPath, ['diff', '--cached', '--numstat', '-z', '--no-renames']),
  ]);
  const unstagedStats = parseNumstat(unstagedOut);
  const stagedStats = parseNumstat(stagedOut);

  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];

  for (const rec of statusOut.split('\0')) {
    if (!rec) continue;
    if (rec.startsWith('1 ')) {
      const parts = rec.split(' ');
      const xy = parts[1];
      const file = parts.slice(8).join(' ');
      if (xy[0] !== '.') staged.push({ path: file, status: STATUS_LABELS[xy[0]] || xy[0], ...stagedStats.get(file) });
      if (xy[1] !== '.') unstaged.push({ path: file, status: STATUS_LABELS[xy[1]] || xy[1], ...unstagedStats.get(file) });
    } else if (rec.startsWith('u ')) {
      conflicted.push({ path: rec.split(' ').slice(10).join(' '), status: 'conflict' });
    } else if (rec.startsWith('? ')) {
      const file = rec.slice(2);
      untracked.push({ path: file, status: 'new', removed: 0, ...countLines(path.join(wtPath, file)) });
    }
  }
  return { staged, unstaged, untracked, conflicted };
}

async function isValidBranchName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
  try {
    await git(process.cwd(), ['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { git, worktreeStatus, mergedState, defaultBranch, commitDetail, worktreeChanges, discoverRepos, repoSummary, repoDetail, listWorktrees, localBranches, remoteBranches, isValidBranchName, mapLimit };
