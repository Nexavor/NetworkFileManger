// database.js (最終正式版 - 恢復自動管理員建立)

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'data', 'database.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("致命錯誤：連接資料庫失敗！", err.message);
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
            if (err) { /* console.error("建立 'users' 表失敗:", err.message); */ return; }
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
            if (err) { /* console.error("建立 'folders' 表失敗:", err.message); */ return; }

            db.all("PRAGMA table_info(folders)", (pragmaErr, columns) => {
                if (pragmaErr) { /* console.error("無法讀取 'folders' 表結構:", pragmaErr.message); */ return; }

                const hasSharePassword = columns.some(col => col.name === 'share_password');
                if (!hasSharePassword) {
                    db.run("ALTER TABLE folders ADD COLUMN share_password TEXT", (alterErr) => {
                        if (alterErr) { /* console.error("為 'folders' 表新增 'share_password' 失敗:", alterErr.message); */ return; }
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
            if (err) { /* console.error("建立 'files' 表失敗:", err.message); */ return; }

            db.all("PRAGMA table_info(files)", (pragmaErr, columns) => {
                if (pragmaErr) { /* console.error("無法讀取 'files' 表結構:", pragmaErr.message); */ return; }

                const hasSharePassword = columns.some(col => col.name === 'share_password');
                if (!hasSharePassword) {
                    db.run("ALTER TABLE files ADD COLUMN share_password TEXT", (alterErr) => {
                        if (alterErr) { /* console.error("為 'files' 表新增 'share_password' 失敗:", alterErr.message); */ return; }
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
    db.get("SELECT * FROM users WHERE is_admin = 1", (err, admin) => {
        if (err) { /* console.error("查詢管理員時出錯:", err.message); */ return; }
        
        if (!admin) {
            // 如果找不到管理員，則建立一個預設的
            const adminUser = 'admin';
            const adminPass = 'admin';
            
            bcrypt.genSalt(10, (saltErr, salt) => {
                if (saltErr) { /* console.error("生成 salt 失敗:", saltErr); */ return; }
                bcrypt.hash(adminPass, salt, (hashErr, hashedPassword) => {
                    if (hashErr) { /* console.error("密碼雜湊失敗:", hashErr); */ return; }

                    db.run("INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)", [adminUser, hashedPassword], function(insertErr) {
                        if (insertErr) { /* console.error("建立管理員帳號失敗:", insertErr.message); */ return; }
                        
                        const adminId = this.lastID;
                        
                        // 為新管理員建立根目錄
                        db.run("INSERT INTO folders (name, parent_id, user_id) VALUES (?, NULL, ?)", ['/', adminId], (folderErr) => {
                            if(folderErr) { /* console.error("為管理員建立根目錄失敗:", folderErr.message); */ }
                        });
                    });
                });
            });
        }
    });
}

module.exports = db;
