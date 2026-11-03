const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json()); // Allows us to read JSON data from the frontend
app.use(cors()); // Allows your frontend to talk to your backend
app.use(express.static(__dirname)); // Serves your HTML, CSS, and JS files

// Set up the Database (it will create a file called database.db)
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the SQLite database.');
});

// Create the users table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT
)`);

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

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});