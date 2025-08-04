const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto');
const stream = require('stream');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.error('[致命错误] 建立上传目录失败:', e);
    }
}
setup();

/**
 * [重构] 使用流或 Buffer 将档案储存到本地伺服器。
 * @param {stream.Readable|Buffer} fileSource - 档案的资料流或 Buffer。
 * @param {string} fileName - 档案的原始名称。
 * @param {string} mimetype - 档案的MIME类型。
 * @param {number} userId - 使用者ID。
 * @param {number} folderId - 目标资料夹ID。
 * @returns {Promise<object>} 上传结果。
 */
async function upload(fileSource, fileName, mimetype, userId, folderId) {
    console.log(`[调试日志][Local] 开始处理本地上传: ${fileName}`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');

    // 如果来源是 Buffer，直接写入
    if (Buffer.isBuffer(fileSource)) {
        await fs.writeFile(finalFilePath, fileSource);
    } 
    // 如果来源是流，则进行管道传输
    else if (fileSource instanceof stream.Readable) {
        await new Promise((resolve, reject) => {
            const writeStream = fsSync.createWriteStream(finalFilePath);
            fileSource.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            fileSource.on('error', reject);
        });
    } else {
        throw new Error('不支援的上传来源类型');
    }
    
    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: relativeFilePath,
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');
    
    console.log(`[调试日志][Local] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}
