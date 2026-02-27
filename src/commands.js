export function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;

  const [cmd, ...args] = raw.split(/\s+/);
  return {
    cmd: cmd.toLowerCase(),
    args,
    raw
  };
}

export function helpText() {
  return [
    'ðŸ› ï¸ *Admin Commands*',
    '/help',
    '/status',
    '/enable',
    '/disable',
    '/reload',
    '/takeover  (current chat)',
    '/resume    (current chat)',
    '/soul show',
    '/faq show',
    '',
    'Day 2 commands:',
    '/import <url>',
    '/approve',
    '/rollback <version>'
  ].join('\n');
}
