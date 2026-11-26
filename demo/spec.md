# Express Framework — Specification Document

> This document defines the expected behavior of the Express.js HTTP framework.

---

## Basic Request Routing

The framework must provide a routing mechanism that maps HTTP methods and URL
patterns to handler functions. The router should support:

- `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, and `OPTIONS` methods.
- Exact path matching (e.g. `/users`).
- Parameterized paths (e.g. `/users/:id`) where named segments are extracted
  and made available on the request object as `req.params`.
- Wildcard paths for catch-all routing.
- Multiple handlers per route (handler chaining), where each handler may call
  `next()` to pass control to the subsequent handler.
- Route-level middleware that applies only to a specific path prefix.

## Middleware Pipeline

The framework must implement a linear middleware pipeline through which every
incoming request passes before reaching a route handler. The pipeline must:

- Allow middleware to be registered globally via `app.use()`.
- Execute middleware in the order it was registered.
- Provide each middleware function with `(req, res, next)` arguments.
- Allow middleware to terminate the request by sending a response, or to
  pass control forward by calling `next()`.
- Support error-handling middleware with a four-argument signature
  `(err, req, res, next)` that is invoked when `next(err)` is called.
- Support path-scoped middleware so that `app.use('/api', middleware)` only
  applies to requests whose path begins with `/api`.

## Request Body Parsing

The framework must make request body content available on the `req.body`
property. Supported content types include:

- `application/json` — parsed as a JavaScript object.
- `application/x-www-form-urlencoded` — parsed as key/value pairs.
- `text/plain` — available as a raw string.
- `multipart/form-data` — available via a compatible multipart parser.

The body parser should handle malformed payloads gracefully, responding with
`400 Bad Request` when the body cannot be parsed according to the declared
content type.

## Response Methods

The framework must augment the native Node.js `ServerResponse` object with
convenience methods for common response patterns:

- `res.json(data)` — serialize `data` as JSON, set `Content-Type: application/json`,
  and send the response.
- `res.send(body)` — send a response body; auto-detect content type for strings,
  Buffers, and objects.
- `res.status(code)` — set the HTTP status code; returns `res` for chaining.
- `res.redirect(url)` — send a `302` redirect; optionally accept a status code
  as the first argument.
- `res.render(view, locals)` — render a template using the configured view engine
  and send the resulting HTML.
- `res.set(field, value)` — set a response header; accept an object to set
  multiple headers at once.

## Trust Proxy Configuration

When the application is deployed behind a reverse proxy (nginx, AWS ELB, etc.),
the framework must support a `trust proxy` setting that controls which client IP
addresses are considered trustworthy. Specifically:

- `app.set('trust proxy', true)` should instruct the framework to trust all
  `X-Forwarded-For` headers, exposing the leftmost IP as `req.ip`.
- `app.set('trust proxy', 'loopback')` should trust only requests originating
  from loopback addresses.
- `app.set('trust proxy', n)` where `n` is a number should trust the `n`-th hop
  from the right in the `X-Forwarded-For` chain.
- When `trust proxy` is disabled, `req.ip` must return the socket's remote address,
  ignoring any `X-Forwarded-*` headers.

## Strict Mode Routing

The framework must support a `strict routing` setting that controls whether
route paths are treated as case-sensitive and whether trailing slashes are
significant:

- When `app.set('strict routing', false)` (default), the routes `/users` and
  `/users/` are treated as equivalent.
- When `app.set('strict routing', true)`, trailing slashes become significant:
  `/users` and `/users/` are treated as distinct routes.
- The `case sensitive routing` setting independently controls whether `/Users`
  and `/users` match the same route.

## Request Body Size Limit Enforcement

The framework must enforce a configurable maximum size for incoming request
bodies to protect against denial-of-service attacks via oversized payloads:

- A default limit of `100kb` must be applied to all body-parsing middleware.
- The limit must be configurable via an options object passed to the body parser:
  `app.use(express.json({ limit: '10mb' }))`.
- When a request body exceeds the configured limit, the framework must respond
  with `413 Payload Too Large` before the body is fully read.
- The limit must apply independently to each content-type parser.


## Rate Limiting Middleware

The framework must include built-in rate limiting to prevent abuse:

- A default rate limiter must allow a maximum of 100 requests per 15-minute
  window per IP address.
- Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset`) must be included on every response.
- Requests that exceed the limit must receive a `429 Too Many Requests` response
  with a `Retry-After` header indicating when the client may retry.
- The rate limiter must be configurable and mountable as middleware:
  `app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))`.

