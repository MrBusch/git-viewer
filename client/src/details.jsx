import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { ConfirmButton, CopyButton, fileViewUrl } from './components.jsx';
import { fullDate, timeAgo } from './util.js';

// ─── Commit popover ───────────────────────────────────────────────────────────

// Floating panel anchored to an element; closes on outside click, Escape, scroll or resize.
function Popover({ anchor, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    const margin = 8;
    let top = a.bottom + 6;
    if (top + p.height > window.innerHeight - margin && a.top - p.height - 6 > margin) top = a.top - p.height - 6;
    const left = Math.max(margin, Math.min(a.left, window.innerWidth - p.width - margin));
    // Runs after every render (content size changes once the commit loads); only update when moved.
    setPos((prev) => (prev.top === top && prev.left === left ? prev : { top, left }));
  });

  useEffect(() => {
    const onDown = (e) => !ref.current?.contains(e.target) && !anchor.contains(e.target) && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onScroll = (e) => !ref.current?.contains(e.target) && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="popover" style={pos} role="dialog">
      {children}
    </div>,
    document.body
  );
}

function CommitPopover({ repoName, hash, anchor, onClose }) {
  const [commit, setCommit] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.commit(repoName, hash).then(setCommit, (e) => setError(e.message));
  }, [repoName, hash]);

  const [subject, ...rest] = (commit?.message || '').split('\n');
  const body = rest.join('\n').trim();

  return (
    <Popover anchor={anchor} onClose={onClose}>
      {error && <div className="error-text">{error}</div>}
      {!commit && !error && <div className="dim">Loading…</div>}
      {commit && (
        <>
          <div className="pop-subject">{subject}</div>
          {body && <pre className="pop-body">{body}</pre>}
          <div className="pop-meta">
            <div>
              <span className="dim">Author</span> {commit.author} <span className="dim">&lt;{commit.email}&gt;</span>
            </div>
            <div>
              <span className="dim">Date</span> {fullDate(commit.authorDate)} <span className="dim">({timeAgo(commit.authorDate)})</span>
            </div>
            {commit.committer !== commit.author && (
              <div>
                <span className="dim">Committed by</span> {commit.committer}, {timeAgo(commit.commitDate)}
              </div>
            )}
            <div className="pop-hash">
              <span className="mono">{commit.hash}</span>
              <CopyButton text={commit.hash} label="Copy hash" />
            </div>
          </div>
        </>
      )}
    </Popover>
  );
}

export function CommitCell({ commit, repoName }) {
  const [anchor, setAnchor] = useState(null);
  if (!commit) return <span className="dim">—</span>;
  return (
    <div className="commit">
      <button
        className={`commit-subject link-btn ${anchor ? 'open' : ''}`}
        title="Show full commit message"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget);
        }}
      >
        {commit.subject}
      </button>
      <span className="dim small">
        <span className="mono">{commit.hash}</span> · {commit.author} · <span title={fullDate(commit.date)}>{timeAgo(commit.date)}</span>
      </span>
      {anchor && <CommitPopover repoName={repoName} hash={commit.hash} anchor={anchor} onClose={() => setAnchor(null)} />}
    </div>
  );
}

// ─── Changed files in a worktree ──────────────────────────────────────────────

const GROUPS = [
  ['conflicted', 'Conflicts'],
  ['staged', 'Staged'],
  ['unstaged', 'Not staged'],
  ['untracked', 'Untracked'],
];

const STATUS_CLASS = { modified: 'st-mod', added: 'st-add', new: 'st-add', deleted: 'st-del', conflict: 'st-del' };
const STATUS_LETTER = { modified: 'M', added: 'A', new: 'U', deleted: 'D', conflict: '!', 'type changed': 'T' };

// Five-block bar like GitHub's diffstat.
function DiffBar({ added, removed }) {
  const total = added + removed;
  if (!total) return null;
  const green = Math.round((added / total) * 5);
  return (
    <span className="diffbar" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < green ? 'g' : 'r'} />
      ))}
    </span>
  );
}

function LineCounts({ file }) {
  if (file.binary) return <span className="dim small">binary</span>;
  if (file.added == null) return null;
  return (
    <span className="linecounts">
      <span className="sync-ahead">+{file.added}</span>
      <span className="minus">−{file.removed ?? 0}</span>
      <DiffBar added={file.added} removed={file.removed ?? 0} />
    </span>
  );
}

export function PathLabel({ path: file }) {
  const slash = file.lastIndexOf('/');
  return (
    <>
      <span className="dim">{slash >= 0 ? file.slice(0, slash + 1) : ''}</span>
      {file.slice(slash + 1)}
    </>
  );
}

export { LineCounts, STATUS_CLASS, STATUS_LETTER };

function FileRow({ file, group, repoName, wt, run, busy }) {
  return (
    <li className="file-row">
      <span className={`st ${STATUS_CLASS[file.status] || 'st-mod'}`} title={file.status}>
        {STATUS_LETTER[file.status] || '?'}
      </span>
      <a className="file-path mono" href={fileViewUrl(repoName, wt.path, group, file.path)} target="_blank" rel="noreferrer" title={`Preview ${file.path} in a new tab`} onClick={(e) => e.stopPropagation()}>
        <PathLabel path={file.path} />
      </a>
      <LineCounts file={file} />
      {run && group !== 'conflicted' && (
        <ConfirmButton
          className="discard-btn"
          label="Discard"
          confirmLabel="Discard?"
          disabled={busy}
          title={DISCARD_HINT[group]}
          onConfirm={() => run(() => api.discard(repoName, wt.path, group, file.path))}
        />
      )}
    </li>
  );
}

export const DISCARD_HINT = {
  unstaged: 'Throw away the unstaged changes (keeps anything staged)',
  staged: 'Reset this file to the last commit (staged and unstaged changes)',
  untracked: 'Delete this new file',
};

export function ChangedFiles({ repoName, wt, run, busy }) {
  const [changes, setChanges] = useState(null);
  const [error, setError] = useState(null);
  // Re-fetch when the worktree's status summary changes (after a refresh).
  const statusKey = JSON.stringify(wt.status);

  useEffect(() => {
    let live = true;
    api.changes(repoName, wt.path).then(
      (c) => live && (setChanges(c), setError(null)),
      (e) => live && setError(e.message)
    );
    return () => {
      live = false;
    };
  }, [repoName, wt.path, statusKey]);

  if (error) return <div className="changes error-text">{error}</div>;
  if (!changes) return <div className="changes dim">Loading changes…</div>;

  const groups = GROUPS.filter(([key]) => changes[key].length);
  if (!groups.length) return <div className="changes dim">No changes.</div>;

  return (
    <div className="changes">
      {groups.map(([key, label]) => {
        const files = changes[key];
        const added = files.reduce((n, f) => n + (f.added || 0), 0);
        const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
        return (
          <section key={key} className="change-group">
            <h4>
              {label} <span className="count">{files.length}</span>
              {(added > 0 || removed > 0) && (
                <span className="group-total">
                  <span className="sync-ahead">+{added}</span> <span className="minus">−{removed}</span>
                </span>
              )}
            </h4>
            <ul>
              {files.map((f) => (
                <FileRow key={f.path} file={f} group={key} repoName={repoName} wt={wt} run={run} busy={busy} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
