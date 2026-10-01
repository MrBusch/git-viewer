import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Modal, StatusChips, Sync } from './components.jsx';
import { ChangedFiles } from './details.jsx';
import { basename, timeAgo } from './util.js';

function DirtyWarning({ wt }) {
  if (!wt?.status?.dirty) return null;
  return (
    <p className="warn-box">
      <strong>{basename(wt.path)}</strong> has uncommitted changes. Git carries them over to the new branch, or refuses the switch if they would be
      overwritten.
    </p>
  );
}

// Pick a local branch to switch an existing worktree to.
export function SwitchBranchDialog({ repo, worktree, onClose, run }) {
  const [query, setQuery] = useState('');
  const branches = useMemo(() => {
    const q = query.toLowerCase();
    return repo.localBranches.filter((b) => b.name !== worktree.branch && b.name.toLowerCase().includes(q));
  }, [repo, worktree, query]);

  return (
    <Modal title={`Switch ${basename(worktree.path)}`} onClose={onClose}>
      <p className="dim">
        Currently on <span className="mono">{worktree.branch || 'detached HEAD'}</span>. Branches open in another worktree can't be checked out here too.
      </p>
      <DirtyWarning wt={worktree} />
      <input className="input" autoFocus placeholder="Filter branches…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="pick-list">
        {branches.map((b) => {
          const busyElsewhere = !!b.worktree;
          return (
            <li key={b.name}>
              <button
                className="pick"
                disabled={busyElsewhere}
                onClick={() => run(() => api.switch(repo.name, worktree.path, b.name), onClose)}
                title={busyElsewhere ? `Checked out in ${b.worktree}` : `Switch to ${b.name}`}
              >
                <span className="mono">{b.name}</span>
                <span className="pick-meta">
                  {busyElsewhere ? <span className="chip chip-muted">in {basename(b.worktree)}</span> : <span className="dim small">{timeAgo(b.lastCommit.date)}</span>}
                </span>
              </button>
            </li>
          );
        })}
        {!branches.length && <li className="dim empty">No matching branches</li>}
      </ul>
    </Modal>
  );
}

