# DocuMind API Reference

Multi-tenant RAG Document Q&A Platform — Backend REST API.

All endpoints are prefixed with `/api`. All requests and responses use `application/json` unless noted otherwise.

---

## Table of Contents

- [Authentication](#authentication)
- [Common Conventions](#common-conventions)
- [Auth Endpoints](#auth-endpoints)
- [Organization Endpoints](#organization-endpoints)
- [Document Endpoints](#document-endpoints)
- [RAG Query Endpoint](#rag-query-endpoint)
- [Conversation Endpoints](#conversation-endpoints) ← Step 9
- [Streaming Chat (SSE)](#streaming-chat-sse) ← Step 10
- [Error Reference](#error-reference)

---

## Authentication

DocuMind uses **JWT Bearer tokens** for authentication.

After logging in, include the access token in every protected request:

```
Authorization: Bearer <accessToken>
```

Tokens are also accepted via `HttpOnly` cookie (`accessToken`) for browser clients.

---

## Common Conventions

### Tenant Context

Every protected endpoint (except `/api/auth/*` and `/api/organizations`) requires an active organization context:

```
X-Organization-Id: <organizationId>
```

The server **always** derives `organization_id` from this header combined with your authenticated membership. Any `organizationId` supplied in a request body is ignored as an authority.

### RBAC Roles

| Role | Permissions |
|---|---|
| `admin` | Full access — create, read, update, delete |
| `member` | Create, read, update, delete (same as admin for most resources) |
| `viewer` | Read-only (some create operations also permitted) |

### Success Response Shape

```json
{
  "status": "success",
  "data": { ... }
}
```

### Error Response Shape

```json
{
  "status": "fail",
  "message": "Human-readable error description"
}
```

### Pagination

Paginated list endpoints accept `?page=1&limit=20` query parameters and return:

```json
{
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 42,
    "totalPages": 3
  }
}
```

---

## Auth Endpoints

### POST /api/auth/register

Register a new user account.

**Authentication:** None required

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "fullName": "Jane Smith"
}
```

**Response `201`:**

```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "fullName": "Jane Smith"
    }
  }
}
```

---

### POST /api/auth/login

Authenticate and obtain access + refresh tokens.

**Authentication:** None required

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!"
}
```

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "accessToken": "eyJhbGci...",
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "fullName": "Jane Smith"
    }
  }
}
```

---

### POST /api/auth/refresh

Refresh an expired access token using the refresh token (cookie or body).

**Response `200`:** Same shape as login.

---

### POST /api/auth/logout

Invalidate the current session.

**Authentication:** Required

**Response `200`:**

```json
{ "status": "success", "message": "Logged out successfully." }
```

---

### GET /api/auth/me

Return the currently authenticated user's profile.

**Authentication:** Required

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "user": { "id": "uuid", "email": "...", "fullName": "..." }
  }
}
```

---

## Organization Endpoints

All organization endpoints require authentication (`Authorization` header). They do **not** require `X-Organization-Id`.

### POST /api/organizations

Create a new organization. The creating user automatically becomes an `admin` member.

**Request body:**

```json
{
  "name": "Acme Corp",
  "slug": "acme-corp"
}
```

**Response `201`:**

```json
{
  "status": "success",
  "data": {
    "org": { "id": "uuid" }
  }
}
```

---

### GET /api/organizations/my-organizations

List all organizations the authenticated user is a member of.

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "organizations": [
      { "organization_id": "uuid", "name": "Acme Corp", "slug": "acme-corp", "role": "admin" }
    ]
  }
}
```

---

## Document Endpoints

All document endpoints require `Authorization` + `X-Organization-Id`.

### POST /api/documents

Upload a document (PDF or DOCX). Triggers async processing pipeline.

**Authentication:** Required | **RBAC:** admin, member

**Request:** `multipart/form-data` with field `file`.

**Constraints:**
- Max file size: `MAX_FILE_SIZE_MB` (default 10 MB)
- Accepted types: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`

