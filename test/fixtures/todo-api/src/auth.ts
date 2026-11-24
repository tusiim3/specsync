import type { Req, Res } from './server';

const TOKENS = new Map<string, string>([['dev-token', 'user-1']]);

/** Wrap a handler so it only runs for requests with a valid bearer token. */
export function requireAuth(handler: (req: Req, res: Res) => void) {
  return (req: Req, res: Res) => {
    const header = req.headers['authorization'] ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    const userId = match ? TOKENS.get(match[1]!) : undefined;
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.userId = userId;
    handler(req, res);
  };
}
