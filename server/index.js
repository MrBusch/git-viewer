const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, worktreeStatus, mergedState, defaultBranch, commitDetail, worktreeChanges, discoverRepos, repoSummary, repoDetail, listWorktrees, localBranches, remoteBranches, isValidBranchName, mapLimit } = require('./git');

const { commitFiles, pushBranch } = require('./commit');
const { repoPullRequests } = require('./prs');
const { fileDiff, discardChange, undoDiscard, pruneBackups } = require('./files');

const { readConfig, addExtraRepo, removeExtraRepo, getMainLink, setMainLink } = require('./config');

const PORT = Number(process.env.PORT) || 3024;
const HOST = '127.0.0.1';

// Folders scanned (one level deep) for repositories: GIT_VIEWER_ROOTS=dir1:dir2, else "roots" in the
// config file, else the home folder.
const configRoots = readConfig().roots;
const ROOTS = (process.env.GIT_VIEWER_ROOTS || (configRoots.length ? configRoots.join(':') : os.homedir()))
  .split(':')
  .filter(Boolean)
  .map((r) => path.resolve(r.replace(/^~(?=$|\/)/, os.homedir())));

const app = express();
app.use(express.json());

// Only accept requests addressed to this machine, and no cross-site browser requests.
// This blocks other web pages (and DNS-rebinding tricks) from driving git on your machine.
app.use('/api', (req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1'].includes(host)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    res.status(e.status || 500).json({ error: e.message });
  });

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function allRepos() {
  return discoverRepos(ROOTS, readConfig().extraRepos);
}

function shortHome(p) {
  return p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;
}

function expandHome(p) {
  return typeof p === 'string' ? path.resolve(p.trim().replace(/^~(?=$|\/)/, os.homedir())) : p;
}

function findRepo(name) {
  const repo = allRepos().find((r) => r.name === name);
  if (!repo) throw httpError(404, `Repository "${name}" not found`);
  return repo;
}

// Resolve a worktree path from the client against the repo's actual worktree list.
async function findWorktree(repo, wtPath) {
  const worktrees = await listWorktrees(repo.path);
  const wt = worktrees.find((w) => w.path === wtPath);
  if (!wt) throw httpError(400, `Not a worktree of ${repo.name}: ${wtPath}`);
  return { wt, worktrees };
}

async function requireLocalBranch(repo, name) {
  const locals = await localBranches(repo.path);
  const b = locals.find((l) => l.name === name);
  if (!b) throw httpError(400, `No local branch "${name}"`);
  return b;
}

async function requireRemoteBranch(repo, name) {
  const { branches } = await remoteBranches(repo.path);
  const r = branches.find((b) => b.name === name);
  if (!r) throw httpError(400, `No remote branch "${name}"`);
  return r;
}

async function requireNewBranchName(repo, name) {
  if (!(await isValidBranchName(name))) throw httpError(400, `"${name}" is not a valid branch name`);
  const locals = await localBranches(repo.path);
  if (locals.some((l) => l.name === name)) throw httpError(400, `Local branch "${name}" already exists`);
}

function suggestWorktreePath(repo, branch) {
  const slug = branch.replace(/^[^/]+\//, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(path.dirname(repo.path), `${repo.name}-${slug}`);
}

function validateNewWorktreePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw httpError(400, 'Worktree path must be absolute');
  if (fs.existsSync(p)) throw httpError(400, `Path already exists: ${p}`);
  if (!fs.existsSync(path.dirname(p))) throw httpError(400, `Parent folder does not exist: ${path.dirname(p)}`);
}

// ─── Main-repo links ──────────────────────────────────────────────────────────
// A worktree's branch "opened in main", either as a detached copy (snapshot) or by moving the branch.
// Returns null (and forgets the link) once the main repo has been switched to something else by hand.

