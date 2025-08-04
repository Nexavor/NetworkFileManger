require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
const fs = require('fs');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

/**
 * [重构] 使用流式上传档案到 Telegram。
 * @param {string} tempFilePath - Multer 暂存盘案的完整路径。
 * @param {string} fileName - 档案的原始名称。
 * @param {string} mimetype - 档案的MIME类型。
 * @param {number} userId - 使用者ID。
 * @param {number} folderId - 目标资料夹ID。
 * @param {string} [caption=''] - 附加说明文字。
 * @returns {Promise<object>} 上传结果。
 */
async function upload(tempFilePath, fileName, mimetype, userId, folderId, caption = '') {
  console.log(`[调试日志][Telegram] 开始处理档案上传: ${fileName}`);
  console.log(`[调试日志][Telegram] 暂存路径: ${tempFilePath}`);
  try {
    const formData = new FormData();
    formData.append('chat_id', process.env.CHANNEL_ID);
    formData.append('caption', caption || fileName);

    console.log(`[调试日志][Telegram] 从暂存盘建立档案读取流...`);
    const fileStream = fs.createReadStream(tempFilePath);

    // 将档案流添加到表单中，axios 将自动处理流式上传和分块编码
    formData.append('document', fileStream, { filename: fileName });

    console.log(`[调试日志][Telegram] 正在以流式方式发送档案到 Telegram API...`);
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, {
        headers: formData.getHeaders(),
        // 确保大档案有足够的时间上传
        timeout: 0, 
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    if (res.data.ok) {
        console.log(`[调试日志][Telegram] API 成功接收档案: ${fileName}`);
        const result = res.data.result;
        const fileData = result.document || result.video || result.audio || result.photo;

        if (fileData && fileData.file_id) {
            console.log(`[调试日志][Telegram] 档案 File ID: ${fileData.file_id}, Message ID: ${result.message_id}`);
            console.log(`[调试日志][Telegram] 正在将档案元资料写入资料库...`);
            await data.addFile({
              message_id: result.message_id,
              fileName,
              mimetype: fileData.mime_type || mimetype,
              size: fileData.file_size,
              file_id: fileData.file_id,
              thumb_file_id: result.video && result.video.thumb ? result.video.thumb.file_id : (fileData.thumb ? fileData.thumb.file_id : null),
              date: Date.now(),
            }, folderId, userId, 'telegram');
            console.log(`[调试日志][Telegram] 资料库写入成功: ${fileName}`);
            return { success: true, data: res.data, fileId: result.message_id };
        }
        // 如果 Telegram 返回成功但没有 file_id，记录错误
        console.error(`[调试日志][Telegram] Telegram API 返回成功，但缺少有效的 file_id。`, res.data);
        return { success: false, error: "Telegram API 返回的资料格式不正确。" };

    }
    // 如果 API 直接返回错误
    console.error(`[调试日志][Telegram] Telegram API 返回错误:`, res.data);
    return { success: false, error: res.data };
  } catch (error) {
    const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
    console.error(`[调试日志][Telegram] 上传过程中发生严重错误: ${errorDescription}`);
    return { success: false, error: { description: errorDescription }};
  }
}

async function remove(files, userId) {
    // 为保持功能完整性，保留此函数不变
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
  // 为保持功能完整性，保留此函数不变
  if (!file_id || typeof file_id !== 'string') return null;
  const cleaned_file_id = file_id.trim();
  try {
    const response = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: cleaned_file_id } });
    if (response.data.ok) return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${response.data.result.file_path}`;
  } catch (error) { console.error("获取文件链接失败:", error.response?.data?.description || error.message); }
  return null;
}

module.exports = { upload, remove, getUrl, type: 'telegram' };
