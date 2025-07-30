const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('无法连接到资料库', err.message);
    } else {
        console.log('成功连接到 SQLite 资料库。');
        db.run('PRAGMA foreign_keys = ON;', (err) => {
            if (err) {
                console.error("无法启用外键约束:", err.message);
            } else {
                console.log("外键约束已启用。");
            }
        });
    }
});

const initialSchema = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    user_id INTEGER NOT NULL,
    share_token TEXT UNIQUE,
    share_expires_at INTEGER,
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id, user_id)
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER UNIQUE NOT NULL,
    fileName TEXT NOT NULL,
    mimetype TEXT,
    size INTEGER,
    date INTEGER,
    file_id TEXT,
    thumb_file_id TEXT,
    folder_id INTEGER,
    user_id INTEGER NOT NULL,
    storage_type TEXT,
    share_token TEXT UNIQUE,
    share_expires_at INTEGER,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(fileName, folder_id, user_id)
);
`;

db.exec(initialSchema, (err) => {
    if (err) {
        console.error("初始化资料库结构失败:", err.message);
    }
});


// --- 新生：自动资料库迁移脚本 ---
function runMigration() {
    console.log("正在检查资料库结构...");
    db.all("PRAGMA table_info(files);", [], (err, columns) => {
        if (err) {
            console.error("无法读取 'files' 表的资讯:", err.message);
            return;
        }

        const hasStorageIdColumn = columns.some(col => col.name === 'storage_id');

        if (!hasStorageIdColumn) {
            console.log("'files' 表缺少 'storage_id' 字段，正在自动新增...");
            db.run("ALTER TABLE files ADD COLUMN storage_id TEXT;", (alterErr) => {
                if (alterErr) {
                    console.error("自动新增 'storage_id' 字段失败:", alterErr.message);
                } else {
                    console.log("成功新增 'storage_id' 字段到 'files' 表。");
                }
            });
        } else {
            console.log("资料库结构已是最新，无需变更。");
        }
    });
}

// 在模块加载时立即执行迁移检查
runMigration();


module.exports = db;
