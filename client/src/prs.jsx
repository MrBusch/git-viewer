import React from 'react';

const STATE = {
  OPEN: ['Open', 'chip-good'],
  DRAFT: ['Draft', 'chip-muted'],
  MERGED: ['Merged', 'chip-merged'],
  CLOSED: ['Closed', 'chip-bad'],
};

const REVIEW = {
  APPROVED: ['approved', 'merged-text'],
  CHANGES_REQUESTED: ['changes requested', 'error-text'],
  REVIEW_REQUIRED: ['needs review', 'dim'],
};

function Checks({ checks }) {
  if (!checks) return null;
  const { passed, failed, pending, failing } = checks;
  if (failed) {
    const names = failing.slice(0, 10).join('\n') + (failing.length > 10 ? `\n…and ${failing.length - 10} more` : '');
    return (
      <span className="error-text" title={`Failing:\n${names}`}>
        ✗ {failed} failing
      </span>
    );
  }
  if (pending) return <span className="unusual" title={`${passed} passed, ${pending} still running`}>◷ {pending} running</span>;
  if (passed) return <span className="merged-text" title={`${passed} checks passed`}>✓ checks</span>;
  return null;
}

// The branch's pull request: link, state, checks, review decision, and unresolved review threads.
export function PrCell({ prs, branch, isDefault }) {
  if (!prs) return <span className="dim small">…</span>;
  if (prs.status !== 'ok' || !branch || isDefault) return <span className="dim">—</span>;

  const pr = prs.byBranch[branch.name];
  if (!pr) {
    // Pushed and still on the remote, but no PR yet: link to GitHub's compare page.
    const head =
      branch.upstream && !branch.gone && !branch.tracksDefault
        ? branch.upstream.replace(/^origin\//, '')
        : branch.remoteMatch
          ? branch.remoteMatch.name.replace(/^origin\//, '')
          : null;
    if (!head) return <span className="dim">—</span>;
    return (
      <a className="pr-create" href={`${prs.compareBase}${encodeURIComponent(head).replace(/%2F/g, '/')}?expand=1`} target="_blank" rel="noreferrer">
        Create PR
      </a>
    );
  }

  const [stateLabel, stateClass] = STATE[pr.state] || [pr.state, 'chip-muted'];
  const open = pr.state === 'OPEN' || pr.state === 'DRAFT';
  const review = open && REVIEW[pr.review];
  const tip = `${pr.title}\n${pr.comments} comment${pr.comments === 1 ? '' : 's'} · ${pr.threads} review thread${pr.threads === 1 ? '' : 's'}, ${pr.unresolved} unresolved`;

  return (
    <div className="stack pr-cell">
      <span>
        <a className="pr-link mono" href={pr.url} target="_blank" rel="noreferrer" title={tip}>
          #{pr.number}
        </a>{' '}
        <span className={`chip ${stateClass}`}>{stateLabel}</span>
      </span>
      {open && (
        <span className="pr-meta small">
          <Checks checks={pr.checks} />
          {review && <span className={review[1]}>{review[0]}</span>}
          {pr.unresolved > 0 && (
            <span className="unusual" title={`${pr.unresolved} of ${pr.threads} review threads unresolved`}>
              {pr.unresolved} unresolved
            </span>
          )}
        </span>
      )}
    </div>
  );
}
