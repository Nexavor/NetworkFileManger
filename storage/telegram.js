// storage/telegram.js

require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const data = require('../data.js');
const fs = require('fs'); // 引入 fs 模组

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// *** 关键修正: 将 upload 函数的第一个参数从 tempFilePath 改为 fileBuffer ***
async function upload(fileBuffer, fileName, mimetype, userId, folderId, caption = '') {
  console.log(`[Telegram Storage] 开始上传档案: ${fileName} (来自记忆体 Buffer)`);
  try {
    const formData = new FormData();
    formData.append('chat_id', process.env.CHANNEL_ID);
    formData.append('caption', caption || fileName);
    
    // *** 关键修正: 直接将 Buffer 附加到表单中 ***
    formData.append('document', fileBuffer, { filename: fileName });

    console.log(`[Telegram Storage] 正在发送档案到 Telegram API...`);
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, { 
        headers: formData.getHeaders() 
    });

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
              size: fileData.file_size,
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
    return { success: false, error: { description: errorDescription }};
  }
}