async function resolveMainLink(repo, worktrees) {
  const link = getMainLink(repo.path);
  if (!link) return null;
  const main = worktrees[0];
  const valid = link.mode === 'snapshot' ? main.detached : main.branch === link.branch;
  if (!valid) {
    setMainLink(repo.path, null);
    return null;
  }
  const out = { ...link };
  if (link.mode === 'snapshot') {
    try {
      // ahead = commits made in main while detached; behind = new commits on the branch.
      const [ahead, behind] = (await git(main.path, ['rev-list', '--left-right', '--count', `HEAD...refs/heads/${link.branch}`])).trim().split(/\s+/).map(Number);
      Object.assign(out, { ahead, behind });
    } catch {
      out.branchMissing = true;
    }
  } else {
    const from = worktrees.find((w) => w.path === link.from);
    out.fromDetached = !!from && from.detached;
  }
  return out;
}

async function fallbackBranch(repo) {
  const names = new Set((await localBranches(repo.path)).map((b) => b.name));
  return ['main', 'master', 'develop'].find((n) => names.has(n)) || null;
}

// ─── Read endpoints ───────────────────────────────────────────────────────────

app.get(
  '/api/repos',
  wrap(async (req, res) => {
    const repos = await mapLimit(allRepos(), 6, repoSummary);
    const { mainLinks } = readConfig();
    for (const r of repos) {
      const link = mainLinks[r.path];
      if (link?.mode === 'snapshot' && !r.branch) r.copyOf = link.branch;
    }
    res.json({ roots: ROOTS, home: os.homedir(), repos });
  })
);

app.get(
  '/api/repos/:name',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const detail = await repoDetail(repo);
    detail.mainLink = await resolveMainLink(repo, detail.worktrees);
    res.json(detail);
  })
);

app.get(
  '/api/repos/:name/commit/:hash',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { hash } = req.params;
    if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw httpError(400, 'Invalid commit hash');
    res.json(await commitDetail(repo.path, hash));
  })
);

app.get(
  '/api/repos/:name/changes',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { wt } = await findWorktree(repo, String(req.query.worktree || ''));
    res.json(await worktreeChanges(wt.path));
  })
);

const GROUPS = ['staged', 'unstaged', 'untracked', 'conflicted'];

// Small facts the standalone file view needs without loading every repository.
app.get('/api/meta', (req, res) => res.json({ home: os.homedir() }));

app.get(
  '/api/repos/:name/diff',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { wt } = await findWorktree(repo, String(req.query.worktree || ''));
    const group = String(req.query.group);
    if (!GROUPS.includes(group)) throw httpError(400, 'Invalid group');
    const diff = await fileDiff(wt.path, group, String(req.query.path || ''), { full: req.query.full === '1' });
    if (!diff) throw httpError(404, 'No changes left in this file');
    res.json(diff);
  })
);

app.post(
  '/api/repos/:name/discard',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { worktree, group, path: file } = req.body;
    const { wt } = await findWorktree(repo, worktree);
    if (!GROUPS.includes(group)) throw httpError(400, 'Invalid group');
    const undoId = await discardChange(wt.path, group, file);
    const what = { unstaged: 'unstaged changes to', staged: 'all changes to', untracked: 'new file' }[group];
    res.json({ ok: true, message: `Discarded ${what} ${file}`, undoId });
  })
);

app.post(
  '/api/repos/:name/commit',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { wt } = await findWorktree(repo, req.body.worktree);
    const r = await commitFiles(wt, req.body.paths, req.body.message);
    res.json({ ok: true, message: `Committed ${r.count} file${r.count > 1 ? 's' : ''} to ${r.branch} (${r.hash})`, branch: r.branch, hash: r.hash });
  })
);

app.post(
  '/api/repos/:name/push',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { branch } = req.body;
    const r = await pushBranch(repo.path, branch);
    const where = `${r.remote}/${r.target}`;
    const message = r.upToDate ? `${where} is already up to date` : r.setUpstream ? `Pushed ${branch} to ${where} and set it as upstream` : `Pushed ${branch} to ${where}`;
    res.json({ ok: true, message, prUrl: r.prUrl });
  })
);