**Response `201`:**

```json
{
  "status": "success",
  "data": {
    "document": {
      "id": "uuid",
      "organization_id": "uuid",
      "uploaded_by": "uuid",
      "filename": "report.pdf",
      "original_name": "report.pdf",
      "mime_type": "application/pdf",
      "file_size": 204800,
      "storage_key": "organizations/<orgId>/documents/<docId>/original/report.pdf",
      "checksum": "sha256hex",
      "status": "uploaded",
      "created_at": "2026-09-24T10:00:00Z",
      "job": { "id": "uuid", "status": "queued" }
    }
  }
}
```

---

### GET /api/documents

List documents for the current organization. Supports `?page=1&limit=20`.

**RBAC:** admin, member, viewer

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "documents": [ { ...document } ],
    "pagination": { "page": 1, "limit": 20, "totalCount": 5, "totalPages": 1 }
  }
}
```

---

### GET /api/documents/:documentId

Get document metadata.

**RBAC:** admin, member, viewer

**Response `200`:** `{ "status": "success", "data": { "document": { ... } } }`

---

### GET /api/documents/:documentId/processing

Get document processing status and chunk count.

**RBAC:** admin, member, viewer

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "documentId": "uuid",
    "filename": "report.pdf",
    "documentStatus": "ready",
    "chunkCount": 12,
    "job": {
      "id": "uuid",
      "status": "completed",
      "stage": "embedding",
      "attempts": 1,
      "errorLog": null
    }
  }
}
```

**Document statuses:** `uploading` → `uploaded` → `processing` → `ready` | `failed`

---

### GET /api/documents/:documentId/download

Stream the original file.

**RBAC:** admin, member, viewer

**Response `200`:** Binary file stream with appropriate `Content-Type` and `Content-Disposition` headers.

---

### PATCH /api/documents/:documentId

Rename a document.

**RBAC:** admin, member

**Request body:** `{ "filename": "new-name.pdf" }`

**Response `200`:** `{ "status": "success", "data": { "document": { ... } } }`

---

### DELETE /api/documents/:documentId

Soft-delete a document.

**RBAC:** admin, member

**Response `200`:** `{ "status": "success", "message": "Document deleted successfully" }`

---

### POST /api/documents/:documentId/reprocess

Re-trigger processing for a failed document.

**RBAC:** admin, member

**Response `200`:** `{ "status": "success", "data": { ... } }`

---

## RAG Query Endpoint

### POST /api/rag/query

Execute a single-turn RAG question against the organization's indexed documents.

**Authentication:** Required | **RBAC:** admin, member, viewer

> For multi-turn conversations, use `POST /api/conversations/:id/messages` instead.

**Request body:**

```json
{
  "question": "What is the annual leave policy?",
  "topK": 5,
  "scoreThreshold": 0.0
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | ✅ | User question (max `RAG_MAX_QUESTION_LENGTH` chars) |
| `topK` | number | ❌ | Number of document chunks to retrieve (default: `RAG_TOP_K`) |
| `scoreThreshold` | number | ❌ | Minimum similarity score (default: `RAG_SCORE_THRESHOLD`) |

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "answer": "Employees receive 28 paid vacation days per year.",
    "sources": [
      {
        "documentId": "uuid",
        "chunkId": "uuid",
        "documentName": "hr-policy.pdf",
        "chunkIndex": 2,
        "pageStart": 4,
        "pageEnd": 4,
        "score": 0.92
      }
    ],
    "retrieval": {
      "topK": 5,
      "returnedChunks": 2
    }
  }
}
```

**Security notes:**
- `organizationId` in request body is ignored — tenant derived from `X-Organization-Id` header only
- Raw embeddings, system prompts, and internal Qdrant payloads are never returned

---

## Conversation Endpoints

Multi-turn persistent chat with RAG-grounded answers. All endpoints require `Authorization` + `X-Organization-Id`.

### POST /api/conversations

Create a new conversation.

