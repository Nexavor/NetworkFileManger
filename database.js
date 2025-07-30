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

// --- 重构：更通用的资料库迁移函式 ---
async function runMigrations() {
    console.log("正在检查并执行资料库迁移...");
    
    // 迁移任务列表
    const migrations = [
        {
            name: "add_storage_id_to_files",
            query: "ALTER TABLE files ADD COLUMN storage_id TEXT;",
            check: async () => {
                return new Promise((resolve) => {
                    db.all("PRAGMA table_info(files);", [], (err, columns) => {
                        if (err) return resolve(false);
                        resolve(!columns.some(col => col.name === 'storage_id'));
                    });
                });
            }
        },
        // 未来可以新增更多迁移任务...
        // {
        //     name: "add_new_feature_column",
        //     query: "ALTER TABLE users ADD COLUMN new_feature INTEGER DEFAULT 0;",
        //     check: async () => { ... }
        // }
    ];

    for (const migration of migrations) {
        const needsMigration = await migration.check();
        if (needsMigration) {
            console.log(`需要执行迁移: ${migration.name}...`);
            await new Promise((resolve, reject) => {
                db.run(migration.query, (err) => {
                    if (err) {
                        console.error(`迁移 ${migration.name} 失败:`, err.message);
                        return reject(err);
                    }
                    console.log(`成功完成迁移: ${migration.name}。`);
                    resolve();
                });
            });
        }
    }
    console.log("资料库结构检查完成。");
}


// 在模组加载时立即执行迁移检查
runMigrations().catch(err => {
    console.error("资料库迁移过程中发生严重错误:", err);
});


module.exports = db;
