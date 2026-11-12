const { uuid } = require('../utils/crypto');

function requestIdMiddleware(req, res, next) {
  const id = req.headers['x-request-id'] || `req_${uuid().slice(0, 8)}`;
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = { requestIdMiddleware };

