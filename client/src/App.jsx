import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { CopyButton, StatusChips, Toasts, UpstreamCell, useToasts } from './components.jsx';
import { ChangedFiles, CommitCell } from './details.jsx';
import { AddRepoDialog, BaseSync, CheckoutRemoteDialog, CleanupDialog, OpenBranchDialog, OpenInMainDialog, SwitchBranchDialog } from './dialogs.jsx';
import { basename, fullDate, setHome, shortPath, timeAgo } from './util.js';

// ─── URL hash state: #/<repo>/<tab> ───────────────────────────────────────────

function readHash() {
  const [, repo, tab] = window.location.hash.split('/');
  return { repo: repo ? decodeURIComponent(repo) : null, tab: tab || 'worktrees' };
}

function useHashState() {
  const [state, setState] = useState(readHash);
  useEffect(() => {
    const onHash = () => setState(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = (repo, tab = 'worktrees') => {
    window.location.hash = `/${encodeURIComponent(repo)}/${tab}`;
  };
  return [state, navigate];
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [{ repo: selected, tab }, navigate] = useHashState();
  const [repos, setRepos] = useState(null);
  const [roots, setRoots] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const { toasts, toast, dismiss } = useToasts();
  const [dialog, setDialog] = useState(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadRepos = useCallback(() => api.repos().then((r) => (setHome(r.home), setRepos(r.repos), setRoots(r.roots))).catch((e) => toast('error', e.message)), [toast]);

  const loadDetail = useCallback(
    async (name, { quiet } = {}) => {
      if (!name) return;
      if (!quiet) setLoading(true);
      try {
        const d = await api.repo(name);
        if (selectedRef.current === name) {
          setDetail(d);
          setLoadError(null);
        }
      } catch (e) {
        if (selectedRef.current === name) setLoadError(e.message);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  // Pick the first repo if none is selected.
  useEffect(() => {
    if (!selected && repos?.length) navigate(repos[0].name);
  }, [selected, repos]);

  useEffect(() => {
    setDetail((d) => (d?.name === selected ? d : null));
    loadDetail(selected);
  }, [selected, loadDetail]);

  // Refresh when coming back to the tab, and every 30s while it is visible.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      loadRepos();
      loadDetail(selectedRef.current, { quiet: true });
    };
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 30000);
    return () => {
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    };
  }, [loadRepos, loadDetail]);

  // Run a git action, then show the result and reload.
  const run = useCallback(
    async (action, after) => {
      setBusy(true);
      try {
        const r = await action();
        const undo = r.undoId ? { label: 'Undo', onClick: () => runRef.current(() => api.undoDiscard(r.undoId)) } : undefined;
        toast('success', r.message || 'Done', undo);
        after?.(r);
      } catch (e) {
        toast('error', e.message);
      } finally {
        setBusy(false);
        await Promise.all([loadDetail(selectedRef.current, { quiet: true }), loadRepos()]);
      }
    },
    [toast, loadDetail, loadRepos]
  );

  const runRef = useRef(run);
  runRef.current = run;

  const closeDialog = useCallback(() => setDialog(null), []);

  return (
    <div className="layout">
      <Sidebar repos={repos} selected={selected} onSelect={(name) => navigate(name, tab)} onAdd={() => setDialog({ type: 'add-repo' })} />
      <main className="main">
        {!selected && <div className="empty-state">{repos?.length === 0 ? 'No repositories found.' : 'Loading…'}</div>}
        {selected && loadError && !detail && <div className="empty-state error">{loadError}</div>}
        {selected && !detail && !loadError && <div className="empty-state">Loading {selected}…</div>}
        {detail && (
          <RepoView
            repo={detail}
            tab={tab}
            loading={loading}
            setTab={(t) => navigate(detail.name, t)}
            run={run}
            busy={busy}
            refresh={() => loadDetail(detail.name)}
            openDialog={setDialog}
          />
        )}
      </main>

      {dialog?.type === 'add-repo' && (
        <AddRepoDialog defaultDir={roots[0] ? shortPath(roots[0]) : '~'} onClose={closeDialog} run={run} onAdded={(name) => navigate(name)} />
      )}
      {dialog && detail && dialog.type === 'open-in-main' && <OpenInMainDialog repo={detail} branch={dialog.branch} onClose={closeDialog} run={run} />}
      {dialog && detail && dialog.type === 'cleanup' && <CleanupDialog repo={detail} branch={dialog.branch} onClose={closeDialog} run={run} />}
      {dialog && detail && dialog.type === 'switch' && <SwitchBranchDialog repo={detail} worktree={dialog.worktree} onClose={closeDialog} run={run} />}
      {dialog && detail && dialog.type === 'open-branch' && <OpenBranchDialog repo={detail} branch={dialog.branch} onClose={closeDialog} run={run} />}
      {dialog && detail && dialog.type === 'checkout-remote' && <CheckoutRemoteDialog repo={detail} remote={dialog.remote} onClose={closeDialog} run={run} />}

      {busy && <div className="busy-bar" />}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ repos, selected, onSelect, onAdd }) {
  return (
    <nav className="sidebar">
      <div className="brand">
        <img src="/favicon.svg" alt="" width="22" height="22" />
        Git Viewer
      </div>
      <div className="sidebar-label">
        Repositories
        <button className="add-btn" onClick={onAdd} title="Clone or add a repository">
          + Add
        </button>
      </div>
      <ul className="repo-list">
        {!repos && <li className="dim small pad">Loading…</li>}
        {repos?.map((r) => (
          <li key={r.name}>
            <button className={`repo-item ${r.name === selected ? 'active' : ''}`} onClick={() => onSelect(r.name)}>
              <span className="repo-name">{r.name}</span>
              <span className="repo-sub">
                <span className="mono truncate">{r.branch || (r.copyOf ? `copy of ${r.copyOf}` : r.error ? 'error' : 'detached')}</span>
                {r.worktreeCount > 1 && (
                  <span className="count" title={`${r.worktreeCount} worktrees`}>
                    {r.worktreeCount}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ─── Repo view ────────────────────────────────────────────────────────────────

function RepoView({ repo, tab, setTab, run, busy, refresh, loading, openDialog }) {
  const dirtyCount = repo.worktrees.filter((w) => w.status?.dirty).length;
  const tabs = [
    ['worktrees', 'Worktrees', repo.worktrees.length],
    ['branches', 'Local branches', repo.localBranches.length],
    ['remote', 'Remote branches', repo.remoteBranches.length],
  ];

  return (
    <div className="repo-view">
      <header className="repo-head">
        <div>
          <h1>{repo.name}</h1>
          <div className="dim small">
            <span className="mono">{shortPath(repo.path)}</span>
            {repo.defaultBranch && (
              <>
                {' · '}default <span className="mono">{repo.defaultBranch}</span>
              </>
            )}
            {dirtyCount > 0 && <> · {dirtyCount} worktree{dirtyCount > 1 ? 's' : ''} with changes</>}
          </div>
        </div>
        <div className="head-actions">
          {repo.added && (
            <button
              className="btn btn-ghost"
              disabled={busy}
              title="Hide this repository from Git Viewer. Files on disk are not touched."
              onClick={() => window.confirm(`Remove ${repo.name} from the list? The files stay where they are.`) && run(() => api.removeFromList(repo.name), () => (window.location.hash = ''))}
            >
              Remove from list
            </button>
          )}
          <span className="dim small" title={fullDate(repo.lastFetched)}>
            {repo.lastFetched ? `Fetched ${timeAgo(repo.lastFetched)}` : 'Never fetched'}
          </span>
          <button className="btn" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-primary" onClick={() => run(() => api.fetch(repo.name))} disabled={busy || !repo.remotes.length}>
            Fetch
          </button>
        </div>
      </header>

      {repo.mainLink && <MainLinkBanner repo={repo} run={run} busy={busy} />}

      <div className="tabs" role="tablist">
        {tabs.map(([key, label, count]) => (
          <button key={key} role="tab" className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label} <span className="count">{count}</span>
          </button>
        ))}
      </div>

      {tab === 'worktrees' && <WorktreesTable repo={repo} run={run} busy={busy} openDialog={openDialog} />}
      {tab === 'branches' && <LocalBranchesTable repo={repo} run={run} busy={busy} openDialog={openDialog} />}
      {tab === 'remote' && <RemoteBranchesTable repo={repo} run={run} busy={busy} openDialog={openDialog} setTab={setTab} />}
    </div>
  );
}

// ─── Main-repo link banner ────────────────────────────────────────────────────

function MainLinkBanner({ repo, run, busy }) {
  const link = repo.mainLink;
  const main = basename(repo.worktrees[0].path);
  const from = link.from ? basename(link.from) : null;
  const back = link.previousBranch || 'its default branch';

  if (link.mode === 'snapshot') {
    return (
      <div className="banner">
        <div>
          <strong>{main}</strong> is testing a copy of <span className="mono">{link.branch}</span>
          {from && <> from {from}</>}
          {link.branchMissing ? (
            <span className="unusual"> (the branch no longer exists)</span>
          ) : link.behind > 0 ? (
            <span className="unusual"> · {link.behind} new commit{link.behind > 1 ? 's' : ''} on the branch</span>
          ) : (
            <span className="dim"> · up to date</span>
          )}
          {link.ahead > 0 && <span className="error-text"> · {link.ahead} commit(s) made on the copy; put them on a branch in a terminal</span>}
        </div>
        <div className="banner-actions">
          {link.behind > 0 && !link.ahead && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.updateMainCopy(repo.name))}>
              Update ↓{link.behind}
            </button>
          )}
          <button className="btn btn-sm" disabled={busy || link.ahead > 0} onClick={() => run(() => api.releaseMain(repo.name))}>
            Back to {back}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="banner">
      <div>
        <strong>{main}</strong> has <span className="mono">{link.branch}</span>
        {from && (
          <>
            {' '}
            moved from {from}
            {link.fromDetached && <span className="dim"> ({from} is detached until it's returned)</span>}
          </>
        )}
      </div>
      <div className="banner-actions">
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.releaseMain(repo.name))} title={`Main goes back to ${back}${from ? `; ${link.branch} goes back to ${from}` : ''}`}>
          Return branch
        </button>
      </div>
    </div>
  );
}

function DetachedLabel({ wt, link }) {
  if (link?.mode === 'snapshot' && wt.isMain) return <span className="chip chip-accent">copy of {link.branch}</span>;
  if (link?.mode === 'moved' && wt.path === link.from) return <span className="chip chip-muted">{link.branch} lent to main</span>;
  return <span className="chip chip-warn">detached</span>;
}

// ─── Worktrees ────────────────────────────────────────────────────────────────

function WorktreesTable({ repo, run, busy, openDialog }) {
  const byName = useMemo(() => new Map(repo.localBranches.map((b) => [b.name, b])), [repo]);
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (p) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Worktree / branch</th>
            <th>Changes</th>
            <th>vs upstream</th>
            <th>vs {repo.defaultBranch || 'default'}</th>
            <th>Last commit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {repo.worktrees.map((wt) => {
            const b = wt.branch ? byName.get(wt.branch) : null;
            const canPull = b?.upstream && !b.gone && b.behind > 0 && b.ahead === 0;
            const hasChanges = !!wt.status && (wt.status.dirty || wt.status.untracked > 0);
            const open = hasChanges && expanded.has(wt.path);
            return (
              <React.Fragment key={wt.path}>
              <tr className={`${hasChanges ? 'expandable' : ''} ${open ? 'expanded' : ''}`} onClick={hasChanges ? () => toggle(wt.path) : undefined}>
                <td className="nowrap" title={shortPath(wt.path)}>
                  <div className="stack">
                    <strong>
                      <span className={`chevron ${hasChanges ? '' : 'hidden'}`}>{open ? '▾' : '▸'}</span>
                      {basename(wt.path)} {wt.isMain && <span className="chip chip-muted">main</span>}
                      {wt.locked && <span className="chip chip-muted">locked</span>}
                    </strong>
                    <span className="mono branch-name indent-chevron">
                      {wt.branch || <DetachedLabel wt={wt} link={repo.mainLink} />}
                    </span>
                  </div>
                </td>
                <td>
                  <StatusChips wt={wt} />
                </td>
                <td>{b ? <UpstreamCell {...b} /> : <span className="dim">—</span>}</td>
                <td>{b ? b.name === repo.defaultBranch ? <span className="dim">—</span> : <BaseSync base={b.base} defaultBranch={repo.defaultBranch} /> : '—'}</td>
                <td className="commit-col">
                  <CommitCell commit={wt.lastCommit} repoName={repo.name} />
                </td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  {canPull && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.fastForward(repo.name, b.name))} title={`Fast-forward to ${b.upstream}`}>
                      Pull ↓{b.behind}
                    </button>
                  )}
                  {!wt.isMain && b?.gone && (
                    <button className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => openDialog({ type: 'cleanup', branch: b })} title="Delete this worktree and its branch">
                      Clean up…
                    </button>
                  )}
                  {!wt.isMain && wt.branch && !b?.gone && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => openDialog({ type: 'open-in-main', branch: wt.branch })} title="Check this branch out in the main repo">
                      Open in main…
                    </button>
                  )}
                  <button className="btn btn-sm" disabled={busy || wt.missing} onClick={() => openDialog({ type: 'switch', worktree: wt })}>
                    Switch…
                  </button>
                  <CopyButton text={wt.path} label="Copy path" />
                </td>
              </tr>
              {open && (
                <tr className="expand-row">
                  <td colSpan={6}>
                    <ChangedFiles repoName={repo.name} wt={wt} run={run} busy={busy} />
                  </td>
                </tr>
              )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Local branches ───────────────────────────────────────────────────────────

function LocalBranchesTable({ repo, run, busy, openDialog }) {
  const [query, setQuery] = useState('');
  const branches = repo.localBranches.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <div className="toolbar">
        <input className="input search" placeholder="Filter branches…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>vs upstream</th>
              <th>vs {repo.defaultBranch || 'default'}</th>
              <th>Last commit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {branches.map((b) => {
              const canFF = b.upstream && !b.gone && b.behind > 0 && b.ahead === 0;
              return (
                <tr key={b.name}>
                  <td className="nowrap">
                    <div className="stack">
                      <span className="mono strong">{b.name}</span>
                      {b.worktree && <span className="small dim">checked out in <span className="branch-name">{basename(b.worktree)}</span></span>}
                    </div>
                  </td>
                  <td>
                    <UpstreamCell {...b} />
                  </td>
                  <td>{b.name === repo.defaultBranch ? <span className="chip chip-muted">default</span> : <BaseSync base={b.base} defaultBranch={repo.defaultBranch} />}</td>
                  <td className="commit-col">
                    <CommitCell commit={b.lastCommit} repoName={repo.name} />
                  </td>
                  <td className="actions">
                    {canFF && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.fastForward(repo.name, b.name))} title={`Fast-forward to ${b.upstream}`}>
                        Pull ↓{b.behind}
                      </button>
                    )}
                    {b.remoteMatch && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.setUpstream(repo.name, b.name, b.remoteMatch.name))} title={`Set ${b.remoteMatch.name} as upstream`}>
                        Track
                      </button>
                    )}
                    {b.gone && b.worktree !== repo.worktrees[0].path && (
                      <button className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => openDialog({ type: 'cleanup', branch: b })}>
                        Clean up…
                      </button>
                    )}
                    {b.worktree && b.worktree !== repo.worktrees[0].path && !b.gone && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => openDialog({ type: 'open-in-main', branch: b.name })}>
                        Open in main…
                      </button>
                    )}
                    {!b.worktree && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => openDialog({ type: 'open-branch', branch: b })}>
                        Check out…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!branches.length && (
              <tr>
                <td colSpan={5} className="dim empty">
                  No matching branches
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Remote branches ──────────────────────────────────────────────────────────

const PAGE = 100;

function RemoteBranchesTable({ repo, run, busy, openDialog, setTab }) {
  const [query, setQuery] = useState('');
  const [hideLocal, setHideLocal] = useState(false);
  const [mine, setMine] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const me = repo.userName;

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return repo.remoteBranches.filter(
      (r) =>
        (r.name.toLowerCase().includes(q) || r.lastCommit.author.toLowerCase().includes(q)) &&
        (!hideLocal || (!r.trackedBy && !r.localSameName)) &&
        (!mine || r.lastCommit.author === me)
    );
  }, [repo, query, hideLocal, mine, me]);

  useEffect(() => setLimit(PAGE), [query, hideLocal, mine, repo.name]);

  if (!repo.remotes.length) return <div className="empty-state">This repository has no remotes.</div>;

  return (
    <>
      <div className="toolbar">
        <input className="input search" placeholder="Filter by branch or author…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <label className="check">
          <input type="checkbox" checked={hideLocal} onChange={(e) => setHideLocal(e.target.checked)} /> Hide ones I have locally
        </label>
        {me && (
          <label className="check">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only {me}
          </label>
        )}
        <span className="dim small push">
          {filtered.length} of {repo.remoteBranches.length}, newest first
        </span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Remote branch</th>
              <th>Locally</th>
              <th>Last commit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((r) => (
              <tr key={r.name}>
                <td className="mono strong">{r.name}</td>
                <td>
                  {r.trackedBy ? (
                    <button className="chip chip-accent link" onClick={() => setTab('branches')} title="Tracked by this local branch">
                      {r.trackedBy}
                    </button>
                  ) : r.localSameName ? (
                    <span className="chip chip-muted" title="A local branch with the same name exists but doesn't track this one">
                      local, untracked
                    </span>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td className="commit-col">
                  <CommitCell commit={r.lastCommit} repoName={repo.name} />
                </td>
                <td className="actions">
                  {!r.trackedBy && r.localSameName && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.setUpstream(repo.name, r.branch, r.name))} title={`Make local ${r.branch} track ${r.name}`}>
                      Track
                    </button>
                  )}
                  {!r.trackedBy && !r.localSameName && (
                    <button className="btn btn-sm" onClick={() => openDialog({ type: 'checkout-remote', remote: r })}>
                      Check out…
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={4} className="dim empty">
                  No matching remote branches
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > limit && (
        <div className="more">
          <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, filtered.length - limit)} more
          </button>
        </div>
      )}
    </>
  );
}
