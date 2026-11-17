require('dotenv').config();

const express = require('express');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Risen Logins';
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_NAME = process.env.DATABASE_NAME;
const JWT_SECRET = process.env.JWT_SECRET;
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
const mailer = gmailUser && gmailAppPassword
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
            { projection: { email: 1, authVersion: 1 } }
        );
        if (!user || (user.authVersion || 0) !== (payload.ver || 0)) {
            clearAuthCookie(res);
            return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
        }
        req.authenticatedEmail = user.email;
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
            resetAttempts: 0,
            createdAt: new Date()
        };
        const result = await getUsers().insertOne(user);
        user._id = result.insertedId;

        setAuthCookie(res, user);
        return res.status(201).json({ message: 'User registered successfully!', email: user.email });
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
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        setAuthCookie(res, user);
        return res.json({ message: 'Login successful!', email: user.email });
    } catch (error) {
        console.error('Login failed:', error);
        return res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/me', requireAuth, (req, res) => {
    return res.json({ email: req.authenticatedEmail });
});

app.post('/logout', (req, res) => {
    clearAuthCookie(res);
    return res.json({ message: 'Signed out successfully.' });
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
                    resetRequestedAt: ''
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
