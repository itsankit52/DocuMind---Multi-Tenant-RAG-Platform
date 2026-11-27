/**
 * oauth_accounts / users access for Google sign-in (migration 009 schema, unchanged).
 *
 * The API login role (documind_api, migration 012) has no direct privilege on oauth_accounts
 * and only SELECT/INSERT on users. Both tables have no RLS and documind_app holds
 * SELECT/INSERT/UPDATE/DELETE on them (migration 009), so every operation here runs inside a
 * transaction that does SET LOCAL ROLE documind_app — the same pattern organization creation
 * uses for its audit entry. No grant or role changes are needed; the role resets at COMMIT.
 */

const { pool } = require('../db');

const PROVIDER_GOOGLE = 'google';

/** Run fn(client) in a READ COMMITTED transaction as documind_app. */
async function withAppRole(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query('SET LOCAL ROLE documind_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const USER_COLUMNS = 'id, email, full_name, status, avatar_url, (password_hash IS NOT NULL) AS has_password';

const repo = {
  withAppRole,
  PROVIDER_GOOGLE,

  /** The user linked to this provider identity (row locked for the rest of the transaction). */
  async findUserByProviderIdentity(db, provider, providerUserId) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.full_name, u.status, u.avatar_url, (u.password_hash IS NOT NULL) AS has_password
       FROM oauth_accounts oa JOIN users u ON u.id = oa.user_id
       WHERE oa.provider = $1 AND oa.provider_user_id = $2
       FOR UPDATE OF oa`,
      [provider, providerUserId],
    );
    return rows[0];
  },

  async findUserByEmail(db, email) {
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email]);
    return rows[0];
  },

  /** Lock a user row (linking: serializes concurrent link attempts for the same user). */
  async findUserForUpdate(db, userId) {
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    return rows[0];
  },

  async findProviderLinkForUser(db, userId, provider) {
    const { rows } = await db.query(
      'SELECT id FROM oauth_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
    return rows[0];
  },

  /** Google-only account: no password (password_hash NULL, migration 009). */
  async createUser(db, { email, fullName, avatarUrl }) {
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, avatar_url)
       VALUES ($1, NULL, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [email, fullName, avatarUrl],
    );
    return rows[0];
  },

  async linkProvider(db, { userId, provider, providerUserId }) {
    await db.query(
      'INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)',
      [userId, provider, providerUserId],
    );
  },

  /** Refresh the avatar, and fill the name only when the user has none (never overwrite it). */
  async updateProfileFromProvider(db, userId, { fullName, avatarUrl }) {
    await db.query(
      `UPDATE users
       SET avatar_url = COALESCE($2, avatar_url),
           full_name = COALESCE(NULLIF(full_name, ''), $3),
           updated_at = now()
       WHERE id = $1`,
      [userId, avatarUrl, fullName],
    );
  },

  /** Sign-in methods for the account page: { password, google }. */
  async getAuthMethods(userId) {
    return withAppRole(async (db) => {
      const { rows: [row] } = await db.query(
        `SELECT (u.password_hash IS NOT NULL) AS password,
                EXISTS (SELECT 1 FROM oauth_accounts oa WHERE oa.user_id = u.id AND oa.provider = $2) AS google
         FROM users u WHERE u.id = $1`,
        [userId, PROVIDER_GOOGLE],
      );
      return row || { password: false, google: false };
    });
  },
};

module.exports = repo;
