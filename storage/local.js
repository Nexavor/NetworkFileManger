const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

// 启动时确保根上传目录存在
async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log('[调试日志][Local] 上传目录已确认存在:', UPLOAD_DIR);
    } catch (e) {
        console.error('[调试日志][Local] 建立上传目录失败:', e);
    }
}
setup();


/**
 * [重构] 使用流式传输将档案储存到本地伺服器。
 * @param {string} tempFilePath - Multer 暂存盘案的完整路径。
 * @param {string} fileName - 档案的原始名称。
 * @param {string} mimetype - 档案的MIME类型。
 * @param {number} userId - 使用者ID。
 * @param {number} folderId - 目标资料夹ID。
 * @returns {Promise<object>} 上传结果。
 */
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    console.log(`[调试日志][Local] 开始处理本地上传: ${fileName}`);
    console.log(`[调试日志][Local] 暂存路径: ${tempFilePath}`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 取得目标资料夹的完整相对路径
    const folderPathParts = await data.getFolderPath(folderId, userId);
    // 从路径中移除根目录'/'部分，以建立正确的相对路径
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    // 建立目标目录
    console.log(`[调试日志][Local] 确保目标目录存在: ${finalFolderPath}`);
    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/'); // 储存相对路径并统一分隔符
    console.log(`[调试日志][Local] 最终档案储存路径: ${finalFilePath}`);
    console.log(`[调试日志][Local] 资料库记录相对路径: ${relativeFilePath}`);

    // 使用流式传输移动档案，避免占用大量记忆体
    await new Promise((resolve, reject) => {
        const readStream = fsSync.createReadStream(tempFilePath);
        const writeStream = fsSync.createWriteStream(finalFilePath);
        
        readStream.on('error', (err) => {
            console.error(`[调试日志][Local] 读取暂存盘案流失败: ${tempFilePath}`, err);
            reject(err);
        });
        writeStream.on('error', (err) => {
            console.error(`[调试日志][Local] 写入最终档案流失败: ${finalFilePath}`, err);
            reject(err);
        });
        writeStream.on('finish', () => {
            console.log(`[调试日志][Local] 档案流式传输完成: ${fileName}`);
            resolve();
        });
        
        readStream.pipe(writeStream);
    });
    
    const stats = await fs.stat(finalFilePath);
    console.log(`[调试日志][Local] 取得档案状态成功, 大小: ${stats.size} bytes`);
    
    // 使用更可靠的方式产生唯一 ID
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    console.log(`[调试日志][Local] 正在将档案资讯写入资料库, Message ID: ${messageId}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: relativeFilePath, // 关键：现在储存的是相对路径
        thumb_file_id: null, // 本地储存没有原生缩图
        date: Date.now(),
    }, folderId, userId, 'local');
    
    console.log(`[调试日志][Local] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set(); 

    // 删除档案
    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id);
            if (fsSync.existsSync(filePath)) {
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
            const folderPath = path.join(userDir, folder.path);
            if (fsSync.existsSync(folderPath)) {
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

async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        if (!fsSync.existsSync(directoryPath)) {
            return;
        }

        if (!directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;

        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fsSync.existsSync(currentPath)) {
            const files = await fsp.readdir(currentPath);
            if (files.length === 0) {
                await fsp.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break;
            }
        }
    } catch (error) {
        // 忽略可能的竞争条件错误
    }
}

async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    return finalFilePath;
}

function stream(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fsSync.existsSync(finalFilePath)) {
        return fsSync.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
