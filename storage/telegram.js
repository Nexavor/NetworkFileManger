// storage/telegram.js
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const FILE_NAME = 'storage/telegram.js';
const TMP_DIR = path.join(__dirname, '..', 'data', 'tmp');

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
};

function getTelegramConfig() {
    const botToken = process.env.BOT_TOKEN;
    const chatId = process.env.CHANNEL_ID;
    if (!botToken || !chatId) {
        throw new Error('Telegram 设定不完整，请检查 .env 档案中的 BOT_TOKEN 和 CHANNEL_ID');
    }
    return { botToken, chatId };
}

function getFolderPathForCaption(folderId, userId) {
    return data.getFolderPath(folderId, userId)
        .then(pathParts => {
            return pathParts.map(p => p.name.replace(/_/g, ' '))
                           .join('/')
                           .replace(/^\//, '')
                           .replace(/ /g, '_') 
                           .replace(/\//g, ' #');
        });
}

async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${fileName}" 到 Telegram...`);

    const config = getTelegramConfig();
    const url = `https://api.telegram.org/bot${config.botToken}/sendDocument`;
    
    const tempFileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const tempFilePath = path.join(TMP_DIR, tempFileName);

    try {
        await fsp.mkdir(TMP_DIR, { recursive: true });

        await new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempFilePath);
            fileStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            fileStream.on('error', reject);
        });

        const fileBuffer = await fsp.readFile(tempFilePath);
        
        const folderPathForCaption = await getFolderPathForCaption(folderId, userId);
        const finalCaption = `<b>${fileName}</b>\n${caption ? `\n${caption}\n` : ''}\n#${folderPathForCaption}`;
        const safeFilename = crypto.randomBytes(8).toString('hex') + path.extname(fileName);

        const form = new FormData();
        form.append('chat_id', config.chatId);
        form.append('document', fileBuffer, { filename: safeFilename });
        form.append('caption', finalCaption);
        form.append('parse_mode', 'HTML');
        form.append('disable_notification', true);

        // --- *** 关键修正 v3 开始 *** ---
        // 将整个表单转换为一个 Buffer
        const formBuffer = await new Promise((resolve, reject) => {
            form.toBuffer((err, buffer) => {
                if (err) reject(err);
                resolve(buffer);
            });
        });
        
        const formHeaders = form.getHeaders();

        log('DEBUG', FUNC_NAME, `正在发送 POST 请求到 Telegram API for "${fileName}"`);
        // 直接发送 Buffer
        const response = await axios.post(url, formBuffer, { headers: formHeaders });
        // --- *** 关键修正 v3 结束 *** ---

        if (!response.data.ok) {
            log('ERROR', FUNC_NAME, `上传到 Telegram 失败 for "${fileName}": ${response.data.description}`);
            throw new Error(`上传至 Telegram 失败: ${response.data.description}`);
        }

        log('INFO', FUNC_NAME, `文件成功上传到 Telegram: "${fileName}"`);
        const messageId = response.data.result.message_id;
        const fileInfo = response.data.result.document;
        const thumbInfo = fileInfo.thumb;

        const dbResult = await data.addFile({
            message_id: messageId,
            fileName: fileName,
            mimetype: fileInfo.mime_type,
            file_id: fileInfo.file_id,
            thumb_file_id: thumbInfo ? thumbInfo.file_id : null,
            date: response.data.result.date * 1000,
            size: fileInfo.file_size
        }, folderId, userId, 'telegram');

        log('INFO', FUNC_NAME, `文件 "${fileName}" 已成功存入资料库。`);
        return { success: true, message: '档案已上传至 Telegram。', fileId: dbResult.id };

    } catch (error) {
        log('ERROR', FUNC_NAME, `上传请求失败 for "${fileName}":`, error.message);
        if (fileStream && typeof fileStream.resume === 'function') {
            fileStream.resume();
        }
        if (error.response) {
            log('ERROR', FUNC_NAME, 'Telegram API 响应:', error.response.data);
            throw new Error(`上传至 Telegram 失败: ${error.response.data.description || error.message}`);
        }
        throw error;
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fsp.unlink(tempFilePath).catch(err => log('WARN', FUNC_NAME, `无法删除暂存档案 ${tempFilePath}:`, err));
        }
    }
}


async function remove(files) {
    const config = getTelegramConfig();
    const results = { success: true, errors: [] };

    for (const file of files) {
        try {
            const url = `https://api.telegram.org/bot${config.botToken}/deleteMessage`;
            await axios.post(url, {
                chat_id: config.chatId,
                message_id: file.message_id,
            });
        } catch (error) {
            if (error.response && error.response.status === 400 && error.response.data.description.includes("message to delete not found")) {
                continue;
            }
            const errorMessage = `从 Telegram 删除档案 [${file.fileName}] 失败: ${error.message}`;
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    return results;
}

async function getUrl(file_id) {
    const config = getTelegramConfig();
    const url = `https://api.telegram.org/bot${config.botToken}/getFile`;
    const response = await axios.post(url, { file_id });
    if (response.data.ok) {
        return `https://api.telegram.org/file/bot${config.botToken}/${response.data.result.file_path}`;
    }
    return null;
}

// Telegram 储存不需要 stream 函数
async function stream(file_id) {
    throw new Error('Telegram storage does not support direct streaming.');
}

module.exports = {
    upload,
    remove,
    getUrl,
    stream,
    type: 'telegram'
};
