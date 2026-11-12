const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const RESET_RESPONSE_MESSAGE = 'If an account exists for that email, a reset code has been sent.';
const INVALID_RESET_MESSAGE = 'The reset code is invalid or expired. Request a new code and try again.';

// Middleware
app.use(express.json()); // Allows us to read JSON data from the frontend
app.use(cors()); // Allows your frontend to talk to your backend
app.use(express.static(__dirname)); // Serves your HTML, CSS, and JS files

const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the SQLite database.');
});

const gmailUser = process.env.GMAIL_USER;
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
const mailer = gmailUser && gmailAppPassword
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: gmailUser,
            pass: gmailAppPassword.replace(/\s/g, '')
        }
    })
    : null;

function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            password TEXT,
            password_reset_hash TEXT,
            password_reset_expires_at INTEGER,
            password_reset_requested_at INTEGER,
            password_reset_attempts INTEGER NOT NULL DEFAULT 0
        )`, (createError) => {
            if (createError) return reject(createError);

            db.all('PRAGMA table_info(users)', (columnsError, columns) => {
                if (columnsError) return reject(columnsError);
                const existingColumns = new Set(columns.map((column) => column.name));
                const missingColumns = [
                    ['password_reset_hash', 'TEXT'],
                    ['password_reset_expires_at', 'INTEGER'],
                    ['password_reset_requested_at', 'INTEGER'],
                    ['password_reset_attempts', 'INTEGER NOT NULL DEFAULT 0']
                ].filter(([name]) => !existingColumns.has(name));

                const addMissingColumn = (index) => {
                    if (index === missingColumns.length) return resolve();
                    const [name, definition] = missingColumns[index];
                    db.run(`ALTER TABLE users ADD COLUMN ${name} ${definition}`, (alterError) => {
                        if (alterError) return reject(alterError);
                        addMissingColumn(index + 1);
                    });
                };

                addMissingColumn(0);
            });
        });
    });
}

// --- ROUTES ---

// 1. Registration Route
app.post('/register', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Hash the password (make it unreadable) using bcrypt
        const hashedPassword = await bcrypt.hash(password, 10);

        // Save to database
        db.run(`INSERT INTO users (email, password) VALUES (?, ?)`, [email, hashedPassword], function(err) {
            if (err) {
                // If email already exists
                return res.status(400).json({ error: "Email already exists!" });
            }
            res.status(201).json({ message: "User registered successfully!" });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// 2. Login Route
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    // Find user by email
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: "Server error" });
        if (!user) return res.status(401).json({ error: "Invalid email or password" });

        // Compare the typed password with the hashed password in the database
        const match = await bcrypt.compare(password, user.password);
        
        if (match) {
            res.json({ message: "Login successful!" });
        } else {
            res.status(401).json({ error: "Invalid email or password" });
        }
    });
});

app.post('/forgot-password', async (req, res) => {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || email.length > 254) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!mailer) {
        return res.status(503).json({ error: 'Password reset email is not configured on the server.' });
    }

    db.get('SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)', [email], async (findError, user) => {
        if (findError) {
            console.error('Could not look up password reset account:', findError);
            return res.status(500).json({ error: 'Unable to process the password reset request.' });
        }
        if (!user) return res.json({ message: RESET_RESPONSE_MESSAGE });

        try {
            const code = String(crypto.randomInt(100000, 1000000));
            const codeHash = await bcrypt.hash(code, 10);
            const now = Date.now();

            db.run(
                `UPDATE users
                 SET password_reset_hash = ?,
                     password_reset_expires_at = ?,
                     password_reset_requested_at = ?,
                     password_reset_attempts = 0
                 WHERE id = ?
                   AND (password_reset_requested_at IS NULL OR password_reset_requested_at <= ?)`,
                [codeHash, now + RESET_CODE_TTL_MS, now, user.id, now - RESET_REQUEST_COOLDOWN_MS],
                async function (saveError) {
                    if (saveError) {
                        console.error('Could not save password reset code:', saveError);
                        return res.status(500).json({ error: 'Unable to process the password reset request.' });
                    }
                    if (this.changes === 0) return res.json({ message: RESET_RESPONSE_MESSAGE });

                    try {
                        await mailer.sendMail({
                            from: gmailUser,
                            to: user.email,
                            subject: 'Your password reset code',
                            text: `Your password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`
                        });
                        return res.json({ message: RESET_RESPONSE_MESSAGE });
                    } catch (mailError) {
                        console.error('Could not send password reset email:', mailError);
                        db.run(
                            `UPDATE users
                             SET password_reset_hash = NULL,
                                 password_reset_expires_at = NULL,
                                 password_reset_requested_at = NULL,
                                 password_reset_attempts = 0
                             WHERE id = ? AND password_reset_hash = ?`,
                            [user.id, codeHash],
                            (clearError) => {
                                if (clearError) console.error('Could not clear unsent password reset code:', clearError);
                            }
                        );
                        return res.status(503).json({ error: 'Could not send the reset email. Please try again later.' });
                    }
                }
            );
        } catch (error) {
            console.error('Could not prepare password reset email:', error);
            return res.status(500).json({ error: 'Unable to process the password reset request.' });
        }
    });
});

app.post('/reset-password', async (req, res) => {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!email || email.length > 254 || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: INVALID_RESET_MESSAGE });
    }
    if (newPassword.length < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) {
        return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 bytes.' });
    }

    db.get(
        `SELECT id, password_reset_hash, password_reset_expires_at, password_reset_attempts
         FROM users WHERE LOWER(email) = LOWER(?)`,
        [email],
        async (findError, user) => {
            if (findError) {
                console.error('Could not look up password reset code:', findError);
                return res.status(500).json({ error: 'Unable to reset the password.' });
            }
            if (!user || !user.password_reset_hash ||
                user.password_reset_expires_at <= Date.now() ||
                user.password_reset_attempts >= RESET_CODE_MAX_ATTEMPTS) {
                return res.status(400).json({ error: INVALID_RESET_MESSAGE });
            }

            try {
                const matches = await bcrypt.compare(code, user.password_reset_hash);
                if (!matches) {
                    db.run(
                        `UPDATE users SET password_reset_attempts = password_reset_attempts + 1
                         WHERE id = ? AND password_reset_hash = ?
                           AND password_reset_expires_at > ?
                           AND password_reset_attempts < ?`,
                        [user.id, user.password_reset_hash, Date.now(), RESET_CODE_MAX_ATTEMPTS],
                        (attemptError) => {
                            if (attemptError) {
                                console.error('Could not record password reset attempt:', attemptError);
                                return res.status(500).json({ error: 'Unable to reset the password.' });
                            }
                            return res.status(400).json({ error: INVALID_RESET_MESSAGE });
                        }
                    );
                    return;
                }

                const passwordHash = await bcrypt.hash(newPassword, 10);
                db.run(
                    `UPDATE users
                     SET password = ?,
                         password_reset_hash = NULL,
                         password_reset_expires_at = NULL,
                         password_reset_requested_at = NULL,
                         password_reset_attempts = 0
                     WHERE id = ? AND password_reset_hash = ?
                       AND password_reset_expires_at > ?
                       AND password_reset_attempts < ?`,
                    [passwordHash, user.id, user.password_reset_hash, Date.now(), RESET_CODE_MAX_ATTEMPTS],
                    function (updateError) {
                        if (updateError) {
                            console.error('Could not update password:', updateError);
                            return res.status(500).json({ error: 'Unable to reset the password.' });
                        }
                        if (this.changes !== 1) {
                            return res.status(400).json({ error: INVALID_RESET_MESSAGE });
                        }
                        return res.json({ message: 'Password reset successfully. You can now log in.' });
                    }
                );
            } catch (error) {
                console.error('Could not verify or update password reset:', error);
                return res.status(500).json({ error: 'Unable to reset the password.' });
            }
        }
    );
});

initializeDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}).catch((error) => {
    console.error('Database initialization failed:', error);
    db.close((closeError) => {
        if (closeError) console.error('Could not close the database:', closeError);
        process.exitCode = 1;
    });
});