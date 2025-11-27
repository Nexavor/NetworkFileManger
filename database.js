// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
require('dotenv').config();

// 1. 确保数据目录存在 (防止 SQLITE_CANTOPEN 错误)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`已建立资料目录: ${dataDir}`);
    } catch (err) {
        console.error("无法建立资料目录:", err);
    }
}

const dbPath = path.join(dataDir, 'database.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("致命错误：连接资料库失败！", err.message);
        return;
    }
    createTables();
});

// 辅助函数：安全地添加列 (关键修复)
function addColumnIfNotExists(tableName, columnName, columnDef) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${tableName})`, (err, cols) => {
            if (err) {
                // 如果表不存在，忽略错误，后续 createTables 会创建它
                return resolve();
            }
            if (!cols.some(c => c.name === columnName)) {
                console.log(`正在为表 ${tableName} 添加列 ${columnName}...`);
                db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`, (err) => {
                    if (err) console.error(`添加列 ${tableName}.${columnName} 失败:`, err.message);
                    resolve();
                });
            } else {
                resolve();
            }
        });
    });
}

function createTables() {
    db.serialize(() => {
        // 1. Users 表
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            max_storage_bytes INTEGER DEFAULT 1073741824
        )`, async (err) => {
            if (err) return console.error("建立 users 表失败:", err);
            
            // 迁移旧数据：确保 max_storage_bytes 存在
            await addColumnIfNotExists('users', 'max_storage_bytes', 'INTEGER DEFAULT 1073741824');
            
            createDependentTables();
        });
    });
}

function createDependentTables() {
    db.serialize(() => {
        // 2. Folders 表
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
        )`, async (err) => {
            if (err) return console.error("建立 folders 表失败:", err);

            // 迁移旧数据：添加所有缺失的新字段
            await addColumnIfNotExists('folders', 'share_password', 'TEXT');
            await addColumnIfNotExists('folders', 'is_deleted', 'INTEGER DEFAULT 0');
            await addColumnIfNotExists('folders', 'deleted_at', 'INTEGER');

            createFilesTable();
        });
    });
}

function createFilesTable() {
    db.serialize(() => {
        // 3. Files 表
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
        )`, async (err) => {
            if (err) return console.error("建立 files 表失败:", err);

            // 迁移旧数据：添加所有缺失的新字段
            await addColumnIfNotExists('files', 'share_password', 'TEXT');
            await addColumnIfNotExists('files', 'is_deleted', 'INTEGER DEFAULT 0');
            await addColumnIfNotExists('files', 'deleted_at', 'INTEGER');

            createAuthTokenTable();
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
        if (err) console.error("建立 auth_tokens 表失败:", err);
        checkAndCreateAdmin();
    });
}

function checkAndCreateAdmin() {
    db.get("SELECT * FROM users WHERE is_admin = 1", (err, admin) => {
        if (err) return;
        
        if (!admin) {
            const adminUser = process.env.ADMIN_USER || 'admin';
            const adminPass = process.env.ADMIN_PASS || 'admin';
            
            bcrypt.genSalt(10, (sErr, salt) => {
                if(sErr) return;
                bcrypt.hash(adminPass, salt, (hErr, hash) => {
                    if(hErr) return;
                    db.run("INSERT INTO users (username, password, is_admin, max_storage_bytes) VALUES (?, ?, 1, 1073741824)", [adminUser, hash], function() {
                        const adminId = this.lastID;
                        // 确保根目录存在
                        db.run("INSERT INTO folders (name, parent_id, user_id) VALUES (?, NULL, ?)", ['/', adminId], () => {});
                    });
                });
            });
        }
    });
}

module.exports = db;
