require('dotenv').config();

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { MongoClient } = require('mongodb');

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_NAME = process.env.DATABASE_NAME;
const sqlitePath = path.join(__dirname, '..', 'database.db');

function getDatabaseName() {
    if (DATABASE_NAME) return DATABASE_NAME;
    const databasePath = new URL(DATABASE_URL).pathname.replace(/^\/+/, '');
    return databasePath ? decodeURIComponent(databasePath.split('/')[0]) : 'login_project';
}

function runSqlite(db, sql, parameters) {
    return new Promise((resolve, reject) => {
        db.all(sql, parameters || [], (error, rows) => {
            if (error) return reject(error);
            return resolve(rows);
        });
    });
}

function closeSqlite(db) {
    return new Promise((resolve, reject) => {
        db.close((error) => {
            if (error) return reject(error);
            return resolve();
        });
    });
}

function openSqliteReadOnly() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY, (error) => {
            if (error) return reject(error);
            return resolve(db);
        });
    });
}

async function readUsers() {
    if (!fs.existsSync(sqlitePath)) {
        throw new Error(`SQLite database not found at ${sqlitePath}.`);
    }

    const db = await openSqliteReadOnly();
    try {
        const columns = await runSqlite(db, 'PRAGMA table_info(users)');
        const columnNames = new Set(columns.map((column) => column.name));
        if (!columnNames.has('email') || !columnNames.has('password')) {
            throw new Error('The SQLite users table must contain email and password columns.');
        }

        const optionalColumns = [
            'password_reset_hash',
            'password_reset_expires_at',
            'password_reset_requested_at',
            'password_reset_attempts'
        ];
        const selectedColumns = ['email', 'password'].concat(
            optionalColumns.filter((column) => columnNames.has(column))
        );
        return await runSqlite(db, `SELECT ${selectedColumns.join(', ')} FROM users`);
    } finally {
        await closeSqlite(db);
    }
}

async function migrate() {
    if (!DATABASE_URL) throw new Error('Set DATABASE_URL before running the migration.');

    const rows = await readUsers();
    const seenEmails = new Set();
    const documents = rows.map((row) => {
        if (typeof row.email !== 'string' || typeof row.password !== 'string') {
            throw new Error('Found a SQLite account with a missing email or password hash.');
        }
        const emailLower = row.email.trim().toLowerCase();
        if (!emailLower) throw new Error('Found a SQLite account with an empty email.');
        if (seenEmails.has(emailLower)) {
            throw new Error('Multiple SQLite accounts use addresses that differ only by letter case.');
        }
        seenEmails.add(emailLower);

        const user = {
            email: row.email.trim(),
            emailLower,
            password: row.password,
            authVersion: 0,
            twoFactorEnabled: false,
            resetAttempts: row.password_reset_attempts || 0
        };
        if (row.password_reset_hash) user.resetCodeHash = row.password_reset_hash;
        if (row.password_reset_expires_at) user.resetExpiresAt = row.password_reset_expires_at;
        if (row.password_reset_requested_at) user.resetRequestedAt = row.password_reset_requested_at;
        return user;
    });

    const client = new MongoClient(DATABASE_URL);
    try {
        await client.connect();
        const collection = client.db(getDatabaseName()).collection('users');
        await collection.createIndex({ emailLower: 1 }, { unique: true });
        await collection.createIndex({ googleSub: 1 }, { unique: true, sparse: true });

        if (documents.length === 0) {
            console.log('No SQLite accounts found. Nothing to migrate.');
            return;
        }

        const result = await collection.bulkWrite(
            documents.map((user) => ({
                updateOne: {
                    filter: { emailLower: user.emailLower },
                    update: { $setOnInsert: user },
                    upsert: true
                }
            }))
        );
        console.log(`Migrated ${result.upsertedCount} account(s); left ${documents.length - result.upsertedCount} existing MongoDB account(s) unchanged.`);
    } finally {
        await client.close();
    }
}

migrate().catch((error) => {
    console.error('SQLite-to-MongoDB migration failed:', error);
    process.exitCode = 1;
});
