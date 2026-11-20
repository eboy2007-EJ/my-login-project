require('dotenv').config();

const express = require('express');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Risen Logins';
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_NAME = process.env.DATABASE_NAME;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const googleSignInEnabled = Boolean(
    GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI &&
    !GOOGLE_CLIENT_ID.startsWith('your-') &&
    !GOOGLE_CLIENT_SECRET.startsWith('your-') &&
    !GOOGLE_REDIRECT_URI.includes('your-domain.example')
);
const googleOAuth = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
const AUTH_COOKIE = 'auth_token';
const AUTH_TTL_MS = 60 * 60 * 1000;
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const RESET_RESPONSE_MESSAGE = 'If an account exists for that email, a reset code has been sent.';
const INVALID_RESET_MESSAGE = 'The reset code is invalid or expired. Request a new code and try again.';

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(__dirname));

let users;

const gmailUser = process.env.GMAIL_USER;
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
const supportEmail = process.env.SUPPORT_EMAIL;
const mailer = gmailUser && gmailAppPassword &&
    !gmailUser.startsWith('your-') &&
    !gmailAppPassword.startsWith('your-')
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: gmailUser,
            pass: gmailAppPassword.replace(/\s/g, '')
        }
    })
    : null;

function validateEnvironment() {
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL must be set to connect to MongoDB.');
    }
    if (!JWT_SECRET ||
        Buffer.byteLength(JWT_SECRET, 'utf8') < 32 ||
        JWT_SECRET.startsWith('replace-with-')) {
        throw new Error('JWT_SECRET must be set to a random secret of at least 32 bytes.');
    }
}

function getDatabaseName() {
    if (DATABASE_NAME) return DATABASE_NAME;
    const databasePath = new URL(DATABASE_URL).pathname.replace(/^\/+/, '');
    return databasePath ? decodeURIComponent(databasePath.split('/')[0]) : 'login_project';
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { email, emailLower: email.toLowerCase() };
}

function getUsers() {
    if (!users) throw new Error('MongoDB is not connected.');
    return users;
}

function setAuthCookie(res, user) {
    const token = jwt.sign(
        { sub: user._id.toString(), ver: user.authVersion || 0 },
        JWT_SECRET,
        { expiresIn: AUTH_TTL_MS / 1000 }
    );

    res.cookie(AUTH_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
        sameSite: 'lax',
        maxAge: AUTH_TTL_MS,
        path: '/'
    });
}

function clearAuthCookie(res) {
    res.clearCookie(AUTH_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
        sameSite: 'lax',
        path: '/'
    });
}

async function requireAuth(req, res, next) {
    const token = req.cookies[AUTH_COOKIE];
    if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
        if (typeof payload.sub !== 'string' || !ObjectId.isValid(payload.sub)) {
            throw new Error('Invalid authentication subject.');
        }
    } catch (error) {
        clearAuthCookie(res);
        return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
    }

    try {
        const user = await getUsers().findOne(
            { _id: new ObjectId(payload.sub) },
            { projection: { email: 1, authVersion: 1, password: 1, twoFactorEnabled: 1 } }
        );
        if (!user || (user.authVersion || 0) !== (payload.ver || 0)) {
            clearAuthCookie(res);
            return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
        }
        req.authenticatedEmail = user.email;
        req.authenticatedUser = user;
        return next();
    } catch (error) {
        console.error('Could not validate sign-in:', error);
        return res.status(500).json({ error: 'Unable to validate your sign-in.' });
    }
}

function recordResetAttempt(user) {
    return getUsers().updateOne(
        {
            _id: user._id,
            resetCodeHash: user.resetCodeHash,
            resetExpiresAt: { $gt: Date.now() },
            resetAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
        },
        { $inc: { resetAttempts: 1 } }
    );
}

