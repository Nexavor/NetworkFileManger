// storage/telegram.js
require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// ... (upload, remove, getUrl 保持不变) ...
async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    // 请保留原有的 upload 完整代码
    return new Promise(async (resolve, reject) => {
        try {
            const formData = new FormData();
            formData.append('chat_id', process.env.CHANNEL_ID);
            formData.append('caption', caption || fileName);
            formData.append('document', fileStreamOrBuffer, { filename: fileName });
            if (!Buffer.isBuffer(fileStreamOrBuffer) && typeof fileStreamOrBuffer.on === 'function') {
                fileStreamOrBuffer.on('error', err => { reject(new Error(`输入文件流中断: ${err.message}`)); });
            }
            const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { headers: formData.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
            if (res.data.ok) {
                const result = res.data.result;
                const fileData = result.document || result.video || result.audio || result.photo;
                const finalFileData = Array.isArray(fileData) ? fileData[fileData.length - 1] : fileData;
                if (finalFileData && finalFileData.file_id) {
                    if (existingItem) await data.deleteMessages([existingItem.message_id]);
                    const dbResult = await data.addFile({
                      message_id: result.message_id,
                      fileName,
                      mimetype: finalFileData.mime_type || mimetype,
                      size: finalFileData.file_size,
                      file_id: finalFileData.file_id,
                      thumb_file_id: finalFileData.thumb ? finalFileData.thumb.file_id : null,
                      date: Date.now(),
                    }, folderId, userId, 'telegram');
                    resolve({ success: true, data: res.data, fileId: dbResult.fileId });
                } else { reject(new Error('Telegram API 响应成功，但缺少 file_id')); }
            } else { reject(new Error(res.data.description || 'Telegram API 返回失败')); }
        } catch (error) {
            if (fileStreamOrBuffer && typeof fileStreamOrBuffer.resume === 'function') fileStreamOrBuffer.resume();
            reject(new Error(`上传至 Telegram 失败: ${error.message}`));
        }
    });
}

async function remove(files, userId) {
    // 请保留原有的 remove 完整代码
    const messageIds = files.map(f => f.message_id);
    const results = { success: [], failure: [] };
    if (!Array.isArray(messageIds) || messageIds.length === 0) return results;
    for (const messageId of messageIds) {
        try {
            const res = await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: process.env.CHANNEL_ID, message_id: messageId });
            if (res.data.ok || (res.data.description && res.data.description.includes("message to delete not found"))) {
                results.success.push(messageId);
            } else { results.failure.push({ id: messageId, reason: res.data.description }); }
        } catch (error) {
            const reason = error.response ? error.response.data.description : error.message;
            if (reason.includes("message to delete not found")) results.success.push(messageId);
            else results.failure.push({ id: messageId, reason });
        }
    }
    if (results.success.length > 0) await data.deleteFilesByIds(results.success, userId);
    return results;
}

async function getUrl(file_id) {
  if (!file_id || typeof file_id !== 'string') return null;
  try {
    const response = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: file_id.trim() } });
    if (response.data.ok) return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${response.data.result.file_path}`;
  } catch (error) {}
  return null;
}

// --- 新增 Copy (实际上是重新发送文件ID) ---
async function copy(file, newFileName, userId) {
    // Telegram 不允许直接 Bot 到 Bot 的复制，但可以用 sendDocument 发送已有的 file_id
    // 这样会生成一个新的 message_id，但共享底层的 file 对象
    try {
        const res = await axios.post(`${TELEGRAM_API}/sendDocument`, {
            chat_id: process.env.CHANNEL_ID,
            document: file.file_id,
            caption: newFileName
        });
        
        if (res.data.ok) {
            const result = res.data.result;
            const fileData = result.document || result.video || result.audio || result.photo;
            const finalFileData = Array.isArray(fileData) ? fileData[fileData.length - 1] : fileData;
            
            // 我们需要返回结构，让 data.js 的 copyItem 使用 addFile
            // 但 data.js 的 copyItem 逻辑比较通用。
            // 这里的 copy 函数如果不返回标准路径，需要特殊处理。
            // 为了适应 data.js 的逻辑，我们这里返回一个对象，包含 metadata
            return {
                message_id: result.message_id,
                file_id: finalFileData.file_id,
                thumb_file_id: finalFileData.thumb ? finalFileData.thumb.file_id : null,
                size: finalFileData.file_size
            };
        } else {
            throw new Error(res.data.description);
        }
    } catch (error) {
        throw new Error(`Telegram 复制失败: ${error.message}`);
    }
}

module.exports = { upload, remove, getUrl, copy, type: 'telegram' };
