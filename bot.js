require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('./data.js');
const path = require('path'); // 新增引用

// 新增：文件名截断函数
function truncateFilename(filename, maxLength = 200) {
    if (filename.length <= maxLength) {
        return filename;
    }
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    // 确保即使扩展名很长，我们也不会得到负数的可用长度
    const availableLength = maxLength - ext.length - 1; // 减去1以防万一
    if (availableLength <= 0) {
        // 如果扩展名本身就超长，则截断整个文件名
        return filename.substring(filename.length - maxLength);
    }
    const truncatedBaseName = baseName.substring(0, availableLength);
    return truncatedBaseName + ext;
}


async function sendFile(fileBuffer, fileName, mimetype, caption = '', folderId = 1) {
  try {
    const formData = new FormData();
    const safeFileName = truncateFilename(fileName); // 截断文件名以符合API限制
    formData.append('chat_id', process.env.CHANNEL_ID);
    formData.append('caption', caption || fileName); // Caption 保持原始完整名称
    formData.append('document', fileBuffer, { filename: safeFileName }); // 使用安全的文件名
    
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { headers: formData.getHeaders() });

    if (res.data.ok) {
        const result = res.data.result;
        const fileData = result.document || result.video || result.audio || result.photo;

        if (fileData && fileData.file_id) {
            // 这是确保新档案能撷取到 thumb_file_id 的关键
            // 数据库中仍然储存原始的完整文件名
            await data.addFile({
              fileName,
              mimetype: fileData.mime_type || mimetype,
              message_id: result.message_id,
              file_id: fileData.file_id,
              thumb_file_id: fileData.thumb ? fileData.thumb.file_id : null,
              date: Date.now(),
            }, folderId);
            return { success: true, data: res.data };
        }
    }
    return { success: false, error: res.data };
  } catch (error) {
    const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
    return { success: false, error: { description: errorDescription }};
  }
}

async function deleteMessages(messageIds) {
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
        await data.deleteFilesByIds(results.success);
    }
    
    return results;
}

async function getFileLink(file_id) {
  if (!file_id || typeof file_id !== 'string') return null;
  const cleaned_file_id = file_id.trim();
  try {
    const response = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: cleaned_file_id } });
    if (response.data.ok) return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${response.data.result.file_path}`;
  } catch (error) { /* console.error("获取文件链接失败:", error.response?.data?.description || error.message); */ }
  return null;
}

module.exports = { sendFile, deleteMessages, getFileLink };
