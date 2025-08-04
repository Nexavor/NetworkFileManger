require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

/**
 * [重构] 使用档案流或 Buffer 上传到 Telegram。
 * @param {stream.Readable|Buffer} fileSource - 档案的资料流或 Buffer。
 * @param {string} fileName - 档案的原始名称。
 * @param {string} mimetype - 档案的MIME类型。
 * @param {number} userId - 使用者ID。
 * @param {number} folderId - 目标资料夹ID。
 * @param {string} [caption=''] - 附加说明文字。
 * @returns {Promise<object>} 上传结果。
 */
async function upload(fileSource, fileName, mimetype, userId, folderId, caption = '') {
  console.log(`[调试日志][Telegram] 开始处理档案上传: ${fileName}`);
  try {
    const formData = new FormData();
    formData.append('chat_id', process.env.CHANNEL_ID);
    formData.append('caption', caption || fileName);

    console.log(`[调试日志][Telegram] 将档案来源 (流或Buffer) 添加到表单中...`);
    formData.append('document', fileSource, { filename: fileName });

    console.log(`[调试日志][Telegram] 正在发送档案到 Telegram API...`);
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, {
        headers: formData.getHeaders(),
        timeout: 0, 
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    if (res.data.ok) {
        console.log(`[调试日志][Telegram] API 成功接收档案: ${fileName}`);
        const result = res.data.result;
        const fileData = result.document || result.video || result.audio || result.photo;

        if (fileData && fileData.file_id) {
            await data.addFile({
              message_id: result.message_id,
              fileName,
              mimetype: fileData.mime_type || mimetype,
              size: fileData.file_size,
              file_id: fileData.file_id,
              thumb_file_id: result.video && result.video.thumb ? result.video.thumb.file_id : (fileData.thumb ? fileData.thumb.file_id : null),
              date: Date.now(),
            }, folderId, userId, 'telegram');
            return { success: true, data: res.data, fileId: result.message_id };
        }
        return { success: false, error: "Telegram API 返回的资料格式不正确。" };

    }
    return { success: false, error: res.data };
  } catch (error) {
    const errorDescription = error.response ? (error.response.data.description || JSON.stringify(error.response.data)) : error.message;
    console.error(`[调试日志][Telegram] 上传过程中发生严重错误: ${errorDescription}`);
    return { success: false, error: { description: errorDescription }};
  }
}
