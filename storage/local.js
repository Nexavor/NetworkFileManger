const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js'); // 依赖 data.js 来获取路径

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log('[Local Storage] 上传目录已确认存在:', UPLOAD_DIR);
    } catch (e) {
        console.error('[Local Storage] 建立上传目录失败:', e);
    }
}
setup();

// **最终修正：上传逻辑接收 tempFilePath (文件路径字符串)**
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    console.log(`[Local Storage] 开始处理档案: ${fileName} (来源: ${tempFilePath})`);
    
    try {
        const userDir = path.join(UPLOAD_DIR, String(userId));
        
        // 获取目标资料夹的完整相对路径
        const folderPathParts = await data.getFolderPath(folderId, userId);
        const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
        const finalFolderPath = path.join(userDir, relativeFolderPath);

        await fs.mkdir(finalFolderPath, { recursive: true });

        const finalFilePath = path.join(finalFolderPath, fileName);
        const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');
        console.log(`[Local Storage] 最终档案路径: ${finalFilePath}`);
        
        // **核心修正：从传入的 tempFilePath 移动或复制文件**
        // 使用 rename (移动) 是最高效的方式，因为它通常只是一个元数据操作
        await fs.rename(tempFilePath, finalFilePath);
        
        console.log(`[Local Storage] 档案移动完成: ${fileName}`);

        const stats = await fs.stat(finalFilePath);
        const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
        
        const dbResult = await data.addFile({
            message_id: messageId,
            fileName,
            mimetype,
            size: stats.size,
            file_id: relativeFilePath,
            thumb_file_id: null,
            date: Date.now(),
        }, folderId, userId, 'local');
        
        console.log(`[Local Storage] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
        return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };

    } catch (error) {
        console.error(`[Local Storage] 处理本地储存时发生错误: ${error.message}`);
        // 如果移动失败，尝试用流复制作为备用方案
        if (error.code === 'EXDEV') { 
            console.warn('[Local Storage] 跨装置移动失败，尝试使用流复制...');
            return await uploadByCopying(tempFilePath, fileName, mimetype, userId, folderId);
        }
        throw error; // 重新抛出其他错误
    }
}

// 备用函数：通过流复制来处理跨分区/跨设备移动文件的问题
async function uploadByCopying(tempFilePath, fileName, mimetype, userId, folderId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name));
    const finalFolderPath = path.join(userDir, relativeFolderPath);
    await fs.mkdir(finalFolderPath, { recursive: true });
    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');
    
    await new Promise((resolve, reject) => {
        const readStream = fsSync.createReadStream(tempFilePath);
        const writeStream = fsSync.createWriteStream(finalFilePath);
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        readStream.pipe(writeStream);
    });

    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName, mimetype, size: stats.size,
        file_id: relativeFilePath, thumb_file_id: null, date: Date.now(),
    }, folderId, userId, 'local');
    
    return { success: true, message: '文件已储存至本地(备用模式)。', fileId: dbResult.fileId };
}


// --- 以下函数保持不变 ---

async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set(); 

    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id);
            if (fsSync.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fs.unlink(filePath);
            }
        } catch (error) {
            results.errors.push(`删除本地文件 [${file.file_id}] 失败: ${error.message}`);
            results.success = false;
        }
    }

    for (const folder of folders) {
        try {
            const folderPath = path.join(userDir, folder.path);
            if (fsSync.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fs.rm(folderPath, { recursive: true, force: true });
            }
        } catch (error) {
            results.errors.push(`删除本地资料夹 [${folder.path}] 失败: ${error.message}`);
            results.success = false;
        }
    }
    
    for (const dir of parentDirs) {
        await removeEmptyDirsRecursive(dir, userDir);
    }
    
    return results;
}

async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        if (!fsSync.existsSync(directoryPath) || !directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) {
            return;
        }
        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fsSync.existsSync(currentPath)) {
            const files = await fs.readdir(currentPath);
            if (files.length === 0) {
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break;
            }
        }
    } catch (error) {}
}

async function getUrl(file_id, userId) {
    return path.join(UPLOAD_DIR, String(userId), file_id);
}

function stream(file_id, userId) {
    const finalFilePath = path.join(UPLOAD_DIR, String(userId), file_id);
    if (fsSync.existsSync(finalFilePath)) {
        return fsSync.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
