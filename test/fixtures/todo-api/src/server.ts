import { requireAuth } from './auth';
import { TodoStore } from './store';

const store = new TodoStore();
const MAX_TITLE = 200;

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: Record<string, unknown>;
  userId?: string;
  headers: Record<string, string | undefined>;
}
export interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

/** POST /todos: validate the title and create a todo. */
export function createTodo(req: Req, res: Res): void {
  const title = req.body['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  if (title.length > MAX_TITLE) {
    res.status(400).json({ error: `title must be at most ${MAX_TITLE} characters` });
    return;
  }
  const todo = store.create(req.userId!, title);
  res.status(201).json(todo);
}

/** GET /todos: newest first, paginated with ?limit (default 20, max 100). */
export function listTodos(req: Req, res: Res): void {
  const requested = Number(req.query['limit'] ?? 20);
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 20, 100);
  res.status(200).json(store.list(req.userId!).slice(0, limit));
}

/** DELETE /todos/:id */
export function deleteTodo(req: Req, res: Res): void {
  const removed = store.remove(req.userId!, req.params['id']!);
  if (!removed) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).json(null);
}

export function health(_req: Req, res: Res): void {
  res.status(200).json({ ok: true });
}

export const routes = [
  { method: 'GET', path: '/health', handler: health },
  { method: 'POST', path: '/todos', handler: requireAuth(createTodo) },
  { method: 'GET', path: '/todos', handler: requireAuth(listTodos) },
  { method: 'DELETE', path: '/todos/:id', handler: requireAuth(deleteTodo) },
];
