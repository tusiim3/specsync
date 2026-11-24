import { randomUUID } from 'crypto';

export interface Todo {
  id: string;
  owner: string;
  title: string;
  done: boolean;
  dueAt?: Date;
  createdAt: Date;
}

/** In-memory todo storage. */
export class TodoStore {
  private todos: Todo[] = [];

  create(owner: string, title: string, dueAt?: Date): Todo {
    const todo = { id: randomUUID(), owner, title, done: false, dueAt, createdAt: new Date() };
    this.todos.push(todo);
    return todo;
  }

  list(owner: string): Todo[] {
    return this.todos
      .filter((t) => t.owner === owner)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  remove(owner: string, id: string): boolean {
    const before = this.todos.length;
    this.todos = this.todos.filter((t) => !(t.owner === owner && t.id === id));
    return this.todos.length < before;
  }

  all(): Todo[] {
    return [...this.todos];
  }
}
