const fs = require('fs');
const os = require('os');
const path = require('path');

// Local state that git itself doesn't record:
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

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      extraRepos: Array.isArray(c.extraRepos) ? c.extraRepos : [],
      mainLinks: c.mainLinks && typeof c.mainLinks === 'object' ? c.mainLinks : {},
    };
  } catch {
    return { extraRepos: [], mainLinks: {} };
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
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