app.post(
  '/api/undo-discard',
  wrap(async (req, res) => {
    const meta = undoDiscard(String(req.body.id || ''));
    res.json({ ok: true, message: `Restored ${meta.path}` });
  })
);

// Pull requests for the repo's local branches, via the GitHub CLI. ?fresh=1 skips the one-minute cache.
app.get(
  '/api/repos/:name/prs',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    res.json(await repoPullRequests(repo.path, { fresh: req.query.fresh === '1' }));
  })
);

app.get(
  '/api/repos/:name/suggest-worktree-path',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    res.json({ path: suggestWorktreePath(repo, String(req.query.branch || 'new')) });
  })
);

// ─── Adding repositories ──────────────────────────────────────────────────────

// https://…, ssh://…, git://…, or scp-style user@host:path. Nothing starting with "-", no ext:: transports.
const CLONE_URL = /^(https?:\/\/|ssh:\/\/|git:\/\/)[^\s]+$|^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

function nameForPath(repoPath) {
  return allRepos().find((r) => r.path === repoPath)?.name;
}

// Repos cloned outside the scanned folders are remembered in config.json.
function rememberIfNotScanned(repoPath) {
  if (!ROOTS.map((r) => path.resolve(r)).includes(path.dirname(repoPath))) addExtraRepo(repoPath);
}

app.post(
  '/api/clone',
  wrap(async (req, res) => {
    const { url, parentDir, folderName } = req.body;
    if (typeof url !== 'string' || !CLONE_URL.test(url.trim())) throw httpError(400, 'Enter an https://, ssh:// or git@host:path URL');
    if (typeof folderName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(folderName)) throw httpError(400, 'Folder name may only contain letters, numbers, ".", "_" and "-"');
    const parent = expandHome(parentDir || ROOTS[0]);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw httpError(400, `Folder does not exist: ${parent}`);
    const dest = path.join(parent, folderName);
    if (fs.existsSync(dest)) throw httpError(409, `${dest} already exists`);

    await git(parent, ['clone', '--', url.trim(), dest], { timeout: 15 * 60 * 1000 });
    rememberIfNotScanned(dest);
    res.json({ ok: true, message: `Cloned into ${dest}`, name: nameForPath(dest) });
  })
);

app.post(
  '/api/add-existing',
  wrap(async (req, res) => {
    const dir = expandHome(req.body.path);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `Folder does not exist: ${req.body.path}`);
    let commonDir;
    try {
      commonDir = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    } catch {
      throw httpError(400, `${dir} is not inside a git repository`);
    }
    if (path.basename(commonDir) !== '.git') throw httpError(400, 'Bare repositories are not supported');
    // A worktree or subfolder resolves to its main repository.
    const repoPath = path.dirname(commonDir);

    const existing = nameForPath(repoPath);
    if (existing) return res.json({ ok: true, message: `${existing} is already in the list`, name: existing });
    addExtraRepo(repoPath);
    res.json({ ok: true, message: `Added ${repoPath}`, name: nameForPath(repoPath) });
  })
);

// Hide a hand-added repository again. Never touches the files.
app.post(
  '/api/repos/:name/remove-from-list',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    if (!repo.added) throw httpError(400, `${repo.name} is found automatically in a scanned folder and can't be removed from the list`);
    removeExtraRepo(repo.path);
    res.json({ ok: true, message: `Removed ${repo.name} from the list (files untouched)` });
  })
);

// ─── Actions ──────────────────────────────────────────────────────────────────

app.post(
  '/api/repos/:name/fetch',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    await git(repo.path, ['fetch', '--all', '--prune'], { timeout: 180000 });
    res.json({ ok: true, message: 'Fetched all remotes' });
  })
);

