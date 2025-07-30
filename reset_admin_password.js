const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const readline = require('readline');

// --- 配置区 ---
// 一般情况下，您的管理员使用者名称是第一个建立的帐号
const ADMIN_USERNAME = 'admin'; // 请确认这是您的管理员使用者名称，如果不是，请修改
const DB_PATH = path.join(__dirname, 'data', 'database.db');
// --- 配置区结束 ---


const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('\x1b[31m%s\x1b[0m', `[错误] 无法连接到资料库: ${DB_PATH}`);
        console.error('\x1b[31m%s\x1b[0m', err.message);
        console.log('请确认您的专案路径是否正确，以及 `data/database.db` 档案是否存在。');
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

async function resetPassword() {
    console.log('\x1b[33m%s\x1b[0m', '--- 管理员密码重置工具 ---');
    console.log(`准备为使用者 [\x1b[36m${ADMIN_USERNAME}\x1b[0m] 重设密码。`);
    
    const newPassword = await askQuestion('请输入新密码 (输入后会直接显示，请确保环境安全): ');
    if (!newPassword || newPassword.length < 4) {
        console.error('\x1b[31m%s\x1b[0m', '密码长度不可少于 4 个字元。操作已取消。');
        rl.close();
        db.close();
        return;
    }

    try {
        console.log('正在产生安全的密码杂凑值...');
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        console.log('杂凑值已产生。');

        const sql = `UPDATE users SET password = ? WHERE username = ?`;

        db.run(sql, [hashedPassword, ADMIN_USERNAME], function(err) {
            if (err) {
                console.error('\x1b[31m%s\x1b[0m', '更新密码时发生资料库错误:', err.message);
            } else {
                if (this.changes === 0) {
                    console.error('\x1b[31m%s\x1b[0m', `错误：在资料库中找不到使用者 "${ADMIN_USERNAME}"。`);
                    console.log('请检查您在脚本中设定的 ADMIN_USERNAME 是否正确。');
                } else {
                    console.log('\x1b[32m%s\x1b[0m', `✅ 成功！使用者 "${ADMIN_USERNAME}" 的密码已被重设。`);
                    console.log('现在您可以重新启动主程式 (node server.js) 并使用新密码登入。');
                }
            }
            rl.close();
            db.close();
        });

    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', '重设密码过程中发生未知错误:', error);
        rl.close();
        db.close();
    }
}

resetPassword();