app.post('/register', async (req, res) => {
    const account = normalizeEmail(req.body && req.body.email);
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';

    if (!account) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
        return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 bytes.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const user = {
            email: account.email,
            emailLower: account.emailLower,
            password: passwordHash,
            authVersion: 0,
            twoFactorEnabled: false,
            resetAttempts: 0,
            createdAt: new Date()
        };
        const result = await getUsers().insertOne(user);
        user._id = result.insertedId;

        setAuthCookie(res, user);
        return res.status(201).json({
            message: 'User registered successfully!',
            email: user.email,
            twoStepEnabled: false,
            hasPassword: true
        });
    } catch (error) {
        if (error.code === 11000) return res.status(400).json({ error: 'Email already exists!' });
        console.error('Registration failed:', error);
        return res.status(500).json({ error: 'Server error.' });
    }
});

app.post('/login', async (req, res) => {
    const account = normalizeEmail(req.body && req.body.email);
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!account || !password) return res.status(401).json({ error: 'Invalid email or password.' });

    try {
        const user = await getUsers().findOne({ emailLower: account.emailLower });
        if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        if (user.twoFactorEnabled) {
            if (!mailer) {
                return res.status(503).json({ error: 'Email two-step verification is not configured on the server.' });
            }

            const now = Date.now();
            if (user.loginCodeRequestedAt && user.loginCodeRequestedAt > now - RESET_REQUEST_COOLDOWN_MS) {
                return res.status(429).json({ error: 'A sign-in code was recently sent. Check your email and try again shortly.' });
            }

            const code = String(crypto.randomInt(100000, 1000000));
            const codeHash = await bcrypt.hash(code, 10);
            const update = await getUsers().updateOne(
                {
                    _id: user._id,
                    twoFactorEnabled: true,
                    $or: [
                        { loginCodeRequestedAt: { $exists: false } },
                        { loginCodeRequestedAt: null },
                        { loginCodeRequestedAt: { $lte: now - RESET_REQUEST_COOLDOWN_MS } }
                    ]
                },
                {
                    $set: {
                        loginCodeHash: codeHash,
                        loginCodeExpiresAt: now + RESET_CODE_TTL_MS,
                        loginCodeRequestedAt: now,
                        loginCodeAttempts: 0
                    }
                }
            );
            if (update.matchedCount !== 1) {
                return res.status(429).json({ error: 'A sign-in code was recently sent. Check your email and try again shortly.' });
            }

            try {
                await mailer.sendMail({
                    from: gmailUser,
                    to: user.email,
                    subject: `${APP_NAME} sign-in verification code`,
                    text: `Your sign-in verification code is ${code}. It expires in 10 minutes. If you did not try to sign in, you can ignore this email.`
                });
            } catch (mailError) {
                console.error('Could not send sign-in verification email:', mailError);
                await getUsers().updateOne(
                    { _id: user._id, loginCodeHash: codeHash },
                    {
                        $unset: { loginCodeHash: '', loginCodeExpiresAt: '', loginCodeRequestedAt: '' },
                        $set: { loginCodeAttempts: 0 }
                    }
                );
                return res.status(503).json({ error: 'Could not send the sign-in code. Please try again later.' });
            }

            return res.status(202).json({ twoFactorRequired: true });
        }

        setAuthCookie(res, user);
        return res.json({
            message: 'Login successful!',
            email: user.email,
            twoStepEnabled: false,
            hasPassword: true
        });
    } catch (error) {
        console.error('Login failed:', error);
        return res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/me', requireAuth, (req, res) => {
    return res.json({
        email: req.authenticatedEmail,
        twoStepEnabled: Boolean(req.authenticatedUser.twoFactorEnabled),
        hasPassword: Boolean(req.authenticatedUser.password)
    });
});