**Authentication:** Required | **RBAC:** admin, member, viewer

**Request body:**

```json
{
  "title": "Leave Policy Discussion"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | ❌ | Conversation title (max 255 chars, defaults to `"New Chat"`) |

> `organizationId` in the request body is **ignored**. The organization is always determined from `X-Organization-Id`.

**Response `201`:**

```json
{
  "status": "success",
  "data": {
    "conversation": {
      "id": "uuid",
      "organization_id": "uuid",
      "user_id": "uuid",
      "title": "Leave Policy Discussion",
      "created_at": "2026-09-24T10:00:00Z",
      "updated_at": "2026-09-24T10:00:00Z",
      "deleted_at": null
    }
  }
}
```

---

### GET /api/conversations

List all non-deleted conversations for the current organization, ordered by most recently active.

**Authentication:** Required | **RBAC:** admin, member, viewer

**Query parameters:** `?page=1&limit=20`

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "conversations": [
      {
        "id": "uuid",
        "organization_id": "uuid",
        "user_id": "uuid",
        "title": "Leave Policy Discussion",
        "created_at": "2026-09-24T10:00:00Z",
        "updated_at": "2026-09-24T10:05:00Z",
        "deleted_at": null
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalCount": 3,
      "totalPages": 1
    }
  }
}
```

**Security:** Only conversations belonging to the authenticated organization are returned. RLS enforces this at the database level regardless of application logic.

---

### GET /api/conversations/:conversationId

Get a single conversation and its complete message history.

