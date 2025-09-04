require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
const path = require('path');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const FILE_NAME = 'storage/telegram.js';

const log = (level, func, message, ...args) => {};

function truncateFilename(filename, maxLength = 200) {
    if (filename.length <= maxLength) return filename;
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    const availableLength = maxLength - ext.length - 1; 
    if (availableLength <= 0) return filename.substring(filename.length - maxLength);
    return baseName.substring(0, availableLength) + ext;
}

async function upload(fileStream, originalFileName, mimetype, userId, folderId, caption = '') {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${originalFileName}" 到 Telegram...`);
  
    return new Promise(async (resolve, reject) => {
        try {
            const formData = new FormData();
            const truncatedApiFileName = truncateFilename(originalFileName); 
            
            formData.append('chat_id', process.env.CHANNEL_ID);
            formData.append('caption', caption || originalFileName);
            formData.append('document', fileStream, { filename: truncatedApiFileName });
            
            fileStream.on('error', err => reject(new Error(`输入文件流中断: ${err.message}`)));

            const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
                headers: formData.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            if (res.data.ok) {
                const result = res.data.result;
                const fileData = result.document || result.video || result.audio || result.photo;

                if (fileData && fileData.file_id) {
                    const dbResult = await data.addFile({
                      message_id: result.message_id,
                      originalFileName: originalFileName,
                      mimetype: fileData.mime_type || mimetype,
                      size: fileData.file_size,
                      safeStoragePath: fileData.file_id, // Telegram 的 file_id 就是其安全路径
                      thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
                      date: Date.now(),
                    }, folderId, userId, 'telegram');
                    resolve({ success: true, data: res.data, fileId: dbResult.fileId });
                } else {
                     reject(new Error('Telegram API 响应成功，但缺少 file_id'));
                }
            } else {
                 reject(new Error(res.data.description || 'Telegram API 返回失败'));
            }
        } catch (error) {
            const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
            if (fileStream && typeof fileStream.resume === 'function') fileStream.resume();
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
        await data.deleteFilesByIds(results.success.map(id => ({ message_id: id })), userId);
    }
    
    return results;
}

async function getUrl(file_id) {
  if (!file_id || typeof file_id !== 'string') return null;
  const cleaned_file_id = file_id.trim();
  try {
    const response = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: cleaned_file_id } });
    if (response.data.ok) return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${response.data.result.file_path}`;
  } catch (error) { }
  return null;
}

module.exports = { upload, remove, getUrl, type: 'telegram' };
