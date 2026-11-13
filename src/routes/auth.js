const express = require('express');
const { createAccount, verifyEmail, login, loginWithGoogle } = require('../services/accounts');
const { BadRequestError } = require('../utils/errors');
const { config } = require('../config');

const authRouter = express.Router();

authRouter.get('/config', (req, res) => {
  res.json({
    googleClientId: config.googleClientId || '',
  });
});

authRouter.post('/signup', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new BadRequestError('missing_fields', 'Email and password required');

    const { account, verificationToken } = await createAccount(email, password);

    // Auto-verify email immediately (no real email system in this environment)
    await verifyEmail(verificationToken);

    res.status(201).json({
      message: 'Account created successfully.',
      account: { id: account.id, email: account.email },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/verify', async (req, res, next) => {
  try {
    const token = req.query.token;
    if (!token) throw new BadRequestError('missing_token', 'Verification token required');
    const account = await verifyEmail(token);
    res.json({ message: 'Email verified successfully', account });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new BadRequestError('missing_fields', 'Email and password required');
    const result = await login(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/google', async (req, res, next) => {
  try {
    const { credential, email, name, googleId } = req.body;
    const manualProfile = email ? { email, name, googleId } : null;
    const result = await loginWithGoogle(credential, manualProfile);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = { authRouter };

