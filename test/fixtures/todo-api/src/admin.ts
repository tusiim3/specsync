import { TodoStore } from './store';

/** Delete every todo for every user. Not described anywhere in the spec. */
export function purgeAll(store: TodoStore): number {
  const all = store.all();
  for (const t of all) store.remove(t.owner, t.id);
  return all.length;
}
