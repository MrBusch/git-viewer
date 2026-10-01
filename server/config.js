const fs = require('fs');
const os = require('os');
const path = require('path');

// Local state that git itself doesn't record:
// - roots:      folders to scan for repositories (GIT_VIEWER_ROOTS overrides them)
// - extraRepos: repositories added by hand (outside the scanned folders)
// - mainLinks:  { [repoPath]: { mode, branch, from, previousBranch } } when a worktree's branch is open in the main repo
// Per-user state lives in ~/.git-viewer, never in the project folder.
const CONFIG_PATH = process.env.GIT_VIEWER_CONFIG || path.join(os.homedir(), '.git-viewer', 'config.json');

// Earlier versions kept config.json next to the server; move it over once.
const LEGACY_PATH = path.join(__dirname, 'config.json');
if (!process.env.GIT_VIEWER_CONFIG && fs.existsSync(LEGACY_PATH) && !fs.existsSync(CONFIG_PATH)) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.renameSync(LEGACY_PATH, CONFIG_PATH);
}

// Paths under the home folder are stored as "~/…", so the file works for another user name.
const toStored = (p) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
const fromStored = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      roots: Array.isArray(c.roots) ? c.roots.filter((r) => typeof r === 'string').map(fromStored) : [],
      extraRepos: Array.isArray(c.extraRepos) ? c.extraRepos.filter((r) => typeof r === 'string').map(fromStored) : [],
      mainLinks: c.mainLinks && typeof c.mainLinks === 'object' ? c.mainLinks : {},
    };
  } catch {
    return { roots: [], extraRepos: [], mainLinks: {} };
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const stored = { ...config, roots: config.roots.map(toStored), extraRepos: config.extraRepos.map(toStored) };
  if (!stored.roots.length) delete stored.roots;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2) + '\n');
}

function addExtraRepo(repoPath) {
  const config = readConfig();
  if (!config.extraRepos.includes(repoPath)) {
    config.extraRepos.push(repoPath);
    writeConfig(config);
  }
}

function removeExtraRepo(repoPath) {
  const config = readConfig();
  config.extraRepos = config.extraRepos.filter((p) => p !== repoPath);
  writeConfig(config);
}

function getMainLink(repoPath) {
  return readConfig().mainLinks[repoPath] || null;
}

function setMainLink(repoPath, link) {
  const config = readConfig();
  if (link) config.mainLinks[repoPath] = link;
  else delete config.mainLinks[repoPath];
  writeConfig(config);
}

module.exports = { readConfig, addExtraRepo, removeExtraRepo, getMainLink, setMainLink };
