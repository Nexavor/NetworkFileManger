// nexavor/networkfilemanger/NetworkFileManger-3e4f0de892876353b30de887fe2e2c15874ed343/storage/telegram.js
require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
// fs 模组不再需要，因为我们直接接收流
// const fs = require('fs');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// 将第一个参数从 tempFilePath 更改为 fileStream
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
  // 将整个操作包装在一个 Promise 中，以便可以监听流的错误事件
  return new Promise(async (resolve, reject) => {
    // 如果来源流发生错误，则拒绝整个 Promise
    fileStream.on('error', err => {
        reject(new Error(`来源档案流发生错误: ${err.message}`));
    });

    try {
      const formData = new FormData();
      formData.append('chat_id', process.env.CHANNEL_ID);
      formData.append('caption', caption || fileName);
      
      // 直接使用传入的 fileStream
      formData.append('document', fileStream, { filename: fileName });

      const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
          headers: formData.getHeaders() 
      });

      if (res.data.ok) {
          const result = res.data.result;
          const fileData = result.document || result.video || result.audio || result.photo;

          if (fileData && fileData.file_id) {
              await data.addFile({
                message_id: result.message_id,
                fileName,
                mimetype: fileData.mime_type || mimetype,
                size: fileData.file_size,
                file_id: fileData.file_id,
                thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
                date: Date.now(),
              }, folderId, userId, 'telegram');
              resolve({ success: true, data: res.data, fileId: result.message_id });
          } else {
             // 这种情况理论上不应该发生，但作为保障
             reject(new Error('Telegram API 返回成功，但未找到文件资料。'));
          }
      } else {
        // 处理 Telegram 返回的特定错误讯息
        reject(new Error(`Telegram API 错误: ${res.data.description || '未知错误'}`));
      }
    } catch (error) {
      const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
      // 在发生错误时，确保消耗掉流以防止请求挂起
      fileStream.resume(); 
      reject(new Error(`上传失败: ${errorDescription}`));
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
