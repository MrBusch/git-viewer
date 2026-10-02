const path = require('path');
const { git, worktreeStatus, worktreeChanges, localBranches, remoteBranches, defaultBranch, tracksDefaultBranch } = require('./git');

const lit = (args) => ['--literal-pathspecs', ...args];
const LONG = { timeout: 5 * 60 * 1000 }; // hooks can be slow

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Commit exactly the given files, as they are on disk. Other staged changes stay staged and are left out.
async function commitFiles(wt, paths, message) {
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p)) throw httpError(400, 'Pick at least one file');
  const msg = typeof message === 'string' ? message.trim() : '';
  if (!msg) throw httpError(400, 'Write a commit message');
  if (!wt.branch) throw httpError(409, `${path.basename(wt.path)} isn't on a branch (detached HEAD). Switch it to a branch before committing.`);

  const status = await worktreeStatus(wt);
  if (status.operation) throw httpError(409, `${path.basename(wt.path)} has a ${status.operation} in progress. Finish it in a terminal first.`);

  const changes = await worktreeChanges(wt.path);
  if (changes.conflicted.length) throw httpError(409, 'Resolve the conflicted files before committing');
  const known = new Set([...changes.staged, ...changes.unstaged, ...changes.untracked].map((f) => f.path));
  const unknown = paths.filter((p) => !known.has(p));
  if (unknown.length) throw httpError(400, `No longer changed: ${unknown.join(', ')}. Refresh and try again.`);

  const unique = [...new Set(paths)];
  const untracked = new Set(changes.untracked.map((f) => f.path));
  const newFiles = unique.filter((p) => untracked.has(p));

  // --only needs git to know about new files, so add them first; undo that if the commit fails.
  if (newFiles.length) await git(wt.path, lit(['add', '--', ...newFiles]));
  try {
    await git(wt.path, lit(['commit', '--only', '-m', msg, '--', ...unique]), LONG);
  } catch (e) {
    if (newFiles.length) await git(wt.path, lit(['reset', '-q', '--', ...newFiles])).catch(() => {});
    throw httpError(400, e.message);
  }
  const hash = (await git(wt.path, ['rev-parse', '--short', 'HEAD'])).trim();
  return { hash, branch: wt.branch, count: unique.length };
}

function findPrUrl(text) {
  return (text.match(/https?:\/\/\S+\/(?:pull\/new|merge_requests\/new|pull-requests\/new)\S*/) || [])[0] || null;
}

// Push a local branch. Never forces. A branch without an upstream gets one (-u).
async function pushBranch(repoPath, branch) {
  const locals = await localBranches(repoPath);
  const b = locals.find((l) => l.name === branch);
  if (!b) throw httpError(400, `No local branch "${branch}"`);
  if (b.gone) throw httpError(409, `The remote branch ${b.upstream} was deleted, probably after a merge. Pushing would bring it back.`);

  const { remotes, branches } = await remoteBranches(repoPath);
  if (!remotes.length) throw httpError(400, 'This repository has no remote to push to');

  // A feature branch that tracks the default branch (created from origin/master) must not push into it.
  const base = await defaultBranch(repoPath, new Set(locals.map((l) => l.name)));
  const ownUpstream = b.upstream && !tracksDefaultBranch(b, base, remotes);

  let remote;
  let target;
  let setUpstream = false;
  if (ownUpstream) {
    remote = remotes.filter((r) => b.upstream.startsWith(r + '/')).sort((x, y) => y.length - x.length)[0];
    if (!remote) throw httpError(400, `Can't tell which remote ${b.upstream} belongs to`);
    target = b.upstream.slice(remote.length + 1);
  } else {
    // A same-name remote branch if one exists, else origin (or the only remote).
    const match = branches.find((r) => r.branch === branch);
    remote = match ? match.remote : remotes.includes('origin') ? 'origin' : remotes[0];
    target = branch;
    setUpstream = true;
  }

  let stderr;
  try {
    ({ stderr } = await git(repoPath, ['push', ...(setUpstream ? ['-u'] : []), '--', remote, `refs/heads/${branch}:refs/heads/${target}`], { ...LONG, withStderr: true }));
  } catch (e) {
    if (/\[rejected\].*(non-fast-forward|fetch first)/.test(e.message)) {
      throw httpError(409, `Rejected: ${remote}/${target} has commits that ${branch} doesn't. Pull or rebase in a terminal, then push again.`);
    }
    throw httpError(400, e.message);
  }
  if (/Everything up-to-date/.test(stderr)) return { remote, target, setUpstream, upToDate: true, prUrl: null };
  // GitHub, GitLab and Bitbucket print a "create a pull/merge request" link for new branches.
  return { remote, target, setUpstream, prUrl: findPrUrl(stderr) };
}

module.exports = { commitFiles, pushBranch, findPrUrl };