// Switch an existing worktree to an existing local branch.
app.post(
  '/api/repos/:name/switch',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { worktree, branch } = req.body;
    const { wt, worktrees } = await findWorktree(repo, worktree);
    await requireLocalBranch(repo, branch);
    const elsewhere = worktrees.find((w) => w.branch === branch && w.path !== wt.path);
    if (elsewhere) throw httpError(409, `"${branch}" is already checked out in ${elsewhere.path}`);
    await git(wt.path, ['switch', '--no-guess', branch]);
    res.json({ ok: true, message: `Switched ${path.basename(wt.path)} to ${branch}` });
  })
);

// Create a local branch from a remote branch. mode: "branch" | "switch" | "worktree"
app.post(
  '/api/repos/:name/checkout-remote',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { remoteBranch, localName, mode, worktree, worktreePath } = req.body;
    await requireRemoteBranch(repo, remoteBranch);
    await requireNewBranchName(repo, localName);

    if (mode === 'branch') {
      await git(repo.path, ['branch', '--track', localName, remoteBranch]);
      return res.json({ ok: true, message: `Created ${localName} tracking ${remoteBranch}` });
    }
    if (mode === 'switch') {
      const { wt } = await findWorktree(repo, worktree);
      await git(wt.path, ['switch', '--create', localName, '--track', remoteBranch]);
      return res.json({ ok: true, message: `Created ${localName} and switched ${path.basename(wt.path)} to it` });
    }
    if (mode === 'worktree') {
      validateNewWorktreePath(worktreePath);
      await git(repo.path, ['worktree', 'add', '--track', '-b', localName, worktreePath, remoteBranch], { timeout: 120000 });
      return res.json({ ok: true, message: `Created worktree ${worktreePath} on ${localName}` });
    }
    throw httpError(400, `Unknown mode "${mode}"`);
  })
);

// Check out a branch in the main worktree, even when another worktree has it.
// mode "snapshot": main gets the branch's commit detached; the worktree keeps the branch.
// mode "move":     the worktree is detached (same commit, files untouched) and main takes the branch.
app.post(
  '/api/repos/:name/open-in-main',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { branch, mode } = req.body;
    if (!['snapshot', 'move'].includes(mode)) throw httpError(400, `Unknown mode "${mode}"`);
    await requireLocalBranch(repo, branch);
    const worktrees = await listWorktrees(repo.path);
    const main = worktrees[0];
    if (main.branch === branch) throw httpError(409, `The main repo is already on ${branch}`);

    const existing = await resolveMainLink(repo, worktrees);
    if (existing?.mode === 'moved') throw httpError(409, `The main repo still has ${existing.branch} from ${path.basename(existing.from)}. Return it first.`);
    if (existing?.mode === 'snapshot' && existing.ahead > 0) {
      throw httpError(409, `The main repo has ${existing.ahead} commit(s) made on the detached copy of ${existing.branch}. Put them on a branch in a terminal first.`);
    }
    const previousBranch = existing?.previousBranch ?? main.branch ?? (await fallbackBranch(repo));
    const holder = worktrees.find((w) => w.branch === branch && !w.isMain);

    if (mode === 'snapshot') {
      await git(main.path, ['switch', '--detach', branch]);
      setMainLink(repo.path, { mode: 'snapshot', branch, from: holder?.path || null, previousBranch });
      return res.json({ ok: true, message: `Main repo now has a copy of ${branch} (detached)` });
    }

    if (!holder) {
      await git(main.path, ['switch', '--no-guess', branch]);
      setMainLink(repo.path, null);
      return res.json({ ok: true, message: `Switched main repo to ${branch}` });
    }
    const status = await worktreeStatus(holder);
    if (status.operation) throw httpError(409, `${path.basename(holder.path)} has a ${status.operation} in progress`);

    await git(holder.path, ['switch', '--detach']);
    try {
      await git(main.path, ['switch', '--no-guess', branch]);
    } catch (e) {
      await git(holder.path, ['switch', '--no-guess', branch]).catch(() => {}); // give the branch back
      throw e;
    }
    setMainLink(repo.path, { mode: 'moved', branch, from: holder.path, previousBranch });
    res.json({ ok: true, message: `Moved ${branch} from ${path.basename(holder.path)} to the main repo` });
  })
);