**Authentication:** Required | **RBAC:** admin, member, viewer

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "conversation": {
      "id": "uuid",
      "organization_id": "uuid",
      "user_id": "uuid",
      "title": "Leave Policy Discussion",
      "created_at": "2026-09-24T10:00:00Z",
      "updated_at": "2026-09-24T10:05:00Z",
      "deleted_at": null
    },
    "messages": [
      {
        "id": "uuid",
        "conversation_id": "uuid",
        "role": "user",
        "content": "What is the annual leave policy?",
        "created_at": "2026-09-24T10:01:00Z"
      },
      {
        "id": "uuid",
        "conversation_id": "uuid",
        "role": "assistant",
        "content": "Employees receive 28 paid vacation days per year.",
        "created_at": "2026-09-24T10:01:05Z"
      }
    ]
  }
}
```

**Errors:**
- `404` — Conversation not found or belongs to another organization (indistinguishable by design — no info leak)

---

### PATCH /api/conversations/:conversationId

Rename a conversation.

**Authentication:** Required | **RBAC:** admin, member (viewer: 403)

**Request body:**

```json
{
  "title": "Updated Title"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | ✅ | Non-empty, max 255 chars |

> Fields `organization_id`, `user_id`, and ownership metadata cannot be changed via this endpoint.

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "conversation": {
      "id": "uuid",
      "title": "Updated Title",
      "organization_id": "uuid",
      "updated_at": "2026-09-24T11:00:00Z"
    }
  }
}
```

**Errors:**
- `400` — Title is empty or whitespace
- `403` — Viewer role cannot rename
- `404` — Conversation not found or belongs to another organization

---

### DELETE /api/conversations/:conversationId

Soft-delete a conversation. The conversation is hidden from all listings but its messages and citations remain in the database for audit purposes.

**Authentication:** Required | **RBAC:** admin, member (viewer: 403)

**Response `200`:**

```json
{
  "status": "success",
  "message": "Conversation deleted successfully."
}
```

**Errors:**
- `403` — Viewer role cannot delete
- `404` — Conversation not found or belongs to another organization

---

### GET /api/conversations/:conversationId/messages

List all messages in a conversation in chronological order.

**Authentication:** Required | **RBAC:** admin, member, viewer

**Response `200`:**

```json
{
  "status": "success",
  "data": {
    "messages": [
      {
        "id": "uuid",
        "conversation_id": "uuid",
        "role": "user",
        "content": "What is the leave policy?",
        "created_at": "2026-09-24T10:01:00Z"
      },
      {
        "id": "uuid",
        "conversation_id": "uuid",
        "role": "assistant",
        "content": "The company provides 28 paid annual leave days.",
        "created_at": "2026-09-24T10:01:05Z"
      }
    ]
  }
}
```

**Errors:**
- `404` — Conversation not found or belongs to another organization

---

### POST /api/conversations/:conversationId/messages

Send a user message and receive a RAG-grounded assistant reply. This is the primary chat endpoint.

**Authentication:** Required | **RBAC:** admin, member, viewer

**Rate limit:** `CHAT_RATE_LIMIT` requests per `CHAT_RATE_WINDOW` ms, keyed by `tenantId:userId`

**Request headers:**

```
Idempotency-Key: <client-generated-unique-key>   (optional)
```

The `Idempotency-Key` header prevents duplicate assistant responses if the same request is retried. A replay returns `HTTP 200` with `idempotent: true` in the response body instead of re-running the LLM.

**Request body:**

```json
{
  "content": "Who is eligible for the annual leave benefit?"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `content` | string | ✅ | User question, max `CHAT_MAX_QUESTION_LENGTH` chars (default 1000) |

**Full RAG pipeline executed per request:**

1. Validate conversation ownership (tenant isolation)
2. Check idempotency key
3. Load prior conversation history (last `MAX_CONVERSATION_MESSAGES` turns)
4. Persist user message to database (committed before LLM call)
5. Embed question → Qdrant tenant-filtered vector search → PostgreSQL RLS cross-verification
6. Build document context + conversation history context
7. Generate grounded answer via Ollama LLM
8. Persist assistant message + citations atomically
9. Return structured response

**Response `201` (new message):**

```json
{
  "status": "success",
  "data": {
    "conversation": {
      "id": "uuid",
      "title": "Leave Policy Discussion"
    },
    "userMessage": {
      "id": "uuid",
      "conversationId": "uuid",
      "role": "user",
      "content": "Who is eligible for the annual leave benefit?",
      "createdAt": "2026-09-24T10:02:00Z"
    },
    "assistantMessage": {
      "id": "uuid",
      "conversationId": "uuid",
      "role": "assistant",
      "content": "Employees who have completed 6 months of continuous service are eligible.",
      "createdAt": "2026-09-24T10:02:04Z"
    },
    "citations": [
      {
        "id": "uuid",
        "documentId": "uuid",
        "chunkId": "uuid",
        "documentName": "hr-policy.pdf",
        "chunkIndex": 3,
        "page": 2,
        "relevanceScore": 0.91
      }
    ]
  }
}
```

**Response `200` (idempotent replay):**

Same shape as above with an additional field:

```json
{
  "status": "success",
  "data": {
    ...same as above...,
    "idempotent": true
  }
}
```

**Security notes:**
- Raw embeddings, Qdrant internal payloads, and system prompts are never returned
- Conversation history is treated as untrusted user content — it cannot override system instructions
- `organizationId` in request body is ignored
- If the LLM fails, no fake assistant message is persisted; an appropriate error is returned

**Errors:**

| Status | Cause |
|---|---|
| `400` | Missing or empty `content`, or content exceeds max length |
| `401` | Not authenticated |
| `403` | User is not a member of the organization in `X-Organization-Id` |
| `404` | Conversation not found or belongs to another organization |
| `429` | Chat rate limit exceeded |
| `503` | LLM (Ollama) or retrieval (Qdrant) service unavailable |

---

## Streaming Chat (SSE)

### POST /api/conversations/:conversationId/messages/stream

Same pipeline as `POST /api/conversations/:conversationId/messages` (authentication → tenant → RBAC → rate limit → conversation check → save user message → tenant-filtered RAG → Ollama), but the answer is delivered incrementally as Server-Sent Events. The server accumulates the answer itself and persists **one** assistant message plus its citations when generation completes.

**Auth:** Required (cookie `accessToken` or `Authorization: Bearer`) · **Roles:** admin, member, viewer · **Rate limit:** shares the chat budget (`CHAT_RATE_LIMIT` per `CHAT_RATE_WINDOW`) with the non-streaming endpoint.

**Headers:**
```
Content-Type: application/json
Accept: text/event-stream
X-Organization-Id: <organization-uuid>
Idempotency-Key: <client-generated-key>      (optional, 1-128 chars)
```

**Request:**
```json
{ "content": "What is the leave policy?" }
```

Any `organizationId` in the body is ignored when `X-Organization-Id` is sent — tenant scope always comes from the authenticated user's validated membership.

> Browser note: `EventSource` only supports GET without custom headers, so clients should consume this endpoint with `fetch()` and read `response.body` as a stream. Authentication is not relaxed for SSE.

#### Before the stream starts: normal HTTP errors

All checks run before any SSE bytes are sent. Failures are ordinary JSON error responses (see [Error Response Shape](#error-response-shape)); no `start` event is sent and nothing is streamed.

| Status | Cause |
|---|---|
| `400` | Missing/empty `content`, `content` too long, invalid `Idempotency-Key` |
| `401` | Not authenticated |
| `403` | Not an active member of the organization / insufficient role |
| `404` | Conversation not found, invalid id, or belongs to another organization |
| `409` | `Idempotency-Key` reused for a request that never completed (or is still running) — retry with a new key |
| `429` | Chat rate limit exceeded |
| `503` | Server is shutting down |

#### After the stream starts: SSE events

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

Each event is one frame: `event: <name>`, `data: <single-line JSON>`, blank line. `data` is always JSON (newlines inside text are escaped).

| Event | `data` | When |
|---|---|---|
| `start` | `{ "conversationId", "userMessageId" }` (+ `"replayed": true` on idempotent replay) | User message persisted, generation starting |
| `token` | `{ "text": "The" }` | Each incremental piece of the answer. Concatenate `text` in order. Boundaries are arbitrary. |
| `citation` | `{ "id", "documentId", "chunkId", "documentName", "chunkIndex", "page", "relevanceScore" }` | One per persisted citation, after the answer is saved |
| `done` | `{ "conversationId", "messageId", "finishReason" }` | Assistant message **and** citations committed. `messageId` = assistant message. `finishReason`: `stop`, `length` (model hit its token limit), or `replay` |
| `error` | `{ "code", "message" }` | Terminal failure. `message` is safe to show to users |
| *(comment)* | `: heartbeat` | Every `SSE_HEARTBEAT_INTERVAL_MS` to keep proxies from closing idle connections. Ignore it. |

**Lifecycle guarantees**

- Success: `start → token+ → citation* → done`, then the connection closes.
- Failure: `start → token* → error`, then the connection closes. Discard any tokens received; nothing is persisted as the assistant reply.
- Exactly one terminal event (`done` **or** `error`); nothing is sent after it.
- `done` is sent only after the database commit succeeded. If persistence fails you get `error` (`PERSISTENCE_ERROR`), never `done`.
- The persisted assistant message content equals the concatenation of all `token.text` values.

**`error` codes**

| Code | Meaning |
|---|---|
| `RETRIEVAL_ERROR` | Embedding, vector search (Qdrant) or PostgreSQL verification failed |
| `LLM_STREAM_ERROR` | The model failed, was unreachable, or its stream ended abnormally |
| `RESPONSE_TOO_LARGE` | Answer exceeded `MAX_STREAMED_RESPONSE_CHARS`; generation stopped, nothing saved |
| `STREAM_TIMEOUT` | Stream exceeded `CHAT_STREAM_TIMEOUT_MS`; generation stopped, nothing saved |
| `PERSISTENCE_ERROR` | Answer generated but could not be saved |
| `SERVER_SHUTTING_DOWN` | Server is restarting; retry shortly |
| `INTERNAL_ERROR` | Unexpected failure |

Internal details (upstream errors, URLs, stack traces, prompts, database errors) are never sent; they are recorded in the audit log only.

**Example**
```bash
curl -N -X POST http://localhost:3000/api/conversations/<CONVERSATION_ID>/messages/stream \
  -H "Authorization: Bearer <TOKEN>" -H "X-Organization-Id: <ORG_ID>" \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"content":"What is the leave policy?"}'
```
```
event: start
data: {"conversationId":"0199...","userMessageId":"0199..."}

event: token
data: {"text":"Employees"}

event: token
data: {"text":" receive 28 days"}

event: citation
data: {"id":"...","documentId":"...","chunkId":"...","documentName":"policy.pdf","chunkIndex":0,"page":1,"relevanceScore":0.82}

event: done
data: {"conversationId":"0199...","messageId":"0199...","finishReason":"stop"}
```

#### Disconnects, cancellation and timeouts

- **Client disconnect:** closing the connection aborts the in-flight Ollama request (via `AbortController`), stops processing and releases resources. No assistant message is saved; the user message remains. Audit: `CHAT_STREAM_CANCELLED`. There is no separate cancel endpoint — disconnecting cancels.
- **Timeout:** `CHAT_STREAM_TIMEOUT_MS` bounds the whole stream (retrieval + generation). On expiry the model request is aborted and `error: STREAM_TIMEOUT` is sent.
- **Shutdown:** on `SIGTERM`/`SIGINT` new streams get `503`, active streams are aborted with `error: SERVER_SHUTTING_DOWN`, then the existing graceful shutdown proceeds.

#### Idempotency

Same `Idempotency-Key` header as the non-streaming endpoint (keys are per conversation):

- Key already used for a **completed** exchange → the stored answer is replayed with the same event protocol (`finishReason: "replay"`). No LLM call, no new rows.
- Key used for an exchange that **did not complete** (e.g. the stream was interrupted) → `409`. Retry with a new key. This guarantees one key never produces two assistant messages.

#### Audit events

`CHAT_STREAM_STARTED`, `CHAT_STREAM_COMPLETED`, `CHAT_STREAM_FAILED` (with `code`), `CHAT_STREAM_CANCELLED` (with `reason`). One record per stream stage, never per token. Actor is the authenticated user.

#### Reverse proxy configuration

No proxy is part of this repository. If one is placed in front of the API, disable buffering for this route and allow long reads, e.g. Nginx:

```nginx
location ~ ^/api/conversations/[^/]+/messages/stream$ {
    proxy_pass http://documind_api;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # X-Accel-Buffering: no is also sent by the API
    proxy_cache off;
    proxy_read_timeout 180s;      # > CHAT_STREAM_TIMEOUT_MS
    gzip off;
}
```

The API does not use response compression; if compression middleware is added later, exclude `text/event-stream`.

---

## Error Reference

| HTTP Status | Meaning |
|---|---|
| `400` | Bad request — invalid input, missing required fields |
| `401` | Unauthenticated — missing or invalid/expired JWT |
| `403` | Forbidden — not a member of the organization, or insufficient role |
| `404` | Not found — resource does not exist, or belongs to another tenant |
| `409` | Conflict — duplicate resource (e.g. email already registered), or reused incomplete `Idempotency-Key` on streaming chat |
| `413` | File too large — exceeds `MAX_FILE_SIZE_MB` |
| `429` | Too many requests — rate limit exceeded |
| `500` | Internal server error — unexpected failure |
| `503` | Service unavailable — LLM or vector store unreachable |

---

## Environment Configuration Reference

The following environment variables control conversation and chat behaviour.

| Variable | Default | Description |
|---|---|---|
| `MAX_CONVERSATION_MESSAGES` | `10` | Max prior messages included in LLM context per turn |
| `MAX_CONVERSATION_CONTEXT_CHARS` | `4000` | Max characters from conversation history injected into the prompt |
| `CHAT_MAX_QUESTION_LENGTH` | `1000` | Max allowed length of a single user message |
| `CHAT_RATE_LIMIT` | `20` | Max chat requests per rate window per user (production default) |
| `CHAT_RATE_WINDOW` | `60000` | Rate limit window in milliseconds |
| `RAG_TOP_K` | `5` | Number of document chunks retrieved per query |
| `RAG_SCORE_THRESHOLD` | `0.0` | Minimum vector similarity score for chunk inclusion |
| `RAG_MAX_CONTEXT_CHARS` | `15000` | Max characters of document context injected into the LLM prompt |
| `RAG_MAX_QUESTION_LENGTH` | `1000` | Max question length for direct RAG queries |
| `SSE_HEARTBEAT_INTERVAL_MS` | `15000` | Interval between SSE `: heartbeat` comments on streaming chat |
| `CHAT_STREAM_TIMEOUT_MS` | `120000` | Hard limit for one streaming chat response (retrieval + generation) |
| `MAX_STREAMED_RESPONSE_CHARS` | `10000` | Max streamed answer length; longer answers are stopped with `RESPONSE_TOO_LARGE` |

---

## Multi-Turn Conversation Flow

```
Client                          API Server                        Services
  │                                │                                 │
  ├─ POST /api/conversations ──────►│                                 │
  │◄─ 201 { conversation } ─────────┤                                 │
  │                                │                                 │
  ├─ POST /conversations/:id/messages ──►                             │
  │    { content: "What is leave policy?" }                           │
  │                                │── Validate conv + idempotency ──►│
  │                                │── Persist user message ──────────►│ (TX-A committed)
  │                                │── ragService.answerQuestion ─────►│
  │                                │       embed → Qdrant → PG RLS    │
  │                                │       build context + history     │
  │                                │       Ollama generate ───────────►│
  │                                │◄─ answer + sources ───────────────│
  │                                │── Persist asst msg + citations ──►│ (TX-B committed)
  │◄─ 201 { userMsg, assistantMsg, citations } ──────────────────────┤
  │                                │                                 │
  ├─ POST /conversations/:id/messages ──►                             │
  │    { content: "Who is eligible?" }  ← follow-up with context     │
  │                                │── Load prior messages ───────────►│
  │                                │── (prior turns prepended to prompt)│
  │◄─ 201 { grounded follow-up answer } ─────────────────────────────┤
```

---

## Idempotency

To prevent duplicate messages from network retries, include a client-generated `Idempotency-Key` header:

```
POST /api/conversations/:id/messages
Idempotency-Key: unique-key-per-request-abc123
```

- On the **first** request with this key: the full pipeline runs, `HTTP 201` is returned
- On any **subsequent** request with the same key (same conversation): the original response is returned, `HTTP 200` with `"idempotent": true` — no second LLM call

Keys are scoped per conversation. The same key in a different conversation creates a new message pair.

---

## Tenant Isolation Guarantees

PostgreSQL Row-Level Security (RLS) enforces the following independently of application code:

- `SELECT` — only rows where `organization_id = app.current_tenant` are visible
- `INSERT` — only rows where `organization_id = app.current_tenant` pass the `WITH CHECK`
- `UPDATE` / `DELETE` — only rows where `organization_id = app.current_tenant` are affected

Tables covered: `documents`, `document_processing_jobs`, `document_chunks`, `conversations`, `messages`, `citations`, `audit_logs`

The application role `documind_app` (NOLOGIN, SELECT/INSERT/UPDATE/DELETE only — migration 008) has RLS enforced via `FORCE ROW LEVEL SECURITY`; every tenant-scoped request runs inside `withTenantTransaction()`, which does `SET LOCAL ROLE documind_app`.

System paths that run outside a tenant transaction — auth lookups, membership checks, audit writes, worker job bookkeeping and the outbox relay — connect as `documind_runtime` (BYPASSRLS, see migration 007). Those queries are scoped explicitly in application code (e.g. by `organization_id`) rather than by RLS. `organizations`, `users`, `memberships` and `outbox_events` are not RLS tables.
