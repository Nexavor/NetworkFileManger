// storage/telegram.js
require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const FILE_NAME = 'storage/telegram.js';

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [TELEGRAM:${level}] [${func}] - ${message}`, ...args);
};

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) { // <-- 参数名改为 fileStreamOrBuffer
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${fileName}" 到 Telegram...`);
  
    return new Promise(async (resolve, reject) => {
        try {
            const formData = new FormData();
            formData.append('chat_id', process.env.CHANNEL_ID);
            formData.append('caption', caption || fileName);
            
            // form-data 库同时支持 Buffer 和 Stream
            formData.append('document', fileStreamOrBuffer, { filename: fileName });
            
            // --- 关键修正：仅当输入是流时才添加错误监听 ---
            if (!Buffer.isBuffer(fileStreamOrBuffer) && typeof fileStreamOrBuffer.on === 'function') {
                fileStreamOrBuffer.on('error', err => {
                    log('ERROR', FUNC_NAME, `输入文件流发生错误 for "${fileName}":`, err);
                    reject(new Error(`输入文件流中断: ${err.message}`));
                });
            }

            log('DEBUG', FUNC_NAME, `正在发送 POST 请求到 Telegram API for "${fileName}"`);
            
            const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
                headers: formData.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            log('DEBUG', FUNC_NAME, `收到 Telegram API 的响应 for "${fileName}"`);

            if (res.data.ok) {
                const result = res.data.result;
                const fileData = result.document || result.video || result.audio || result.photo;
                // Telegram 有时返回 photo 是数组，取最大的那张（通常是最后一张）
                const finalFileData = Array.isArray(fileData) ? fileData[fileData.length - 1] : fileData;

                if (finalFileData && finalFileData.file_id) {
                    
                    // --- BUG 1 修复逻辑 ---
                    if (existingItem) {
                        // 覆盖：先删除旧的消息
                        log('DEBUG', FUNC_NAME, `(覆盖) 正在删除旧的 Telegram 消息: ${existingItem.message_id}`);
                        await data.deleteMessages([existingItem.message_id]);
                        log('INFO', FUNC_NAME, `旧消息 ${existingItem.message_id} 已删除。`);
                    }
                    
                    // (新增或覆盖) 添加新文件的数据库条目
                    log('DEBUG', FUNC_NAME, `正在将新文件资讯添加到资料库: "${fileName}"`);
                    const dbResult = await data.addFile({
                      message_id: result.message_id,
                      fileName,
                      mimetype: finalFileData.mime_type || mimetype, // 修正取值变量
                      size: finalFileData.file_size,
                      file_id: finalFileData.file_id,
                      thumb_file_id: finalFileData.thumb ? finalFileData.thumb.file_id : null,
                      date: Date.now(),
                    }, folderId, userId, 'telegram');
                    
                    log('INFO', FUNC_NAME, `文件 "${fileName}" 已成功存入资料库。`);
                    resolve({ success: true, data: res.data, fileId: dbResult.fileId });

                } else {
                     reject(new Error('Telegram API 响应成功，但缺少 file_id'));
                }
            } else {
                 reject(new Error(res.data.description || 'Telegram API 返回失败'));
            }
        } catch (error) {
            const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
            log('ERROR', FUNC_NAME, `上传到 Telegram 失败 for "${fileName}": ${errorDescription}`);
            
            // 仅当它是流且具有 resume 方法时才调用
            if (fileStreamOrBuffer && typeof fileStreamOrBuffer.resume === 'function') {
                fileStreamOrBuffer.resume();
            }
            reject(new Error(`上传至 Telegram 失败: ${errorDescription}`));
        }
    });
}

async function remove(files, userId) {
    const messageIds = files.map(f => f.message_id);
    const results = { success: [], failure: [] };
    if (!Array.isArray(messageIds) || messageIds.length === 0) return results;

    for (const messageId of messageIds) {
        try {
            const res = await axios.post(`${TELEGRAM_API}/deleteMessage`, {
                chat_id: process.env.CHANNEL_ID,
                message_id: messageId,
            });
            if (res.data.ok || (res.data.description && res.data.description.includes("message to delete not found"))) {
                results.success.push(messageId);
            } else {
                results.failure.push({ id: messageId, reason: res.data.description });
            }
        } catch (error) {
            const reason = error.response ? error.response.data.description : error.message;
            if (reason.includes("message to delete not found")) {
                results.success.push(messageId);
            } else {
                results.failure.push({ id: messageId, reason });
            }
        }
    }

    if (results.success.length > 0) {
        await data.deleteFilesByIds(results.success, userId);
    }
    
    return results;
}

async function getUrl(file_id) {
  if (!file_id || typeof file_id !== 'string') return null;
  const cleaned_file_id = file_id.trim();
  try {
    const response = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: cleaned_file_id } });
    if (response.data.ok) return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${response.data.result.file_path}`;
  } catch (error) { /* console.error("获取文件链接失败:", error.response?.data?.description || error.message); */ }
  return null;
}

module.exports = { upload, remove, getUrl, type: 'telegram' };
