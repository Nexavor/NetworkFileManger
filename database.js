// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
require('dotenv').config();

const dbPath = path.join(__dirname, 'data', 'database.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("致命错误：连接资料库失败！", err.message);
        return;
    }
    createTables();
});

function createTables() {
    db.serialize(() => {
        // 1. Users 表：增加 max_storage_bytes
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            max_storage_bytes INTEGER DEFAULT 1073741824 
        )`, (err) => {
            if (err) return;
            // 检查并添加列（如果不存在）
            db.all("PRAGMA table_info(users)", (e, cols) => {
                if (!cols.some(c => c.name === 'max_storage_bytes')) {
                    db.run("ALTER TABLE users ADD COLUMN max_storage_bytes INTEGER DEFAULT 1073741824"); // 默认为 1GB
                }
            });
            createDependentTables();
        });
    });
}

function createDependentTables() {
    db.serialize(() => {
        // 2. Folders 表：增加软删除字段
        db.run(`CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            user_id INTEGER NOT NULL,
            share_token TEXT,
            share_expires_at INTEGER,
            password TEXT,
            share_password TEXT,
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            UNIQUE(name, parent_id, user_id)
        )`, (err) => {
            if (err) return;
            db.all("PRAGMA table_info(folders)", (e, cols) => {
                if (!cols.some(c => c.name === 'share_password')) db.run("ALTER TABLE folders ADD COLUMN share_password TEXT");
                if (!cols.some(c => c.name === 'is_deleted')) db.run("ALTER TABLE folders ADD COLUMN is_deleted INTEGER DEFAULT 0");
                if (!cols.some(c => c.name === 'deleted_at')) db.run("ALTER TABLE folders ADD COLUMN deleted_at INTEGER");
                createFilesTable();
            });
        });
    });
}

function createFilesTable() {
    db.serialize(() => {
        // 3. Files 表：增加软删除字段
        db.run(`CREATE TABLE IF NOT EXISTS files (
            message_id INTEGER PRIMARY KEY,
            fileName TEXT NOT NULL,
            mimetype TEXT,
            file_id TEXT NOT NULL,
            thumb_file_id TEXT,
            size INTEGER,
            date INTEGER NOT NULL,
            share_token TEXT,
            share_expires_at INTEGER,
            share_password TEXT,
            folder_id INTEGER NOT NULL DEFAULT 1,
            user_id INTEGER NOT NULL,
            storage_type TEXT NOT NULL DEFAULT 'telegram',
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            UNIQUE(fileName, folder_id, user_id),
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )`, (err) => {
            if (err) return;
            db.all("PRAGMA table_info(files)", (e, cols) => {
                if (!cols.some(c => c.name === 'share_password')) db.run("ALTER TABLE files ADD COLUMN share_password TEXT");
                if (!cols.some(c => c.name === 'is_deleted')) db.run("ALTER TABLE files ADD COLUMN is_deleted INTEGER DEFAULT 0");
                if (!cols.some(c => c.name === 'deleted_at')) db.run("ALTER TABLE files ADD COLUMN deleted_at INTEGER");
                createAuthTokenTable();
            });
        });
    });
}

function createAuthTokenTable() {
    db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`, (err) => {
        checkAndCreateAdmin();
    });
}

function checkAndCreateAdmin() {
    db.get("SELECT * FROM users WHERE is_admin = 1", (err, admin) => {
        if (!admin) {
            const adminUser = process.env.ADMIN_USER || 'admin';
            const adminPass = process.env.ADMIN_PASS || 'admin';
            bcrypt.genSalt(10, (sErr, salt) => {
                bcrypt.hash(adminPass, salt, (hErr, hash) => {
                    db.run("INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)", [adminUser, hash], function() {
                        const adminId = this.lastID;
                        db.run("INSERT INTO folders (name, parent_id, user_id) VALUES (?, NULL, ?)", ['/', adminId]);
                    });
                });
            });
        }
    });
}

module.exports = db;