app.post('/security/two-step/request', requireAuth, async (req, res) => {
    const user = req.authenticatedUser;
    if (!user.password) {
        return res.status(400).json({ error: 'This account uses Google sign-in. Manage its verification through Google.' });
    }
    if (user.twoFactorEnabled) {
        return res.status(400).json({ error: 'Email two-step verification is already enabled.' });
    }
    if (!mailer) {
        return res.status(503).json({ error: 'Email verification is not configured on the server.' });
    }

    try {
        const now = Date.now();
        if (user.twoStepSetupRequestedAt && user.twoStepSetupRequestedAt > now - RESET_REQUEST_COOLDOWN_MS) {
            return res.status(429).json({ error: 'A verification code was recently sent. Check your email and try again shortly.' });
        }

        const code = String(crypto.randomInt(100000, 1000000));
        const codeHash = await bcrypt.hash(code, 10);
        const update = await getUsers().updateOne(
            {
                _id: user._id,
                $or: [
                    { twoStepSetupRequestedAt: { $exists: false } },
                    { twoStepSetupRequestedAt: null },
                    { twoStepSetupRequestedAt: { $lte: now - RESET_REQUEST_COOLDOWN_MS } }
                ]
            },
            {
                $set: {
                    twoStepSetupCodeHash: codeHash,
                    twoStepSetupExpiresAt: now + RESET_CODE_TTL_MS,
                    twoStepSetupRequestedAt: now,
                    twoStepSetupAttempts: 0
                }
            }
        );
        if (update.matchedCount !== 1) {
            return res.status(429).json({ error: 'A verification code was recently sent. Check your email and try again shortly.' });
        }

        try {
            await mailer.sendMail({
                from: gmailUser,
                to: user.email,
                subject: `${APP_NAME} two-step verification`,
                text: `Your email verification setup code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`
            });
        } catch (mailError) {
            console.error('Could not send two-step setup code:', mailError);
            await getUsers().updateOne(
                { _id: user._id, twoStepSetupCodeHash: codeHash },
                {
                    $unset: {
                        twoStepSetupCodeHash: '',
                        twoStepSetupExpiresAt: '',
                        twoStepSetupRequestedAt: ''
                    },
                    $set: { twoStepSetupAttempts: 0 }
                }
            );
            return res.status(503).json({ error: 'Could not send the verification code. Please try again later.' });
        }

        return res.json({ message: 'A verification code was sent to your registered email.' });
    } catch (error) {
        console.error('Could not request two-step setup code:', error);
        return res.status(500).json({ error: 'Unable to request a verification code.' });
    }
});

app.post('/security/two-step/confirm', requireAuth, async (req, res) => {
    const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'The verification code is incorrect or expired.' });
    }

    try {
        const user = await getUsers().findOne({
            _id: req.authenticatedUser._id,
            twoStepSetupCodeHash: { $type: 'string' },
            twoStepSetupExpiresAt: { $gt: Date.now() },
            twoStepSetupAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
        });
        if (!user || !(await bcrypt.compare(code, user.twoStepSetupCodeHash))) {
            if (user) {
                await getUsers().updateOne(
                    {
                        _id: user._id,
                        twoStepSetupCodeHash: user.twoStepSetupCodeHash,
                        twoStepSetupExpiresAt: { $gt: Date.now() },
                        twoStepSetupAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
                    },
                    { $inc: { twoStepSetupAttempts: 1 } }
                );
            }
            return res.status(400).json({ error: 'The verification code is incorrect or expired.' });
        }

        const update = await getUsers().updateOne(
            {
                _id: user._id,
                twoStepSetupCodeHash: user.twoStepSetupCodeHash,
                twoStepSetupExpiresAt: { $gt: Date.now() },
                twoStepSetupAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
            },
            {
                $set: { twoFactorEnabled: true, twoStepSetupAttempts: 0 },
                $unset: {
                    twoStepSetupCodeHash: '',
                    twoStepSetupExpiresAt: '',
                    twoStepSetupRequestedAt: ''
                }
            }
        );
        if (update.matchedCount !== 1) {
            return res.status(400).json({ error: 'The verification code is incorrect or expired.' });
        }
        return res.json({ message: 'Email two-step verification is enabled.' });
    } catch (error) {
        console.error('Could not confirm two-step setup code:', error);
        return res.status(500).json({ error: 'Unable to enable two-step verification.' });
    }
});

