require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
// fs 模组不再需要，因为我们直接接收流
// const fs = require('fs');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// 将第一个参数从 tempFilePath 更改为 fileStream
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
  // console.log(`[Telegram Storage] 开始处理文件流上传: ${fileName}`);
  try {
    const formData = new FormData();
    formData.append('chat_id', process.env.CHANNEL_ID);
    formData.append('caption', caption || fileName);
    
    // 直接使用传入的 fileStream
    // console.log(`[Telegram Storage] 将文件流添加到表单数据中: ${fileName}`);
    formData.append('document', fileStream, { filename: fileName });

    // console.log(`[Telegram Storage] 正在发送文件到 Telegram API...`);
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
        headers: formData.getHeaders() 
    });

    if (res.data.ok) {
        // console.log(`[Telegram Storage] Telegram API 成功接收文件: ${fileName}`);
        const result = res.data.result;
        const fileData = result.document || result.video || result.audio || result.photo;

        if (fileData && fileData.file_id) {
            // console.log(`[Telegram Storage] 正在将文件资讯写入资料库, File ID: ${fileData.file_id}`);
            await data.addFile({
              message_id: result.message_id,
              fileName,
              mimetype: fileData.mime_type || mimetype,
              size: fileData.file_size,
              file_id: fileData.file_id,
              thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
              date: Date.now(),
            }, folderId, userId, 'telegram');
            // console.log(`[Telegram Storage] 资料库写入成功: ${fileName}`);
            return { success: true, data: res.data, fileId: result.message_id };
        }
    }
    // console.error(`[Telegram Storage] Telegram API 返回错误:`, res.data);
    return { success: false, error: res.data };
  } catch (error) {
    const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
    // console.error(`[Telegram Storage] 上传过程中发生严重错误: ${errorDescription}`);
    // 确保在出错时消耗流以防止请求挂起
    if (fileStream && typeof fileStream.resume === 'function') {
        fileStream.resume();
    }
    return { success: false, error: { description: errorDescription }};
  }
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
