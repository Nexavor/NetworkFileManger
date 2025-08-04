require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
const fs = require('fs'); 

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// *** 核心修改：upload 函数现在直接接收档案流 (fileStream) 和一个获取大小的函式 (getFileSize) ***
async function upload(fileStream, fileName, mimetype, getFileSize, userId, folderId, caption = '') {
  console.log(`[Telegram Storage] 开始以流式上传档案: ${fileName}`);
  try {
    const formData = new FormData();
    formData.append('chat_id', process.env.CHANNEL_ID);
    formData.append('caption', caption || fileName);
    
    // **直接将档案流添加到表单中，而不是从路径读取**
    console.log(`[Telegram Storage] 将档案流 ${fileName} 添加到 FormData`);
    formData.append('document', fileStream, { filename: fileName, contentType: mimetype });

    console.log(`[Telegram Storage] 正在发送档案到 Telegram API...`);
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
        headers: formData.getHeaders() 
    });

    // 档案大小只有在流传输结束后才能确定
    const finalSize = getFileSize();
    console.log(`[Telegram Storage] 档案流传输完成，最终大小: ${finalSize} bytes`);

    if (res.data.ok) {
        console.log(`[Telegram Storage] Telegram API 成功接收档案: ${fileName}`);
        const result = res.data.result;
        const fileData = result.document || result.video || result.audio || result.photo;

        if (fileData && fileData.file_id) {
            console.log(`[Telegram Storage] 正在将档案资讯写入资料库, File ID: ${fileData.file_id}`);
            await data.addFile({
              message_id: result.message_id,
              fileName,
              mimetype: fileData.mime_type || mimetype,
              // **使用从流计算出的最终大小**
              size: fileData.file_size || finalSize,
              file_id: fileData.file_id,
              thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
              date: Date.now(),
            }, folderId, userId, 'telegram');
            console.log(`[Telegram Storage] 资料库写入成功: ${fileName}`);
            return { success: true, data: res.data, fileId: result.message_id };
        }
    }
    console.error(`[Telegram Storage] Telegram API 返回错误:`, res.data);
    return { success: false, error: res.data };
  } catch (error) {
    const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
    console.error(`[Telegram Storage] 上传过程中发生严重错误: ${errorDescription}`);
    // 如果档案流被中断，确保它被正确处理
    if (!fileStream.destroyed) {
        fileStream.destroy();
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
            if (reason && reason.includes("message to delete not found")) {
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
  } catch (error) { console.error("获取文件链接失败:", error.response?.data?.description || error.message); }
  return null;
}

module.exports = { upload, remove, getUrl, type: 'telegram' };
