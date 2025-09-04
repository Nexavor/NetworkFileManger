// database.js (调试版本)

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'database.db');
console.log(`[数据库调试] 准备连接数据库，路径: ${dbPath}`);

// 在连接前检查文件是否存在
if (fs.existsSync(dbPath)) {
    console.log('[数据库调试] 发现已存在的 database.db 文件。');
} else {
    console.log('[数据库调试] 未发现 database.db 文件，将在连接时由 sqlite3 创建。');
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[数据库调试] 致命错误：连接数据库失败！', err.message);
        return;
    }
    console.log('[数据库调试] 数据库连接成功。开始检查并创建表结构...');
    createTables();
});

function createTables() {
    db.serialize(() => {
        console.log('[数据库调试] 步骤 1: 开始创建/验证 users 表。');
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0
        )`, (err) => {
            if (err) return console.error("[数据库调试] 创建 'users' 表失败:", err.message);
            console.log("[数据库调试] 'users' 表已确认。");
            createDependentTables();
        });
    });
}

function createDependentTables() {
    db.serialize(() => {
        console.log('[数据库调试] 步骤 2: 开始创建/验证 folders 表。');
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
            if (err) return console.error("[数据库调试] 创建 'folders' 表失败:", err.message);
            console.log("[数据库调试] 'folders' 表已确认。现在检查 share_password 字段...");

            db.all("PRAGMA table_info(folders)", (pragmaErr, columns) => {
                if (pragmaErr) return console.error("[数据库调试] 无法读取 'folders' 表结构:", pragmaErr.message);

                const hasSharePassword = columns.some(col => col.name === 'share_password');
                if (!hasSharePassword) {
                    console.log("[数据库调试] 'folders' 表缺少 'share_password' 字段，正在添加...");
                    db.run("ALTER TABLE folders ADD COLUMN share_password TEXT", (alterErr) => {
                        if (alterErr) return console.error("[数据库调试] 为 'folders' 表添加 'share_password' 失败:", alterErr.message);
                        console.log("[数据库调试] 成功为 'folders' 表添加 'share_password' 字段。");
                        createFilesTable();
                    });
                } else {
                    console.log("[数据库调试] 'folders' 表结构正确，已包含 'share_password'。");
                    createFilesTable();
                }
            });
        });
    });
}

function createFilesTable() {
    db.serialize(() => {
        console.log('[数据库调试] 步骤 3: 开始创建/验证 files 表。');
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
            if (err) return console.error("[数据库调试] 创建 'files' 表失败:", err.message);
            console.log("[数据库调试] 'files' 表已确认。现在检查 share_password 字段...");

            db.all("PRAGMA table_info(files)", (pragmaErr, columns) => {
                if (pragmaErr) return console.error("[数据库调试] 无法读取 'files' 表结构:", pragmaErr.message);

                const hasSharePassword = columns.some(col => col.name === 'share_password');
                if (!hasSharePassword) {
                    console.log("[数据库调试] 'files' 表缺少 'share_password' 字段，正在添加...");
                    db.run("ALTER TABLE files ADD COLUMN share_password TEXT", (alterErr) => {
                        if (alterErr) return console.error("[数据库调试] 为 'files' 表添加 'share_password' 失败:", alterErr.message);
                        console.log("[数据库调试] 成功为 'files' 表添加 'share_password' 字段。");
                        checkAndCreateAdmin();
                    });
                } else {
                    console.log("[数据库调试] 'files' 表结构正确，已包含 'share_password'。");
                    checkAndCreateAdmin();
                }
            });
        });
    });
}

function checkAndCreateAdmin() {
    console.log('[数据库调试] 步骤 4: 检查管理员账户。');
    db.get("SELECT * FROM users WHERE is_admin = 1", (err, row) => {
        if (err) return console.error("[数据库调试] 检查管理员时出错:", err.message);
        if (!row) {
            console.log('[数据库调试] 未发现管理员账户，正在创建默认 admin / 123456 ...');
            const bcrypt = require('bcrypt');
            bcrypt.genSalt(10, (err, salt) => {
                bcrypt.hash('123456', salt, (err, hash) => {
                    if (err) return console.error("Hashing failed:", err);
                    db.run("INSERT INTO users (username, password, is_admin) VALUES ('admin', ?, 1)", [hash], (err) => {
                        if (err) return console.error("创建管理员失败:", err.message);
                        console.log("[数据库调试] 默认管理员已创建。");
                        db.get("SELECT id FROM users WHERE username = 'admin'", (err, adminUser) => {
                            if (adminUser) {
                                db.run("INSERT INTO folders (name, user_id) VALUES ('/', ?)", [adminUser.id], () => {
                                    console.log("[数据库调试] 管理员的根目录已创建。数据库初始化完成。");
                                });
                            }
                        });
                    });
                });
            });
        } else {
            console.log('[数据库调试] 管理员账户已存在。数据库初始化完成。');
        }
    });
}

module.exports = db;