app.post('/security/two-step/disable', requireAuth, async (req, res) => {
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    try {
        if (!req.authenticatedUser.password ||
            !(await bcrypt.compare(password, req.authenticatedUser.password))) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }
    } catch (error) {
        console.error('Could not verify password to disable two-step verification:', error);
        return res.status(500).json({ error: 'Unable to verify the current password.' });
    }

    try {
        const update = await getUsers().updateOne(
            { _id: req.authenticatedUser._id, twoFactorEnabled: true },
            {
                $set: { twoFactorEnabled: false },
                $unset: {
                    loginCodeHash: '',
                    loginCodeExpiresAt: '',
                    loginCodeRequestedAt: '',
                    loginCodeAttempts: '',
                    twoStepSetupCodeHash: '',
                    twoStepSetupExpiresAt: '',
                    twoStepSetupRequestedAt: '',
                    twoStepSetupAttempts: ''
                }
            }
        );
        if (update.matchedCount !== 1) {
            return res.status(400).json({ error: 'Email two-step verification is already disabled.' });
        }
        return res.json({ message: 'Email two-step verification is disabled.' });
    } catch (error) {
        console.error('Could not disable two-step verification:', error);
        return res.status(500).json({ error: 'Unable to turn off two-step verification.' });
    }
});

app.post('/logout', (req, res) => {
    clearAuthCookie(res);
    return res.json({ message: 'Signed out successfully.' });
});

app.get('/auth/google/config', (req, res) => {
    return res.json({ enabled: googleSignInEnabled });
});

app.get('/auth/google', (req, res) => {
    if (!googleSignInEnabled) return res.redirect('/?authNotice=googleUnavailable');

    const state = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    res.cookie('google_oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000,
        path: '/auth/google/callback'
    });
    res.cookie('google_oauth_nonce', nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000,
        path: '/auth/google/callback'
    });

    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.search = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce
    }).toString();
    const loginHint = normalizeEmail(req.query.login_hint);
    if (loginHint) authorizationUrl.searchParams.set('login_hint', loginHint.email);
    return res.redirect(authorizationUrl.toString());
});

app.get('/auth/google/callback', async (req, res) => {
    const expectedState = req.cookies.google_oauth_state;
    const expectedNonce = req.cookies.google_oauth_nonce;
    const clearOAuthCookie = (name) => res.clearCookie(name, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
        sameSite: 'lax',
        path: '/auth/google/callback'
    });
    clearOAuthCookie('google_oauth_state');
    clearOAuthCookie('google_oauth_nonce');

    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!googleSignInEnabled || !expectedState || !expectedNonce || !returnedState ||
        expectedState.length !== returnedState.length ||
        !crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(returnedState)) ||
        typeof req.query.code !== 'string') {
        return res.redirect('/?authNotice=googleFailed');
    }

    try {
        const { tokens } = await googleOAuth.getToken({
            code: req.query.code,
            redirect_uri: GOOGLE_REDIRECT_URI
        });
        if (!tokens.id_token) return res.redirect('/?authNotice=googleFailed');

        const ticket = await googleOAuth.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID
        });
        const identity = ticket.getPayload();
        if (!identity || typeof identity.sub !== 'string' ||
            typeof identity.email !== 'string' || identity.email_verified !== true ||
            identity.nonce !== expectedNonce) {
            return res.redirect('/?authNotice=googleEmail');
        }

        const account = normalizeEmail(identity.email);
        if (!account) return res.redirect('/?authNotice=googleEmail');

        let user = await getUsers().findOne({ googleSub: identity.sub });
        if (!user) {
            user = await getUsers().findOne({ emailLower: account.emailLower });
            if (user && user.googleSub && user.googleSub !== identity.sub) {
                return res.redirect('/?authNotice=googleFailed');
            }
            if (user) {
                const linkResult = await getUsers().updateOne(
                    { _id: user._id, $or: [{ googleSub: { $exists: false } }, { googleSub: identity.sub }] },
                    { $set: { googleSub: identity.sub } }
                );
                if (linkResult.matchedCount !== 1) {
                    return res.redirect('/?authNotice=googleFailed');
                }
                user.googleSub = identity.sub;
            } else {
                const newUser = {
                    email: account.email,
                    emailLower: account.emailLower,
                    googleSub: identity.sub,
                    authVersion: 0,
                    twoFactorEnabled: false,
                    resetAttempts: 0,
                    createdAt: new Date()
                };
                const result = await getUsers().insertOne(newUser);
                newUser._id = result.insertedId;
                user = newUser;
            }
        }

        if (user.twoFactorEnabled) {
            return res.redirect('/?authNotice=googleTwoStep');
        }

        setAuthCookie(res, user);
        return res.redirect('/');
    } catch (error) {
        if (error.code !== 11000) console.error('Google sign-in failed:', error);
        return res.redirect('/?authNotice=googleFailed');
    }
});

