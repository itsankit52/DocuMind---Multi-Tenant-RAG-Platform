/**
 * Google sign-in: map a VERIFIED Google identity to a DocuMind user (see google.oauth.js for
 * verification). Every decision uses only verified ID-token claims; the browser supplies no
 * identity. All reads/writes for one attempt run in one transaction (oauth.repository).
 *
 * Sign-in (intent 'login'):
 *  A. new Google identity, email not registered → create user (no password) + oauth_accounts
 *     row atomically. No organization is created or joined: the user goes to onboarding, and
 *     invitations still have to be accepted explicitly.
 *  B. Google identity already linked → that user, if active. Avatar refreshed, name only filled
 *     when empty. The user's email is NOT changed.
 *  C. new Google identity but the email already belongs to an account → refused
 *     ('account_exists'): accounts are never linked just because emails match. The owner signs
 *     in with their password and links Google explicitly (intent 'link').
 *  D. Google identity linked to user X while its email now belongs to another user Y → refused
 *     ('account_conflict'), nothing transferred or merged; a sanitized security event is logged.
 *
 * Linking (intent 'link', started by an authenticated user who re-entered their password):
 *  the identity must not be linked to anyone, the user must have no Google link yet, and the
 *  verified Google email must equal the account email.
 *
 * Failures are GoogleAuthError codes, mapped to fixed messages by the frontend.
 */

const { GoogleAuthError } = require('./google.oauth');
const oauthRepo = require('../repositories/oauth.repository');
const logger = require('../observability/logger');

const PROVIDER = oauthRepo.PROVIDER_GOOGLE;
const UNIQUE_VIOLATION = '23505';

function securityEvent(event, fields) {
  // Ids only: never emails, Google subject identifiers or tokens.
  logger.warn('Google sign-in refused', { event, provider: PROVIDER, ...fields });
}

async function resolveOnce(identity) {
  return oauthRepo.withAppRole(async (db) => {
    const linked = await oauthRepo.findUserByProviderIdentity(db, PROVIDER, identity.sub);

    if (linked) { // Case B / D
      if (linked.status !== 'active') throw new GoogleAuthError('account_disabled');
      const owner = await oauthRepo.findUserByEmail(db, identity.email);
      if (owner && owner.id !== linked.id) {
        securityEvent('oauth_email_conflict', { linkedUserId: linked.id, otherUserId: owner.id });
        throw new GoogleAuthError('account_conflict');
      }
      await oauthRepo.updateProfileFromProvider(db, linked.id, { fullName: identity.name, avatarUrl: identity.picture });
      return { user: linked, created: false };
    }

    const existing = await oauthRepo.findUserByEmail(db, identity.email);
    if (existing) { // Case C
      if (existing.status !== 'active') throw new GoogleAuthError('account_disabled');
      throw new GoogleAuthError('account_exists');
    }

    // Case A
    const user = await oauthRepo.createUser(db, { email: identity.email, fullName: identity.name, avatarUrl: identity.picture });
    await oauthRepo.linkProvider(db, { userId: user.id, provider: PROVIDER, providerUserId: identity.sub });
    return { user, created: true };
  });
}

/** Sign-in or sign-up with a verified Google identity → { user, created }. */
async function signInWithGoogle(identity) {
  try {
    return await resolveOnce(identity);
  } catch (err) {
    // A concurrent first sign-in with the same identity/email won the insert: resolve again,
    // which now finds the committed row (B) or the existing account (C).
    if (err && err.code === UNIQUE_VIOLATION) return resolveOnce(identity);
    throw err;
  }
}

/** Link a verified Google identity to an authenticated user (intent 'link'). */
async function linkGoogleAccount(userId, identity) {
  try {
    return await oauthRepo.withAppRole(async (db) => {
      const user = await oauthRepo.findUserForUpdate(db, userId);
      if (!user || user.status !== 'active') throw new GoogleAuthError('account_disabled');

      const linked = await oauthRepo.findUserByProviderIdentity(db, PROVIDER, identity.sub);
      if (linked) {
        if (linked.id === user.id) return { user, alreadyLinked: true };
        securityEvent('oauth_link_identity_in_use', { userId: user.id, linkedUserId: linked.id });
        throw new GoogleAuthError('google_account_in_use');
      }
      if (await oauthRepo.findProviderLinkForUser(db, user.id, PROVIDER)) {
        throw new GoogleAuthError('already_linked');
      }
      if (user.email.toLowerCase() !== identity.email) throw new GoogleAuthError('email_mismatch');

      await oauthRepo.linkProvider(db, { userId: user.id, provider: PROVIDER, providerUserId: identity.sub });
      await oauthRepo.updateProfileFromProvider(db, user.id, { fullName: identity.name, avatarUrl: identity.picture });
      return { user, alreadyLinked: false };
    });
  } catch (err) {
    if (err && err.code === UNIQUE_VIOLATION) throw new GoogleAuthError('google_account_in_use');
    throw err;
  }
}

module.exports = { signInWithGoogle, linkGoogleAccount };
