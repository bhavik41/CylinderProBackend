const jwt = require('jsonwebtoken');
const User = require('../models/User');
const JWT_SECRET = process.env.JWT_SECRET || 'cylinderpro_jwt_2024';

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }
  let payload;
  try {
    payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'TOKEN_EXPIRED' });
  }
  try {
    // Validate the token against the user's current token_version (supports "log out all").
    const user = await User.findById(payload.id).select('token_version');
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.', code: 'NO_USER' });
    }
    if ((payload.tv || 0) !== (user.token_version || 0)) {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'TOKEN_REVOKED' });
    }
    req.user = payload;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authentication check failed.' });
  }
};
