async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const repoUrl = (name) => `/api/repos/${encodeURIComponent(name)}`;

export const api = {
  meta: () => request('GET', '/api/meta'),
  repos: () => request('GET', '/api/repos'),
  clone: (url, parentDir, folderName) => request('POST', '/api/clone', { url, parentDir, folderName }),
  addExisting: (path) => request('POST', '/api/add-existing', { path }),
  removeFromList: (name) => request('POST', `${repoUrl(name)}/remove-from-list`, {}),
  repo: (name) => request('GET', repoUrl(name)),
  commit: (name, hash) => request('GET', `${repoUrl(name)}/commit/${encodeURIComponent(hash)}`),
  changes: (name, worktree) => request('GET', `${repoUrl(name)}/changes?worktree=${encodeURIComponent(worktree)}`),
  suggestWorktreePath: (name, branch) => request('GET', `${repoUrl(name)}/suggest-worktree-path?branch=${encodeURIComponent(branch)}`),
  fetch: (name) => request('POST', `${repoUrl(name)}/fetch`, {}),
  switch: (name, worktree, branch) => request('POST', `${repoUrl(name)}/switch`, { worktree, branch }),
  checkoutRemote: (name, body) => request('POST', `${repoUrl(name)}/checkout-remote`, body),
  addWorktree: (name, branch, worktreePath) => request('POST', `${repoUrl(name)}/add-worktree`, { branch, worktreePath }),
  setUpstream: (name, branch, remoteBranch) => request('POST', `${repoUrl(name)}/set-upstream`, { branch, remoteBranch }),
  openInMain: (name, branch, mode) => request('POST', `${repoUrl(name)}/open-in-main`, { branch, mode }),
  updateMainCopy: (name) => request('POST', `${repoUrl(name)}/update-main-copy`, {}),
  releaseMain: (name) => request('POST', `${repoUrl(name)}/release-main`, {}),
  cleanup: (name, body) => request('POST', `${repoUrl(name)}/cleanup`, body),
  diff: (name, worktree, group, path, full) =>
    request('GET', `${repoUrl(name)}/diff?worktree=${encodeURIComponent(worktree)}&group=${group}&path=${encodeURIComponent(path)}${full ? '&full=1' : ''}`),
  discard: (name, worktree, group, path) => request('POST', `${repoUrl(name)}/discard`, { worktree, group, path }),
  undoDiscard: (id) => request('POST', '/api/undo-discard', { id }),
  fastForward: (name, branch) => request('POST', `${repoUrl(name)}/fast-forward`, { branch }),
};
