import React, { useCallback, useEffect, useState } from 'react';

export function Modal({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ↑ahead ↓behind relative to some other ref.
export function Sync({ ahead, behind, against, gone, emptyLabel = 'in sync' }) {
  if (gone) return <span className="chip chip-warn" title={`${against} was deleted on the remote`}>upstream gone</span>;
  if (!ahead && !behind)
    return (
      <span className="sync sync-even" title={against ? `Same as ${against}` : undefined}>
        {emptyLabel}
      </span>
    );
  return (
    <span className="sync" title={against ? `${ahead} commit(s) ahead of, ${behind} behind ${against}` : undefined}>
      {ahead > 0 && <span className="sync-ahead">↑{ahead}</span>}
      {behind > 0 && <span className="sync-behind">↓{behind}</span>}
    </span>
  );
}

// "origin/foo" for branch "foo" is shown as just "origin"; anything else in full.
function upstreamLabel(upstream, branch) {
  const i = upstream.indexOf('/');
  return i > 0 && upstream.slice(i + 1) === branch ? upstream.slice(0, i) : upstream;
}

const MERGED_LABEL = { merged: 'merged ✓', 'squash-merged': 'squash-merged ✓', 'not-merged': 'not merged' };

export function UpstreamCell({ name, upstream, ahead, behind, gone, merged, remoteMatch }) {
  if (upstream && gone) {
    return (
      <div className="stack">
        <span className="chip chip-warn" title={`${upstream} was deleted on the remote`}>
          upstream gone
        </span>
        {merged && (
          <span className={`small ${merged === 'not-merged' ? 'error-text' : 'merged-text'}`} title={merged === 'squash-merged' ? 'Its combined change matches a commit on the default branch' : undefined}>
            {MERGED_LABEL[merged]}
          </span>
        )}
      </div>
    );
  }
  if (upstream) {
    const label = upstreamLabel(upstream, name);
    return (
      <div className="stack">
        <Sync ahead={ahead} behind={behind} gone={gone} against={upstream} />
        <span className={`small mono ${label === upstream ? 'unusual' : 'dim'}`} title={upstream}>
          {label === upstream ? `→ ${upstream}` : label}
        </span>
      </div>
    );
  }
  if (remoteMatch) {
    return (
      <div className="stack">
        <Sync ahead={remoteMatch.ahead} behind={remoteMatch.behind} against={remoteMatch.name} />
        <span className="small unusual" title={`${remoteMatch.name} exists, but this branch isn't set to track it`}>
          not tracked
        </span>
      </div>
    );
  }
  return <span className="chip chip-muted">local only</span>;
}

export function StatusChips({ wt }) {
  if (wt.missing) return <span className="chip chip-bad">folder missing</span>;
  if (wt.error) return <span className="chip chip-bad" title={wt.error}>error</span>;
  const s = wt.status;
  if (!s) return <span className="dim">—</span>;
  const chips = [];
  if (wt.operation) chips.push(<span key="op" className="chip chip-bad">{wt.operation} in progress</span>);
  if (s.conflicts) chips.push(<span key="c" className="chip chip-bad">{s.conflicts} conflicted</span>);
  if (s.staged) chips.push(<span key="s" className="chip chip-good">{s.staged} staged</span>);
  if (s.unstaged) chips.push(<span key="u" className="chip chip-warn">{s.unstaged} modified</span>);
  if (s.untracked) chips.push(<span key="n" className="chip chip-muted">{s.untracked} untracked</span>);
  if (!chips.length) chips.push(<span key="clean" className="chip chip-clean">clean</span>);
  return <div className="chips">{chips}</div>;
}

export function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                t.action.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy path' }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={text}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

// Destructive action in two quick clicks: the first arms it ("Discard?"), the second runs it.
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = '', title }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn btn-sm ${armed ? 'btn-danger' : 'btn-danger-ghost'} ${className}`}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

// Toast state shared by the main app and the file view.
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind, text, action) => {
      const id = Math.random();
      setToasts((t) => [...t, { id, kind, text, action }]);
      setTimeout(() => dismiss(id), action ? 12000 : kind === 'error' ? 9000 : 4000);
    },
    [dismiss]
  );
  return { toasts, toast, dismiss };
}

export function fileViewUrl(repoName, worktree, group, file) {
  const q = new URLSearchParams({ repo: repoName, wt: worktree, group, path: file });
  return `#/file?${q.toString()}`;
}
