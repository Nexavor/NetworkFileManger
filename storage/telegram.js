require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const FILE_NAME = 'storage/telegram.js';

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    // const timestamp = new Date().toISOString();
    // console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
};

// --- *** 重构 upload 函数 *** ---
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '', existingItem = null) { // <-- 接受 existingItem
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${fileName}" 到 Telegram...`);
  
    return new Promise(async (resolve, reject) => {
        let oldMessageId = null; // <-- 储存旧消息 ID
        try {
            const formData = new FormData();
            formData.append('chat_id', process.env.CHANNEL_ID);
            formData.append('caption', caption || fileName);
            formData.append('document', fileStream, { filename: fileName });
            
            // 关键：监听输入流的错误，防止它静默失败
            fileStream.on('error', err => {
                log('ERROR', FUNC_NAME, `输入文件流 (fileStream) 发生错误 for "${fileName}":`, err);
                reject(new Error(`输入文件流中断: ${err.message}`));
            });

            log('DEBUG', FUNC_NAME, `正在发送 POST 请求到 Telegram API for "${fileName}"`);
            // 1. 上传新文件
            const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
                headers: formData.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            log('DEBUG', FUNC_NAME, `收到 Telegram API 的响应 for "${fileName}"`);

            if (res.data.ok) {
                const result = res.data.result;
                const fileData = result.document || result.video || result.audio || result.photo;

                if (fileData && fileData.file_id) {
                    
                    // --- 新增：安全覆盖数据库 ---
                    if (existingItem) {
                        log('DEBUG', FUNC_NAME, `覆盖模式: 正在删除旧的数据库条目 (ID: ${existingItem.id})`);
                        oldMessageId = existingItem.id; // 记录旧消息ID，稍后删除
                        // 2. 上传成功后，删除旧的数据库条目
                        await data.deleteFilesByIds([existingItem.id], userId);
                    }
                    // --- 结束：安全覆盖数据库 ---

                    log('DEBUG', FUNC_NAME, `正在将文件资讯添加到资料库: "${fileName}"`);
                    // 3. 添加新的数据库条目
                    const dbResult = await data.addFile({
                      message_id: result.message_id,
                      fileName,
                      mimetype: fileData.mime_type || mimetype,
                      size: fileData.file_size,
                      file_id: fileData.file_id,
                      thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
                      date: Date.now(),
                    }, folderId, userId, 'telegram');
                    
                    // 4. (最佳实践) 在新数据库条目写入成功后，再删除旧的 Telegram 消息
                    if (oldMessageId) {
                        axios.post(`${TELEGRAM_API}/deleteMessage`, {
                            chat_id: process.env.CHANNEL_ID,
                            message_id: oldMessageId,
                        }).catch(err => {
                            const reason = err.response ? err.response.data.description : err.message;
                            log('WARN', FUNC_NAME, `(非致命) 删除旧的 Telegram 消息 (ID: ${oldMessageId}) 失败: ${reason}`);
                        });
                    }

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
            // 确保流在任何错误情况下都被消耗掉
            if (fileStream && typeof fileStream.resume === 'function') {
                fileStream.resume();
            }
            reject(new Error(`上传至 Telegram 失败: ${errorDescription}`));
        }
    });
}
// --- *** upload 函数重构结束 *** ---

// --- *** 重构 remove 函数 *** ---
// 移除函数内部的 data.deleteFilesByIds 调用，
// 因为 data.unifiedDelete 会统一处理数据库删除。
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

    // if (results.success.length > 0) {
    //     await data.deleteFilesByIds(results.success, userId);
    // }
    
    return results;
}
// --- *** remove 函数重构结束 *** ---

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
