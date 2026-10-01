export function timeAgo(unix) {
  if (!unix) return '—';
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return 'just now';
  const units = [
    [60 * 60 * 24 * 365, 'y'],
    [60 * 60 * 24 * 30, 'mo'],
    [60 * 60 * 24 * 7, 'w'],
    [60 * 60 * 24, 'd'],
    [60 * 60, 'h'],
    [60, 'm'],
  ];
  for (const [size, label] of units) if (s >= size) return `${Math.floor(s / size)}${label} ago`;
  return 'just now';
}

export function fullDate(unix) {
  return unix ? new Date(unix * 1000).toLocaleString() : '';
}

export function basename(p) {
  return p.split('/').filter(Boolean).pop();
}

// The server tells us the home folder (see setHome); show paths under it as "~/…".
let home = null;

export function setHome(dir) {
  home = dir;
}

export function shortPath(p) {
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}
