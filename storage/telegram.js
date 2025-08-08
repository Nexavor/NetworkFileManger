// storage/telegram.js
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const path = require('path');

const FILE_NAME = 'storage/telegram.js';

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
};

function getTelegramConfig() {
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    if (!config.telegram || !config.telegram.botToken || !config.telegram.chatId) {
        throw new Error('Telegram 设定不完整');
    }
    return config.telegram;
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

    const folderPathForCaption = await getFolderPathForCaption(folderId, userId);
    
    // --- *** 关键修正 开始 *** ---
    // 将真实文件名加粗放在标题中，以获得最佳显示效果
    const finalCaption = `<b>${fileName}</b>\n${caption ? `\n${caption}\n` : ''}\n#${folderPathForCaption}`;

    // 使用一个随机、安全的文件名来上传，以绕过Telegram API对特殊字符的处理问题
    const safeFilename = crypto.randomBytes(8).toString('hex') + path.extname(fileName);
    // --- *** 关键修正 结束 *** ---

    const form = new FormData();
    form.append('chat_id', config.chatId);
    form.append('document', fileStream, { filename: safeFilename }); // 使用安全文件名
    form.append('caption', finalCaption);
    form.append('parse_mode', 'HTML');
    form.append('disable_notification', true);

    const headers = form.getHeaders();
    
    try {
        log('DEBUG', FUNC_NAME, `正在发送 POST 请求到 Telegram API for "${fileName}"`);
        const response = await axios.post(url, form, { headers });
        if (!response.data.ok) {
            log('ERROR', FUNC_NAME, `上传到 Telegram 失败 for "${fileName}": ${response.data.description}`);
            throw new Error(`上传至 Telegram 失败: ${response.data.description}`);
        }

        log('INFO', FUNC_NAME, `文件成功上传到 Telegram: "${fileName}"`);
        const messageId = response.data.result.message_id;
        const fileInfo = response.data.result.document;
        const thumbInfo = response.data.result.document.thumb;

        const dbResult = await data.addFile({
            message_id: messageId,
            fileName: fileName, // 在数据库中储存真实的、未修改的文件名
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
