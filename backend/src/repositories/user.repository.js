const { pool } = require('../db');

class UserRepository {
  async findByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(email) = lower($1)',
      [email]
    );
    return rows[0];
  }

  /** `db` defaults to the pool; invitation acceptance passes its transaction client. */
  async findById(id, db = pool) {
    const { rows } = await db.query(
      'SELECT id, email, full_name, status FROM users WHERE id = $1',
      [id]
    );
    return rows[0];
  }

  async create({ email, passwordHash, fullName }) {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name, status, created_at',
      [email, passwordHash, fullName]
    );
    return rows[0];
  }
}

module.exports = new UserRepository();
