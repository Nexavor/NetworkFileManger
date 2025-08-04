require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// **最终版：upload 函数接收 fileStream**
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
    console.log(`[Telegram Storage] 开始处理纯流式上传: ${fileName}`);
    try {
        const formData = new FormData();
        formData.append('chat_id', process.env.CHANNEL_ID);
        formData.append('caption', caption || fileName);
        
        // **核心逻辑：直接将文件流附加到表单**
        formData.append('document', fileStream, { filename: fileName, contentType: mimetype });

        console.log(`[Telegram Storage] 正在发送档案流到 Telegram API...`);
        // **关键修改：设置 maxBodyLength 和 maxContentLength 为无限**
        // 并移除手动的 getHeaders()，让 axios 自动处理
        const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
            headers: formData.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        if (res.data.ok) {
            console.log(`[Telegram Storage] Telegram API 成功接收档案: ${fileName}`);
            const result = res.data.result;
            const fileData = result.document || result.video || result.audio || (result.photo && result.photo[result.photo.length - 1]);

            if (fileData && fileData.file_id) {
                await data.addFile({
                  message_id: result.message_id,
                  fileName,
                  mimetype: fileData.mime_type || mimetype,
                  size: fileData.file_size, // Telegram 会返回文件大小
                  file_id: fileData.file_id,
                  thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
                  date: Date.now(),
                }, folderId, userId, 'telegram');
                return { success: true, data: res.data, fileId: result.message_id };
            }
        }
        console.error(`[Telegram Storage] Telegram API 返回错误:`, res.data);
        throw new Error('Telegram API 返回失败或无效的回应。');
    } catch (error) {
        const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
        console.error(`[Telegram Storage] 上传过程中发生严重错误: ${errorDescription}`);
        throw new Error(`上传至 Telegram 失败: ${errorDescription}`);
    }
}


// --- 以下函数保持不变 ---

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
  } catch (error) { console.error("获取文件链接失败:", error.response?.data?.description || error.message); }
  return null;
}

module.exports = { upload, remove, getUrl, type: 'telegram' };