// Check out an existing local branch: into a free worktree, or into a new one.
export function OpenBranchDialog({ repo, branch, onClose, run }) {
  const [path, setPath] = useState('');
  useEffect(() => {
    api.suggestWorktreePath(repo.name, branch.name).then((r) => setPath(r.path));
  }, [repo.name, branch.name]);

  return (
    <Modal title={`Check out ${branch.name}`} onClose={onClose}>
      <h3>Switch an existing worktree</h3>
      <ul className="pick-list">
        {repo.worktrees.map((wt) => (
          <li key={wt.path}>
            <button className="pick" disabled={wt.missing} onClick={() => run(() => api.switch(repo.name, wt.path, branch.name), onClose)}>
              <span>
                <strong>{basename(wt.path)}</strong> <span className="dim small mono">{wt.branch || 'detached'}</span>
              </span>
              <span className="pick-meta">
                <StatusChips wt={wt} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <h3>Or open it in a new worktree</h3>
      <div className="row">
        <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
        <button className="btn btn-primary" disabled={!path} onClick={() => run(() => api.addWorktree(repo.name, branch.name, path), onClose)}>
          Create worktree
        </button>
      </div>
    </Modal>
  );
}

// Create a local branch from a remote one.
export function CheckoutRemoteDialog({ repo, remote, onClose, run }) {
  const [localName, setLocalName] = useState(remote.branch);
  const [mode, setMode] = useState(repo.worktrees.length > 1 ? 'worktree' : 'switch');
  const [worktree, setWorktree] = useState(repo.worktrees[0]?.path);
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);

  const exists = repo.localBranches.some((b) => b.name === localName);
  const chosenWt = repo.worktrees.find((w) => w.path === worktree);

  useEffect(() => {
    if (pathTouched || !localName) return;
    const t = setTimeout(() => api.suggestWorktreePath(repo.name, localName).then((r) => setPath(r.path)), 150);
    return () => clearTimeout(t);
  }, [repo.name, localName, pathTouched]);

  const submit = () => {
    const body = { remoteBranch: remote.name, localName, mode };
    if (mode === 'switch') body.worktree = worktree;
    if (mode === 'worktree') body.worktreePath = path;
    run(() => api.checkoutRemote(repo.name, body), onClose);
  };

  return (
    <Modal
      title={`Check out ${remote.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!localName || exists || (mode === 'worktree' && !path)} onClick={submit}>
            {mode === 'branch' ? 'Create branch' : mode === 'switch' ? 'Create & switch' : 'Create worktree'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Local branch name</span>
        <input className="input mono" value={localName} onChange={(e) => setLocalName(e.target.value.trim())} autoFocus />
        {exists && <span className="field-error">A local branch with this name already exists.</span>}
        <span className="dim small">It will track {remote.name}, so later pulls and pushes go there.</span>
      </label>

      <fieldset className="field">
        <span>Then</span>
        <label className="radio">
          <input type="radio" checked={mode === 'worktree'} onChange={() => setMode('worktree')} />
          Open it in a new worktree
        </label>
        {mode === 'worktree' && (
          <input
            className="input mono indent"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathTouched(true);
            }}
          />
        )}
        <label className="radio">
          <input type="radio" checked={mode === 'switch'} onChange={() => setMode('switch')} />
          Switch an existing worktree to it
        </label>
        {mode === 'switch' && (
          <div className="indent">
            <select className="input" value={worktree} onChange={(e) => setWorktree(e.target.value)}>
              {repo.worktrees.map((w) => (
                <option key={w.path} value={w.path}>
                  {basename(w.path)} ({w.branch || 'detached'})
                </option>
              ))}
            </select>
            <DirtyWarning wt={chosenWt} />
          </div>
        )}
        <label className="radio">
          <input type="radio" checked={mode === 'branch'} onChange={() => setMode('branch')} />
          Just create the branch (don't check it out)
        </label>
      </fieldset>
    </Modal>
  );
}

// Small summary used in the worktree table for the default-branch comparison.
export function BaseSync({ base, defaultBranch }) {
  if (!base) return <span className="dim">—</span>;
  return <Sync ahead={base.ahead} behind={base.behind} against={defaultBranch} emptyLabel="even" />;
}

// Folder name a clone would get by default: last path segment without ".git".
function folderFromUrl(url) {
  const m = url.trim().replace(/\/+$/, '').match(/([^/:]+?)(\.git)?$/);
  return m ? m[1].replace(/[^A-Za-z0-9._-]/g, '-') : '';
}

// Clone a repository from a URL, or add one that is already on disk.
export function AddRepoDialog({ defaultDir, onClose, run, onAdded }) {
  const [mode, setMode] = useState('clone');
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState(defaultDir);
  const [folderName, setFolderName] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [existingPath, setExistingPath] = useState('');
  const [working, setWorking] = useState(false);

  const folder = folderTouched ? folderName : folderFromUrl(url);

  const submit = async () => {
    setWorking(true);
    const action = mode === 'clone' ? () => api.clone(url, parentDir, folder) : () => api.addExisting(existingPath);
    await run(action, (r) => {
      onClose();
      if (r.name) onAdded(r.name);
    });
    setWorking(false);
  };

  const canSubmit = !working && (mode === 'clone' ? url.trim() && folder && parentDir : existingPath.trim());

  return (
    <Modal
      title="Add repository"
      onClose={working ? () => {} : onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            {working ? (mode === 'clone' ? 'Cloning…' : 'Adding…') : mode === 'clone' ? 'Clone' : 'Add'}
          </button>
        </>
      }
    >
      <div className="segmented">
        <button className={mode === 'clone' ? 'active' : ''} onClick={() => setMode('clone')} disabled={working}>
          Clone from URL
        </button>
        <button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')} disabled={working}>
          Add existing folder
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
      >
        {mode === 'clone' ? (
          <>
            <label className="field">
              <span>Repository URL</span>
              <input className="input mono" autoFocus placeholder="git@github.com:org/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} disabled={working} />
              <span className="dim small">SSH or HTTPS. Uses your own git credentials.</span>
            </label>
            <div className="row">
              <label className="field grow">
                <span>Into folder</span>
                <input className="input mono" value={parentDir} onChange={(e) => setParentDir(e.target.value)} disabled={working} />
              </label>
              <label className="field grow">
                <span>Folder name</span>
                <input
                  className="input mono"
                  value={folder}
                  onChange={(e) => {
                    setFolderName(e.target.value);
                    setFolderTouched(true);
                  }}
                  disabled={working}
                />
              </label>
            </div>
            {working && <p className="dim small">Cloning can take a while for large repositories…</p>}
          </>
        ) : (
          <label className="field">
            <span>Folder path</span>
            <input className="input mono" autoFocus placeholder="~/code/my-repo" value={existingPath} onChange={(e) => setExistingPath(e.target.value)} disabled={working} />
            <span className="dim small">Any folder inside the repository works; a worktree adds its main repository.</span>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// Check out a branch that another worktree holds in the main worktree.
export function OpenInMainDialog({ repo, branch, onClose, run }) {
  const [mode, setMode] = useState('snapshot');
  const main = repo.worktrees[0];
  const holder = repo.worktrees.find((w) => w.branch === branch && !w.isMain);
  const holderName = holder ? basename(holder.path) : null;

  return (
    <Modal
      title={`Open ${branch} in ${basename(main.path)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => run(() => api.openInMain(repo.name, branch, mode), onClose)}>
            {mode === 'snapshot' ? 'Check out copy' : 'Move branch'}
          </button>
        </>
      }
    >
      <p className="dim">
        {holderName ? (
          <>
            <span className="mono">{branch}</span> is checked out in <strong>{holderName}</strong>, and git allows a branch in only one worktree at a time.
          </>
        ) : (
          <>Switch the main repo to <span className="mono">{branch}</span>.</>
        )}{' '}
        The main repo is on <span className="mono">{main.branch || 'a detached commit'}</span> now; you can switch back to it from the banner afterwards.
      </p>
      <DirtyWarning wt={main} />

      <label className={`option-card ${mode === 'snapshot' ? 'active' : ''}`}>
        <input type="radio" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} />
        <div>
          <strong>Test a copy</strong> <span className="chip chip-muted">recommended</span>
          <p>
            The main repo checks out the branch's latest commit, detached. {holderName ? <>{holderName} keeps the branch, so work there continues as normal.</> : null}{' '}
            When the branch gets new commits, <em>Update</em> brings the main repo up to date.
          </p>
          <p className="dim small">Best for running and testing. Don't commit in the main repo while it's on the copy.</p>
        </div>
      </label>

      <label className={`option-card ${mode === 'move' ? 'active' : ''}`}>
        <input type="radio" checked={mode === 'move'} onChange={() => setMode('move')} />
        <div>
          <strong>Move the branch</strong>
          <p>
            {holderName ? <>{holderName} lets go of the branch (same commit, files untouched) and the </> : 'The '}
            main repo checks out the branch itself, so you can commit there. <em>Return branch</em> puts main back on{' '}
            <span className="mono">{main.branch || 'its default branch'}</span>
            {holderName ? <> and gives the branch back to {holderName}</> : null}.
          </p>
          {holderName && <p className="dim small">Don't commit in {holderName} meanwhile; those commits wouldn't be on the branch.</p>}
        </div>
      </label>
    </Modal>
  );
}

const MERGE_NOTE = {
  merged: (target) => <>Its commits are in <span className="mono">{target}</span>. Safe to delete.</>,
  'squash-merged': (target) => (
    <>
      Its changes were squash-merged into <span className="mono">{target}</span>. Safe to delete.
    </>
  ),
  'not-merged': (target) => (
    <>
      Couldn't find this work in <span className="mono">{target}</span>. It may have been closed without merging, or changed while merging. Deleting
      the branch loses its commits.
    </>
  ),
};

// Remove a finished branch's worktree folder and/or the local branch.
export function CleanupDialog({ repo, branch, onClose, run }) {
  const wt = branch.worktree ? repo.worktrees.find((w) => w.path === branch.worktree) : null;
  const [removeWorktree, setRemoveWorktree] = useState(!!wt);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [confirmText, setConfirmText] = useState('');

  const wtHasChanges = !!wt?.status && (wt.status.dirty || wt.status.untracked > 0);
  const target = repo.mergeTarget || repo.defaultBranch || 'the default branch';
  const merged = branch.merged || 'not-merged';
  const branchBlocked = wt && !removeWorktree; // can't delete a branch that stays checked out
  const doDeleteBranch = deleteBranch && !branchBlocked;
  const risky = (doDeleteBranch && merged === 'not-merged') || (removeWorktree && wtHasChanges);
  const confirmed = !risky || confirmText === branch.name;
  const canSubmit = (removeWorktree || doDeleteBranch) && confirmed;

  const submit = () =>
    run(() => api.cleanup(repo.name, { branch: branch.name, removeWorktree, deleteBranch: doDeleteBranch, force: risky }), onClose);

  return (
    <Modal
      title={`Clean up ${branch.name}`}
      onClose={onClose}
      footer={
        <>
          {risky && (
            <input
              className="input mono confirm-input"
              placeholder={`Type ${branch.name} to confirm`}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" disabled={!canSubmit} onClick={submit}>
            {removeWorktree && doDeleteBranch ? 'Delete worktree & branch' : removeWorktree ? 'Delete worktree' : 'Delete branch'}
          </button>
        </>
      }
    >
      <p className={merged === 'not-merged' ? 'warn-box' : 'ok-box'}>
        {branch.neverPushed ? (
          <>
            This branch was never pushed.{' '}
            {merged === 'not-merged' ? (
              <>
                Its work isn't in <span className="mono">{target}</span>, and its commits exist only on this machine. Deleting the branch loses them.
              </>
            ) : (
              MERGE_NOTE[merged](target)
            )}
          </>
        ) : (
          <>
            The remote branch <span className="mono">{branch.upstream}</span> was deleted. {MERGE_NOTE[merged](target)}
          </>
        )}
      </p>

      {wt && (
        <label className="check-row">
          <input type="checkbox" checked={removeWorktree} onChange={(e) => setRemoveWorktree(e.target.checked)} />
          <div>
            <div>
              Delete the worktree folder <span className="mono">{basename(wt.path)}</span>
            </div>
            <div className="dim small">
              Everything in it goes, including ignored files like <span className="mono">node_modules</span> and <span className="mono">.env</span>.
            </div>
          </div>
        </label>
      )}
      {removeWorktree && wtHasChanges && (
        <div className="lose-box">
          <div className="error-text small strong">These uncommitted changes would be lost:</div>
          <ChangedFiles repoName={repo.name} wt={wt} />
        </div>
      )}

      <label className={`check-row ${branchBlocked ? 'disabled' : ''}`}>
        <input type="checkbox" checked={doDeleteBranch} disabled={branchBlocked} onChange={(e) => setDeleteBranch(e.target.checked)} />
        <div>
          <div>
            Delete the local branch <span className="mono">{branch.name}</span>
          </div>
          <div className="dim small">
            {branchBlocked ? `Only possible together with its worktree.` : `Last commit ${branch.lastCommit.hash}: ${branch.lastCommit.subject}`}
          </div>
        </div>
      </label>

    </Modal>
  );
}
