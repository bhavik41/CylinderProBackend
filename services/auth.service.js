const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const HttpError = require('../utils/HttpError');

const JWT_SECRET = process.env.JWT_SECRET || 'cylinderpro_jwt_2024';
const JWT_EXPIRY = '24h'; // max session length
const sign = (user) => jwt.sign(
  { id: user._id, name: user.name, email: user.email, tv: user.token_version || 0 },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRY }
);

async function signup({ name, email, password }) {
  if (!name || !email || !password) {
    throw new HttpError(400, 'Name, email and password are required');
  }
  if (password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters');
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new HttpError(400, 'Email is already registered');
  }

  const user = new User({ name, email, password });
  await user.save();

  return { token: sign(user), name: user.name, email: user.email };
}

async function signin({ email, password }) {
  if (!email || !password) {
    throw new HttpError(400, 'Email and password are required');
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await user.comparePassword(password))) {
    throw new HttpError(401, 'Invalid email or password');
  }

  user.last_login = new Date();
  await user.save();

  return { token: sign(user), name: user.name, email: user.email };
}

async function refresh(userId) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, 'Account no longer exists.');
  return { token: sign(user), name: user.name, email: user.email };
}

async function clearData(userId, password) {
  if (!password) throw new HttpError(400, 'Password is required to confirm');

  const user = await User.findById(userId);
  if (!user || !(await user.comparePassword(password))) {
    throw new HttpError(401, 'Incorrect password');
  }

  await Promise.all([
    Customer.deleteMany({ user_id: userId }),
    Bill.deleteMany({ user_id: userId }),
    Payment.deleteMany({ user_id: userId })
  ]);

  return { message: 'All data cleared successfully' };
}

module.exports = { signup, signin, refresh, clearData };
