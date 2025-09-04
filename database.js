// database.js (最终正式版 - 无自动管理员)

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'database.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("致命错误：连接数据库失败！", err.message);
        return;
    }
    createTables();
});

function createTables() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0
        )`, (err) => {
            if (err) { /* console.error("创建 'users' 表失败:", err.message); */ return; }
            createDependentTables();
        });
    });
}

function createDependentTables() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            user_id INTEGER NOT NULL,
            share_token TEXT,
            share_expires_at INTEGER,
            password TEXT,
            FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            UNIQUE(name, parent_id, user_id)
        )`, (err) => {
            if (err) { /* console.error("创建 'folders' 表失败:", err.message); */ return; }

            db.all("PRAGMA table_info(folders)", (pragmaErr, columns) => {
                if (pragmaErr) { /* console.error("无法读取 'folders' 表结构:", pragmaErr.message); */ return; }

                const hasSharePassword = columns.some(col => col.name === 'share_password');
                if (!hasSharePassword) {
                    db.run("ALTER TABLE folders ADD COLUMN share_password TEXT", (alterErr) => {
                        if (alterErr) { /* console.error("为 'folders' 表添加 'share_password' 失败:", alterErr.message); */ return; }
                        createFilesTable();
                    });
                } else {
                    createFilesTable();
                }
            });
        });
    });
}

function createFilesTable() {
    db.serialize(() => {
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
            folder_id INTEGER NOT NULL DEFAULT 1,
            user_id INTEGER NOT NULL,
            storage_type TEXT NOT NULL DEFAULT 'telegram',
            UNIQUE(fileName, folder_id, user_id),
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`, (err) => {
            if (err) { /* console.error("创建 'files' 表失败:", err.message); */ return; }

            db.all("PRAGMA table_info(files)", (pragmaErr, columns) => {
                if (pragmaErr) { /* console.error("无法读取 'files' 表结构:", pragmaErr.message); */ return; }

                const hasSharePassword = columns.some(col => col.name === 'share_password');
                if (!hasSharePassword) {
                    db.run("ALTER TABLE files ADD COLUMN share_password TEXT", (alterErr) => {
                        if (alterErr) { /* console.error("为 'files' 表添加 'share_password' 失败:", alterErr.message); */ return; }
                        checkAndCreateAdmin();
                    });
                } else {
                    checkAndCreateAdmin();
                }
            });
        });
    });
}

function checkAndCreateAdmin() {
    // 此函数被有意留空，以防止自动创建管理员账户。
    // 第一个用户必须通过注册页面手动创建。
}

module.exports = db;
