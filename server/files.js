const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { git, worktreeChanges } = require('./git');

// Paths are always passed literally (no glob magic like "*" in a file name).
const lit = (args) => ['--literal-pathspecs', ...args];

const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
const FULL_CONTEXT = 1000000;

// The file must be one of the worktree's current changes in that group; nothing else can be read or discarded.
async function findChange(wtPath, group, file) {
  const changes = await worktreeChanges(wtPath);
  if (!changes[group]) return null;
  return changes[group].find((f) => f.path === file) || null;
}

// ─── Diff parsing ─────────────────────────────────────────────────────────────

function parseUnifiedDiff(out) {
  if (/^Binary files .* differ$/m.test(out)) return { binary: true, hunks: [] };
  const hunks = [];
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      oldNo = +m[1];
      newNo = +m[2];
      hunk = { header: line, section: m[3].trim(), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // file headers
    if (line.startsWith('+')) hunk.lines.push({ type: 'add', newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith('-')) hunk.lines.push({ type: 'del', oldNo: oldNo++, text: line.slice(1) });
    else if (line.startsWith(' ')) hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith('\\')) hunk.lines.push({ type: 'note', text: line.slice(2) });
  }
  return { binary: false, hunks };
}

function readTextFile(abs) {
  const lst = fs.lstatSync(abs);
  if (lst.isSymbolicLink()) return { lines: [`symlink → ${fs.readlinkSync(abs)}`] };
  const stat = lst;
  if (stat.size > MAX_PREVIEW_BYTES) return { tooLarge: true, size: stat.size };
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return { binary: true };
  const text = buf.toString('utf8');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return { lines };
}

async function fileDiff(wtPath, group, file, { full } = {}) {
  const change = await findChange(wtPath, group, file);
  if (!change) return null;
  const abs = path.join(wtPath, file);
  const base = { path: file, group, status: change.status, added: change.added, removed: change.removed };

  // New file: show it as all-added lines. Conflicts: show the working file with its markers.
  if (group === 'untracked' || group === 'conflicted') {
    if (!fs.existsSync(abs)) return { ...base, hunks: [] };
    const r = readTextFile(abs);
    if (!r.lines) return { ...base, ...r, hunks: [] };
    const type = group === 'untracked' ? 'add' : 'ctx';
    return { ...base, hunks: [{ header: '', lines: r.lines.map((text, i) => ({ type, newNo: i + 1, oldNo: type === 'ctx' ? i + 1 : undefined, text })) }] };
  }

  const args = ['diff', ...(group === 'staged' ? ['--cached'] : []), `-U${full ? FULL_CONTEXT : 3}`, '--no-color', '--no-ext-diff', '--', file];
  const out = await git(wtPath, ['-c', 'core.quotepath=off', ...lit(args)]);
  if (out.length > MAX_PREVIEW_BYTES * 2) return { ...base, tooLarge: true, hunks: [] };
  return { ...base, ...parseUnifiedDiff(out) };
}

// ─── Discard with backup ──────────────────────────────────────────────────────

const BACKUP_DIR = process.env.GIT_VIEWER_BACKUPS || path.join(os.homedir(), '.git-viewer', 'discarded');
const BACKUP_DAYS = 7;

function pruneBackups() {
  try {
    const cutoff = Date.now() - BACKUP_DAYS * 86400000;
    for (const id of fs.readdirSync(BACKUP_DIR)) {
      const dir = path.join(BACKUP_DIR, id);
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // no backups yet
  }
}

// Copy the current file aside so a discard can be undone.
function backup(wtPath, file) {
  const abs = path.join(wtPath, file);
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(BACKUP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  let exists = false;
  let link = null;
  try {
    const lst = fs.lstatSync(abs);
    exists = true;
    if (lst.isSymbolicLink()) link = fs.readlinkSync(abs);
    else fs.copyFileSync(abs, path.join(dir, 'content'));
  } catch {
    // file is already gone (a deletion)
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ worktree: wtPath, path: file, existed: exists, link }));
  return id;
}

async function discardChange(wtPath, group, file) {
  const change = await findChange(wtPath, group, file);
  if (!change) throw Object.assign(new Error(`${file} has no ${group} changes`), { status: 404 });
  if (group === 'conflicted') throw Object.assign(new Error('Resolve conflicts in your editor or terminal'), { status: 400 });

  const undoId = backup(wtPath, file);

  if (group === 'unstaged') {
    // Back to the staged version (or the last commit if nothing is staged).
    await git(wtPath, lit(['restore', '--worktree', '--', file]));
  } else if (group === 'staged') {
    const inHead = await git(wtPath, ['cat-file', '-e', `HEAD:${file}`]).then(() => true, () => false);
    if (inHead) {
      await git(wtPath, lit(['restore', '--source=HEAD', '--staged', '--worktree', '--', file]));
    } else {
      // A newly added file: unstage and delete it.
      await git(wtPath, lit(['rm', '--cached', '--quiet', '--', file]));
      fs.rmSync(path.join(wtPath, file), { force: true });
    }
  } else if (group === 'untracked') {
    await git(wtPath, lit(['clean', '-f', '-q', '--', file]));
  }
  return undoId;
}

// Put the backed-up content back as an unstaged change.
function undoDiscard(id) {
  if (!/^\d+-[0-9a-f]{8}$/.test(id)) throw Object.assign(new Error('Invalid undo id'), { status: 400 });
  const dir = path.join(BACKUP_DIR, id);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    throw Object.assign(new Error('That discard can no longer be undone'), { status: 404 });
  }
  const abs = path.join(meta.worktree, meta.path);
  if (meta.existed) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.rmSync(abs, { force: true });
    if (meta.link) fs.symlinkSync(meta.link, abs);
    else fs.copyFileSync(path.join(dir, 'content'), abs);
  } else {
    fs.rmSync(abs, { force: true }); // it was a deletion; delete again
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return meta;
}

module.exports = { fileDiff, discardChange, undoDiscard, pruneBackups };