app.post('/verify-login-code', async (req, res) => {
    const account = normalizeEmail(req.body && req.body.email);
    const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
    if (!account || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'The verification code is incorrect or expired.' });
    }

    try {
        const user = await getUsers().findOne({
            emailLower: account.emailLower,
            twoFactorEnabled: true,
            loginCodeHash: { $type: 'string' },
            loginCodeExpiresAt: { $gt: Date.now() },
            loginCodeAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
        });
        if (!user || !(await bcrypt.compare(code, user.loginCodeHash))) {
            if (user) {
                await getUsers().updateOne(
                    {
                        _id: user._id,
                        loginCodeHash: user.loginCodeHash,
                        loginCodeExpiresAt: { $gt: Date.now() },
                        loginCodeAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
                    },
                    { $inc: { loginCodeAttempts: 1 } }
                );
            }
            return res.status(400).json({ error: 'The verification code is incorrect or expired.' });
        }

        const update = await getUsers().updateOne(
            {
                _id: user._id,
                loginCodeHash: user.loginCodeHash,
                loginCodeExpiresAt: { $gt: Date.now() },
                loginCodeAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
            },
            {
                $unset: { loginCodeHash: '', loginCodeExpiresAt: '', loginCodeRequestedAt: '' },
                $set: { loginCodeAttempts: 0 }
            }
        );
        if (update.matchedCount !== 1) {
            return res.status(400).json({ error: 'The verification code is incorrect or expired.' });
        }

        setAuthCookie(res, user);
        return res.json({
            message: 'Login successful!',
            email: user.email,
            twoStepEnabled: true,
            hasPassword: true
        });
    } catch (error) {
        console.error('Could not verify sign-in code:', error);
        return res.status(500).json({ error: 'Unable to verify the sign-in code.' });
    }
});

app.post('/forgot-password', async (req, res) => {
    const account = normalizeEmail(req.body && req.body.email);
    if (!account) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!mailer) {
        return res.status(503).json({ error: 'Password reset email is not configured on the server.' });
    }

    try {
        const user = await getUsers().findOne({ emailLower: account.emailLower });
        if (!user) return res.json({ message: RESET_RESPONSE_MESSAGE });

        const now = Date.now();
        const code = String(crypto.randomInt(100000, 1000000));
        const codeHash = await bcrypt.hash(code, 10);
        const update = await getUsers().updateOne(
            {
                _id: user._id,
                $or: [
                    { resetRequestedAt: { $exists: false } },
                    { resetRequestedAt: null },
                    { resetRequestedAt: { $lte: now - RESET_REQUEST_COOLDOWN_MS } }
                ]
            },
            {
                $set: {
                    resetCodeHash: codeHash,
                    resetExpiresAt: now + RESET_CODE_TTL_MS,
                    resetRequestedAt: now,
                    resetAttempts: 0
                }
            }
        );
        if (update.matchedCount === 0) return res.json({ message: RESET_RESPONSE_MESSAGE });

        try {
            const supportMessage = supportEmail ? ` For help, contact ${supportEmail}.` : '';
            await mailer.sendMail({
                from: gmailUser,
                to: user.email,
                subject: `${APP_NAME} password reset code`,
                text: `Your password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.${supportMessage}`
            });
            return res.json({ message: RESET_RESPONSE_MESSAGE });
        } catch (mailError) {
            console.error('Could not send password reset email:', mailError);
            await getUsers().updateOne(
                { _id: user._id, resetCodeHash: codeHash },
                {
                    $unset: {
                        resetCodeHash: '',
                        resetExpiresAt: '',
                        resetRequestedAt: ''
                    },
                    $set: { resetAttempts: 0 }
                }
            );
            return res.status(503).json({ error: 'Could not send the reset email. Please try again later.' });
        }
    } catch (error) {
        console.error('Could not prepare password reset email:', error);
        return res.status(500).json({ error: 'Unable to process the password reset request.' });
    }
});