// Bring a detached copy in main up to the branch's latest commit.
app.post(
  '/api/repos/:name/update-main-copy',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const worktrees = await listWorktrees(repo.path);
    const link = await resolveMainLink(repo, worktrees);
    if (link?.mode !== 'snapshot') throw httpError(400, 'The main repo is not on a copy of a branch');
    if (link.ahead > 0) throw httpError(409, `The main repo has ${link.ahead} commit(s) not on ${link.branch}. Put them on a branch in a terminal first.`);
    if (!link.behind) return res.json({ ok: true, message: `Already at the latest ${link.branch}` });
    await git(worktrees[0].path, ['switch', '--detach', link.branch]);
    res.json({ ok: true, message: `Updated main repo to the latest ${link.branch} (${link.behind} new commit(s))` });
  })
);

// Undo open-in-main: main goes back to its previous branch; a moved branch goes back to its worktree.
app.post(
  '/api/repos/:name/release-main',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const worktrees = await listWorktrees(repo.path);
    const main = worktrees[0];
    const link = await resolveMainLink(repo, worktrees);
    if (!link) throw httpError(400, 'Nothing to return');
    if (link.mode === 'snapshot' && link.ahead > 0) {
      throw httpError(409, `The main repo has ${link.ahead} commit(s) made on the detached copy. Put them on a branch in a terminal first, or they'd be left behind.`);
    }
    const target = link.previousBranch || (await fallbackBranch(repo));
    if (!target) throw httpError(400, 'No branch to switch the main repo back to');

    await git(main.path, ['switch', '--no-guess', target]);
    setMainLink(repo.path, null);
    let message = `Main repo back on ${target}`;

    if (link.mode === 'moved') {
      const from = worktrees.find((w) => w.path === link.from);
      const name = link.from ? path.basename(link.from) : 'the worktree';
      if (!from || !from.detached) {
        message += `. ${name} is no longer detached, so it was left as is.`;
      } else {
        // Commits made in the detached worktree would be orphaned by switching it back.
        const extra = Number((await git(from.path, ['rev-list', '--count', `refs/heads/${link.branch}..HEAD`])).trim());
        if (extra > 0) {
          message += `. ${name} has ${extra} commit(s) made while detached, so it was left detached. Move them onto ${link.branch} in a terminal.`;
        } else {
          try {
            await git(from.path, ['switch', '--no-guess', link.branch]);
            message += `; ${link.branch} returned to ${name}`;
          } catch (e) {
            message += `. Couldn't switch ${name} back to ${link.branch}: ${e.message}`;
          }
        }
      }
    }
    res.json({ ok: true, message });
  })
);

