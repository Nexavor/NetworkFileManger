const fsp = require('fs').promises;
const fs = require('fs'); // 从 fs/promises 改为直接引入 fs
const path = require('path');
const data = require('../data.js'); // 依赖 data.js 来获取路径

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

// 启动时确保根上传目录存在
async function setup() {
    try {
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
        // console.log('[Local Storage] 上传目录已确认存在:', UPLOAD_DIR);
    } catch (e) {
        // console.error('[Local Storage] 建立上传目录失败:', e);
    }
}
setup();

// **重构：上传逻辑**
// 现在改为纯流式上传，直接接收 fileStream
async function upload(fileStream, fileName, mimetype, userId, folderId) {
    // console.log(`[Local Storage] 开始处理上传流: ${fileName}`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 获取目标资料夾的完整相对路径
    const folderPathParts = await data.getFolderPath(folderId, userId);
    // 从路径的第二部分开始组合，因为第一部分是根目录 '/'
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    // 建立目标目录
    // console.log(`[Local Storage] 确保目标目录存在: ${finalFolderPath}`);
    await fsp.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    // 储存相对路径时，确保使用 POSIX 风格的斜线
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');
    // console.log(`[Local Storage] 最终档案路径: ${finalFilePath}`);

    // **核心修改：直接将传入的流写入最终文件**
    await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(finalFilePath);
        
        fileStream.on('error', (err) => {
            // console.error(`[Local Storage] 读取来源档案流失败: ${fileName}`, err);
            reject(err);
        });
        writeStream.on('error', (err) => {
            // console.error(`[Local Storage] 写入最终档案流失败: ${finalFilePath}`, err);
            reject(err);
        });
        writeStream.on('finish', () => {
            // console.log(`[Local Storage] 档案流式传输完成: ${fileName}`);
            resolve();
        });
        
        fileStream.pipe(writeStream);
    });
    
    // 文件写入完成后，获取其大小
    const stats = await fsp.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    
    // console.log(`[Local Storage] 正在将档案资讯写入资料库: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: relativeFilePath, // **关键：现在储存的是相对路径**
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');
    
    // console.log(`[Local Storage] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}


// **重构：删除逻辑**
// 现在会删除实体档案，并清理空的父目录
async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set(); // 用于后续清理

    // 删除档案
    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id); // file_id 是相对路径
            if (fs.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fsp.unlink(filePath);
            }
        } catch (error) {
            const errorMessage = `删除本地文件 [${file.file_id}] 失败: ${error.message}`;
            results.errors.push(errorMessage);
            results.success = false;
        }
    }

    // 删除资料夹
    for (const folder of folders) {
        try {
            // folder.path 也是相对路径
            const folderPath = path.join(userDir, folder.path);
            if (fs.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fsp.rm(folderPath, { recursive: true, force: true });
            }
        } catch (error) {
            const errorMessage = `删除本地资料夹 [${folder.path}] 失败: ${error.message}`;
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    
    // 清理可能变为空的父目录
    for (const dir of parentDirs) {
        await removeEmptyDirsRecursive(dir, userDir);
    }
    
    return results;
}

// **修正：递回清理空目录的辅助函数**
async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        if (!fs.existsSync(directoryPath)) {
            return;
        }

        if (!directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;

        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fs.existsSync(currentPath)) {
            const files = await fsp.readdir(currentPath);
            if (files.length === 0) {
                await fsp.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break; 
            }
        }
    } catch (error) {
        // 忽略可能的竞态条件错误
    }
}

async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    return finalFilePath;
}

// **新增：为本地储存提供 stream 方法**
function stream(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fs.existsSync(finalFilePath)) {
        return fs.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
