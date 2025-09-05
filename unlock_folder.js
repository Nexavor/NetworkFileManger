// unlock_folder.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');

// --- 配置区 ---
const DB_PATH = path.join(__dirname, 'data', 'database.db');
// --- 配置区结束 ---

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('\x1b[31m%s\x1b[0m', `[错误] 无法连接到资料库: ${DB_PATH}`);
        console.error('\x1b[31m%s\x1b[0m', err.message);
        return;
    }
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

function listAllUsers() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, username FROM users ORDER BY id ASC`;
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getLockedFolders(userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, name FROM folders WHERE user_id = ? AND password IS NOT NULL ORDER BY name ASC`;
        db.all(sql, [userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function unlockFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE folders SET password = NULL WHERE id = ? AND user_id = ?`;
        db.run(sql, [folderId, userId], function(err) {
            if (err) return reject(err);
            resolve(this.changes);
        });
    });
}


async function main() {
    console.log('\x1b[33m%s\x1b[0m', '--- 资料夹密码移除工具 ---');
    
    try {
        const users = await listAllUsers();
        if (users.length === 0) {
            console.log('\x1b[31m%s\x1b[0m', '资料库中没有任何使用者。');
            return;
        }

        console.log('可用使用者列表:');
        users.forEach(user => {
            console.log(`  ID: ${user.id}, 使用者名称: ${user.username}`);
        });
        
        const userIdInput = await askQuestion('请输入要操作的使用者 ID: ');
        const userId = parseInt(userIdInput, 10);
        if (isNaN(userId) || !users.some(u => u.id === userId)) {
            console.error('\x1b[31m%s\x1b[0m', '无效的使用者 ID。');
            return;
        }

        const lockedFolders = await getLockedFolders(userId);
        if (lockedFolders.length === 0) {
            console.log('\x1b[32m%s\x1b[0m', `使用者 ID ${userId} 底下没有已加密的资料夹。`);
            return;
        }

        console.log(`\n使用者 ID ${userId} 的已加密资料夹:`);
        lockedFolders.forEach(folder => {
            console.log(`  资料夹 ID: ${folder.id}, 名称: ${folder.name}`);
        });

        const folderIdInput = await askQuestion('请输入您想移除密码的资料夹 ID: ');
        const folderId = parseInt(folderIdInput, 10);
        if (isNaN(folderId) || !lockedFolders.some(f => f.id === folderId)) {
            console.error('\x1b[31m%s\x1b[0m', '无效的资料夹 ID。');
            return;
        }

        const changes = await unlockFolder(folderId, userId);
        if (changes > 0) {
            console.log('\x1b[32m%s\x1b[0m', `✅ 成功！资料夹 ID ${folderId} 的密码已被移除。`);
        } else {
            console.error('\x1b[31m%s\x1b[0m', '操作失败，找不到对应的资料夹或资料库发生错误。');
        }

    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', '处理过程中发生错误:', error.message);
    } finally {
        rl.close();
        db.close();
    }
}

main();
