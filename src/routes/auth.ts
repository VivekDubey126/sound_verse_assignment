import { Router, Request, Response, NextFunction } from 'express';
import { createAccount, verifyEmail, login } from '../services/accounts';
import { BadRequestError } from '../utils/errors';

export const authRouter = Router();

authRouter.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new BadRequestError('missing_fields', 'Email and password are required');
    }

    const { account, verificationToken } = await createAccount(email, password);
    const verifyUrl = `${req.protocol}://${req.get('host')}/auth/verify?token=${verificationToken}`;

    // Requirement: A link printed to the server log is fine
    console.log(`\n======================================================`);
    console.log(`✉️  EMAIL VERIFICATION LINK FOR [${email}]:`);
    console.log(`👉 ${verifyUrl}`);
    console.log(`======================================================\n`);

    res.status(201).json({
      message: 'Account created. Please verify your email using the link sent/logged.',
      account: {
        id: account.id,
        email: account.email,
        plan: account.plan_name,
        email_verified: Boolean(account.email_verified),
      },
      verification_link: verifyUrl,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      throw new BadRequestError('missing_token', 'Verification token is required');
    }

    const account = await verifyEmail(token);
    res.json({
      message: 'Email successfully verified. You can now log in and create API keys.',
      account: {
        id: account.id,
        email: account.email,
        email_verified: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new BadRequestError('missing_fields', 'Email and password are required');
    }

    const { token, account } = await login(email, password);
    res.json({
      token,
      account: {
        id: account.id,
        email: account.email,
        plan: account.plan_name,
        email_verified: Boolean(account.email_verified),
      },
    });
  } catch (err) {
    next(err);
  }
});

