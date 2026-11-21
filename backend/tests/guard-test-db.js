/**
 * Jest globalSetup: the backend suites TRUNCATE organizations, users, documents, ... on
 * whatever DATABASE_URL points to. Refuse to run unless it names a dedicated *_test
 * database, so `npm test` can never wipe a development or production database.
 */
require('dotenv').config();

module.exports = async () => {
  const url = process.env.DATABASE_URL || '';
  let dbName = '';
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal below
  }
  if (!/_test$/.test(dbName) || process.env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to run backend tests against database "${dbName || '(unparseable DATABASE_URL)'}". ` +
      'The suites TRUNCATE tables: point DATABASE_URL at a dedicated *_test database ' +
      '(e.g. createdb documind_test && DATABASE_URL=.../documind_test node migrate.js).',
    );
  }
};