// Delete a finished branch: remove its worktree folder and/or the local branch.
// Unmerged work or uncommitted changes need force: true (the UI asks you to type the branch name).
app.post(
  '/api/repos/:name/cleanup',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { branch, removeWorktree, deleteBranch, force } = req.body;
    if (!removeWorktree && !deleteBranch) throw httpError(400, 'Nothing to do');
    const locals = await localBranches(repo.path);
    if (!locals.some((b) => b.name === branch)) throw httpError(400, `No local branch "${branch}"`);
    const base = await defaultBranch(repo.path, new Set(locals.map((b) => b.name)));
    if (base && branch === base.name) throw httpError(400, `Won't delete the default branch ${branch}`);

    const worktrees = await listWorktrees(repo.path);
    const wt = worktrees.find((w) => w.branch === branch);
    if (wt?.isMain) throw httpError(409, `${branch} is checked out in the main repo. Switch the main repo to another branch first.`);
    if (removeWorktree && !wt) throw httpError(400, `${branch} isn't checked out in a worktree`);
    if (deleteBranch && wt && !removeWorktree) throw httpError(409, `${branch} is checked out in ${wt.path}. Remove the worktree too, or switch it first.`);
    if (wt?.locked) throw httpError(409, `${path.basename(wt.path)} is locked (git worktree unlock it first)`);

    const link = await resolveMainLink(repo, worktrees);
    if (link && (link.branch === branch || (wt && link.from === wt.path))) {
      throw httpError(409, `${branch} is open in the main repo. Return it or switch main back first.`);
    }

    // Re-check on the server; don't trust what the page last saw.
    const reasons = [];
    const merged = base ? await mergedState(repo.path, base.remoteRef || base.ref, branch) : 'not-merged';
    if (deleteBranch && merged === 'not-merged') reasons.push(`${branch} has commits that aren't in ${base?.remoteRef || 'the default branch'}`);
    if (wt && removeWorktree) {
      const st = (await worktreeStatus(wt)).status;
      if (st && (st.dirty || st.untracked)) reasons.push(`${path.basename(wt.path)} has uncommitted or untracked files`);
    }
    if (reasons.length && !force) throw httpError(409, `Not deleted: ${reasons.join('; ')}.`);

    const done = [];
    if (wt && removeWorktree) {
      await git(repo.path, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], { timeout: 180000 });
      done.push(`removed ${shortHome(wt.path)}`);
    }
    if (deleteBranch) {
      await git(repo.path, ['branch', '-D', branch]);
      done.push(`deleted branch ${branch}`);
    }
    const msg = done.join(' and ');
    res.json({ ok: true, message: msg.charAt(0).toUpperCase() + msg.slice(1) });
  })
);

// Make an existing local branch track a remote branch (e.g. origin/<same name>).
app.post(
  '/api/repos/:name/set-upstream',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { branch, remoteBranch } = req.body;
    await requireLocalBranch(repo, branch);
    await requireRemoteBranch(repo, remoteBranch);
    await git(repo.path, ['branch', `--set-upstream-to=${remoteBranch}`, branch]);
    res.json({ ok: true, message: `${branch} now tracks ${remoteBranch}` });
  })
);

// Open an existing local branch in a brand-new worktree.
app.post(
  '/api/repos/:name/add-worktree',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { branch, worktreePath } = req.body;
    await requireLocalBranch(repo, branch);
    validateNewWorktreePath(worktreePath);
    await git(repo.path, ['worktree', 'add', worktreePath, branch], { timeout: 120000 });
    res.json({ ok: true, message: `Created worktree ${worktreePath} on ${branch}` });
  })
);

// Bring a local branch up to date with its upstream, fast-forward only (never creates merges).
app.post(
  '/api/repos/:name/fast-forward',
  wrap(async (req, res) => {
    const repo = findRepo(req.params.name);
    const { branch } = req.body;
    const b = await requireLocalBranch(repo, branch);
    if (!b.upstream) throw httpError(400, `"${branch}" has no upstream branch`);
    if (b.gone) throw httpError(400, `Upstream of "${branch}" no longer exists`);
    if (b.ahead > 0) throw httpError(409, `"${branch}" has ${b.ahead} local commit(s) not on ${b.upstream}, so it can't be fast-forwarded. Merge or rebase it in a terminal.`);
    if (b.behind === 0) return res.json({ ok: true, message: `${branch} is already up to date` });

    const worktrees = await listWorktrees(repo.path);
    const wt = worktrees.find((w) => w.branch === branch);
    if (wt) {
      await git(wt.path, ['merge', '--ff-only', '@{upstream}']);
    } else {
      // Updating a ref without "+" refuses anything that isn't a fast-forward.
      await git(repo.path, ['fetch', '.', `refs/remotes/${b.upstream}:refs/heads/${branch}`]);
    }
    res.json({ ok: true, message: `Fast-forwarded ${branch} to ${b.upstream}` });
  })
);

// ─── Serve built frontend ─────────────────────────────────────────────────────

const distPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

pruneBackups();

app.listen(PORT, HOST, () => {
  console.log(`Git Viewer running on http://localhost:${PORT} (scanning ${ROOTS.join(', ')})`);
});