app.post('/verify-reset-code', async (req, res) => {
    const account = normalizeEmail(req.body && req.body.email);
    const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
    if (!account || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Code incorrect.' });
    }

    try {
        const user = await getUsers().findOne({
            emailLower: account.emailLower,
            resetCodeHash: { $type: 'string' },
            resetExpiresAt: { $gt: Date.now() },
            resetAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
        });
        if (!user || !(await bcrypt.compare(code, user.resetCodeHash))) {
            if (user) await recordResetAttempt(user);
            return res.status(400).json({ error: 'Code incorrect.' });
        }

        return res.json({ message: 'Reset code confirmed.' });
    } catch (error) {
        console.error('Could not verify password reset code:', error);
        return res.status(500).json({ error: 'Unable to verify the code.' });
    }
});

app.post('/reset-password', async (req, res) => {
    const account = normalizeEmail(req.body && req.body.email);
    const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
    const newPassword = req.body && typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

    if (!account || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: INVALID_RESET_MESSAGE });
    }
    if (newPassword.length < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) {
        return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 bytes.' });
    }

    try {
        const user = await getUsers().findOne({
            emailLower: account.emailLower,
            resetCodeHash: { $type: 'string' },
            resetExpiresAt: { $gt: Date.now() },
            resetAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
        });
        if (!user) return res.status(400).json({ error: INVALID_RESET_MESSAGE });

        if (!(await bcrypt.compare(code, user.resetCodeHash))) {
            await recordResetAttempt(user);
            return res.status(400).json({ error: INVALID_RESET_MESSAGE });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        const update = await getUsers().updateOne(
            {
                _id: user._id,
                resetCodeHash: user.resetCodeHash,
                resetExpiresAt: { $gt: Date.now() },
                resetAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS }
            },
            {
                $set: { password: passwordHash, resetAttempts: 0 },
                $inc: { authVersion: 1 },
                $unset: {
                    resetCodeHash: '',
                    resetExpiresAt: '',
                    resetRequestedAt: '',
                    loginCodeHash: '',
                    loginCodeExpiresAt: '',
                    loginCodeRequestedAt: '',
                    twoStepSetupCodeHash: '',
                    twoStepSetupExpiresAt: '',
                    twoStepSetupRequestedAt: ''
                }
            }
        );
        if (update.matchedCount !== 1) {
            return res.status(400).json({ error: INVALID_RESET_MESSAGE });
        }
        return res.json({ message: 'Password reset successfully. You can now log in.' });
    } catch (error) {
        console.error('Could not verify or update password reset:', error);
        return res.status(500).json({ error: 'Unable to reset the password.' });
    }
});

async function start() {
    validateEnvironment();

    const client = new MongoClient(DATABASE_URL);
    try {
        await client.connect();
        users = client.db(getDatabaseName()).collection('users');
        await users.createIndex({ emailLower: 1 }, { unique: true });
        await users.createIndex({ googleSub: 1 }, { unique: true, sparse: true });
    } catch (error) {
        users = undefined;
        try {
            await client.close();
        } catch (closeError) {
            console.error('Could not close the MongoDB client after startup failure:', closeError);
        }
        throw error;
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`${APP_NAME} server running on port ${PORT}.`);
    });
}

if (require.main === module) {
    start().catch((error) => {
        console.error('Server startup failed:', error);
        process.exitCode = 1;
    });
}

module.exports = { app, start };
