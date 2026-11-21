const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const userRepo = require('../repositories/user.repository');
const env = require('../config/env');
const AppError = require('../utils/AppError');

// Verified against when the email is unknown so login timing does not reveal which accounts exist.
let dummyHashPromise = null;
const dummyHash = () => (dummyHashPromise ||= argon2.hash('documind-timing-equalizer'));

class AuthService {
  async hashPassword(password) {
    return await argon2.hash(password);
  }

  async verifyPassword(hash, password) {
    return await argon2.verify(hash, password);
  }

  generateTokens(user) {
    const accessToken = jwt.sign(
      { userId: user.id },
      env.JWT_ACCESS_SECRET,
      { expiresIn: env.JWT_ACCESS_EXPIRATION }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRATION }
    );

    return { accessToken, refreshToken };
  }

  async register(userData) {
    const { email, password, fullName } = userData;

    const existingUser = await userRepo.findByEmail(email);
    if (existingUser) {
      throw new AppError('Email already registered', 400);
    }

    const passwordHash = await this.hashPassword(password);
    return await userRepo.create({ email, passwordHash, fullName });
  }

  async login(email, password) {
    const user = await userRepo.findByEmail(email);
    if (!user) {
      await this.verifyPassword(await dummyHash(), password).catch(() => false);
      throw new AppError('Invalid credentials', 401);
    }

    const isValid = await this.verifyPassword(user.password_hash, password);
    if (!isValid || user.status !== 'active') {
      throw new AppError('Invalid credentials', 401);
    }

    return {
      user: { id: user.id, email: user.email, fullName: user.full_name },
      tokens: this.generateTokens(user),
    };
  }
}

module.exports = new AuthService();
