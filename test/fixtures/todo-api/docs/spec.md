# Todo API Specification

A small service for managing personal todo items.

## REQ-1: Create todos

`POST /todos` creates a todo from a JSON body with a `title` field. The title is
required and must be at most 200 characters; otherwise the API responds with
`400 Bad Request` and an error message. A created todo responds `201` with the
new todo, including its generated `id`.

## REQ-2: List todos with pagination

`GET /todos` returns the caller's todos, newest first. The `limit` query
parameter controls page size: it defaults to 20 and may not exceed 100.

## REQ-3: Delete todos

`DELETE /todos/:id` removes a todo. Only authenticated callers may delete, and
deleting an id that does not exist responds `404 Not Found`.

## REQ-4: Authentication

Every endpoint except `GET /health` requires an `Authorization: Bearer <token>`
header. Missing or invalid tokens are rejected with `401 Unauthorized`.

## REQ-5: Due date reminders

A background worker emails the owner of each todo 24 hours before its due date.
A todo must never trigger more than one reminder email.

## REQ-6: CSV export

Todos can be exported as CSV with a header row `id,title,done` followed by one
row per todo.

## REQ-7: Rate limiting

Each token may make at most 100 requests per minute. Further requests are
rejected with `429 Too Many Requests`.

## REQ-8: Audit log

Every deletion is recorded in an audit log with the user id and a timestamp.

## REQ-9: API documentation

The API reference must be published on the company developer portal and kept up
to date with each release.

## Out of scope

- Mobile apps
- Shared lists between users
