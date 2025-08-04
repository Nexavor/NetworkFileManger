// storage/local.js

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js'); // 依赖 data.js 来获取路径

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

// 启动时确保根上传目录存在
async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log('[Local Storage] 上传目录已确认存在:', UPLOAD_DIR);
    } catch (e) {
        console.error('[Local Storage] 建立上传目录失败:', e);
    }
}
setup();

// *** 关键修正: 将 upload 函数的第一个参数从 tempFilePath 改为 fileBuffer ***
async function upload(fileBuffer, fileName, mimetype, userId, folderId) {
    console.log(`[Local Storage] 开始处理上传: ${fileName} (来自记忆体 Buffer)`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 获取目标资料夾的完整相对路径
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    // 建立目标目录
    console.log(`[Local Storage] 确保目标目录存在: ${finalFolderPath}`);
    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/'); // 储存相对路径
    console.log(`[Local Storage] 最终档案路径: ${finalFilePath}`);

    // *** 核心修改：直接将 Buffer 写入档案 ***
    await fs.writeFile(finalFilePath, fileBuffer);
    console.log(`[Local Storage] 档案从 Buffer 写入磁碟完成: ${fileName}`);
    
    const size = fileBuffer.length;
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    
    console.log(`[Local Storage] 正在将档案资讯写入资料库: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: size,
        file_id: relativeFilePath, // **关键：现在储存的是相对路径**
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');
    
    console.log(`[Local Storage] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}
