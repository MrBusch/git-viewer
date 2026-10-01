import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { ConfirmButton, Toasts, useToasts } from './components.jsx';
import { DISCARD_HINT, LineCounts, PathLabel } from './details.jsx';
import { basename, setHome, shortPath } from './util.js';

const GROUP_LABEL = { staged: 'Staged', unstaged: 'Not staged', untracked: 'Untracked', conflicted: 'Conflict' };

function readParams() {
  const q = new URLSearchParams(window.location.hash.replace(/^#\/file\?/, ''));
  return { repo: q.get('repo'), wt: q.get('wt'), group: q.get('group'), path: q.get('path') };
}

// Standalone page (opened in its own tab) showing one changed file.
export default function FileView() {
  const [{ repo, wt, group, path }] = useState(readParams);
  const [full, setFull] = useState(false);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toasts, toast, dismiss } = useToasts();
  const [, setHomeLoaded] = useState(false);

  // Paths under the home folder show as "~/…", as on the main page.
  useEffect(() => {
    api.meta().then((m) => (setHome(m.home), setHomeLoaded(true)), () => {});
  }, []);

  useEffect(() => {
    document.title = `${basename(path || '')} · ${basename(wt || '')}`;
  }, [path, wt]);

  const load = useCallback(async () => {
    try {
      setDiff(await api.diff(repo, wt, group, path, full));
      setError(null);
    } catch (e) {
      setDiff(null);
      setError(e.message);
    }
  }, [repo, wt, group, path, full]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when coming back to this tab (the file may have been edited meanwhile).
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const act = async (fn) => {
    setBusy(true);
    try {
      const r = await fn();
      const undo = r.undoId ? { label: 'Undo', onClick: () => act(() => api.undoDiscard(r.undoId)) } : undefined;
      toast('success', r.message, undo);
    } catch (e) {
      toast('error', e.message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const hasContext = diff && !['untracked', 'conflicted'].includes(group);

  return (
    <div className="fileview">
      <header className="fv-head">
        <div className="fv-title">
          <h1 className="mono">
            <PathLabel path={path || ''} />
          </h1>
          <div className="dim small">
            <a href={`#/${encodeURIComponent(repo)}/worktrees`} className="fv-link">
              {repo}
            </a>
            {' · '}
            <span className="mono" title={wt}>
              {shortPath(wt || '')}
            </span>
            {' · '}
            <span className={`chip ${group === 'staged' ? 'chip-good' : group === 'untracked' ? 'chip-muted' : group === 'conflicted' ? 'chip-bad' : 'chip-warn'}`}>{GROUP_LABEL[group]}</span>
            {diff && (
              <>
                {' '}
                <span className="chip chip-muted">{diff.status}</span> <LineCounts file={diff} />
              </>
            )}
          </div>
        </div>
        <div className="head-actions">
          {hasContext && (
            <div className="segmented small-seg">
              <button className={!full ? 'active' : ''} onClick={() => setFull(false)}>
                Changes
              </button>
              <button className={full ? 'active' : ''} onClick={() => setFull(true)}>
                Full file
              </button>
            </div>
          )}
          <button className="btn btn-sm" onClick={load} disabled={busy}>
            Refresh
          </button>
          {diff && group !== 'conflicted' && (
            <ConfirmButton label="Discard" confirmLabel="Discard?" disabled={busy} title={DISCARD_HINT[group]} onConfirm={() => act(() => api.discard(repo, wt, group, path))} />
          )}
        </div>
      </header>

      {error && <div className="empty-state">{error}</div>}
      {!diff && !error && <div className="empty-state">Loading…</div>}
      {diff?.binary && <div className="empty-state">Binary file; no preview.</div>}
      {diff?.tooLarge && <div className="empty-state">This file is too large to preview.</div>}
      {diff && !diff.binary && !diff.tooLarge && <DiffTable diff={diff} showOld={group !== 'untracked'} />}

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function DiffTable({ diff, showOld }) {
  if (!diff.hunks.length) return <div className="empty-state">Empty file.</div>;
  return (
    <div className="diff-wrap">
      <table className="diff">
        <tbody>
          {diff.hunks.map((h, i) => (
            <React.Fragment key={i}>
              {h.header && (
                <tr className="diff-hunk">
                  <td colSpan={showOld ? 4 : 3}>
                    {h.header.replace(/@@(.*)@@.*/, '@@$1@@')} <span className="dim">{h.section}</span>
                  </td>
                </tr>
              )}
              {h.lines.map((l, j) => (
                <tr key={j} className={`diff-${l.type}`}>
                  {showOld && <td className="ln">{l.oldNo ?? ''}</td>}
                  <td className="ln">{l.newNo ?? ''}</td>
                  <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                  <td className="code">{l.type === 'note' ? <span className="dim">{l.text}</span> : l.text || ' '}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
