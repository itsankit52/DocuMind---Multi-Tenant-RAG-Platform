/**
 * Outbox Repository
 * Handles operations on the outbox_events table.
 */

async function createEvent(client, {
  organizationId,
  aggregateType,
  aggregateId,
  eventType,
  payload,
}) {
  const query = `
    INSERT INTO outbox_events (
      organization_id, aggregate_type, aggregate_id, event_type, payload, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, 'pending', now())
    RETURNING *;
  `;
  const { rows } = await client.query(query, [
    organizationId,
    aggregateType,
    aggregateId,
    eventType,
    JSON.stringify(payload),
  ]);
  return rows[0];
}

async function markPublished(client, eventId) {
  const query = `
    UPDATE outbox_events
    SET status = 'published', published_at = now()
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await client.query(query, [eventId]);
  return rows[0] || null;
}

async function markFailed(client, eventId, errorMsg) {
  const query = `
    UPDATE outbox_events
    SET status = 'failed', last_error = $2, attempts = attempts + 1
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await client.query(query, [eventId, errorMsg]);
  return rows[0] || null;
}

async function fetchPendingEvents(client, limit = 50, minAgeSeconds = 0) {
  const query = `
    SELECT * FROM outbox_events
    WHERE status = 'pending'
      AND created_at < now() - make_interval(secs => $2::int)
    ORDER BY created_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED;
  `;
  const { rows } = await client.query(query, [limit, minAgeSeconds]);
  return rows;
}

module.exports = {
  createEvent,
  markPublished,
  markFailed,
  fetchPendingEvents,
};
