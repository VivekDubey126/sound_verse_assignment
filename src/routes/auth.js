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
    const verifyUrl = `${req.protocol}://${req.get('host')}/auth/verify?token=${verificationToken}`;

    console.log(`\n======================================================`);
    console.log(`✉️  EMAIL VERIFICATION LINK FOR [${email}]:`);
    console.log(`👉 ${verifyUrl}`);
    console.log(`======================================================\n`);

    res.status(201).json({
      message: 'Account created. Please verify your email using the link sent/logged.',
      account: { id: account.id, email: account.email, plan: account.plan_name },
      verification_link: verifyUrl,
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

