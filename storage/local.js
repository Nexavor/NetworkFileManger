// storage/local.js
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto'); // 确保引入 crypto

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const FILE_NAME = 'storage/local.js';

const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [LOCAL:${level}] [${func}] - ${message}`, ...args);
};

async function setup() {
    try { await fsp.mkdir(UPLOAD_DIR, { recursive: true }); } catch (e) {}
}
setup();

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `上传开始: "${fileName}"`);
    
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fsp.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');

    // --- 封装数据库更新逻辑 ---
    const updateDatabase = async (size) => {
        if (existingItem) {
            await data.updateFile(existingItem.id, {
                mimetype: mimetype,
                file_id: relativeFilePath,
                size: size,
                date: Date.now(),
            }, userId);
            return { success: true, message: '覆盖成功', fileId: existingItem.id };
        } else {
            // 修正：使用 BigInt 生成 ID，与 server.js 保持一致
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: size,
                file_id: relativeFilePath,
                thumb_file_id: null,
                date: Date.now(),
            }, folderId, userId, 'local');
            return { success: true, message: '上传成功', fileId: dbResult.fileId };
        }
    };

    // --- 核心修复：判断输入是 Buffer 还是 Stream ---
    if (Buffer.isBuffer(fileStreamOrBuffer)) {
        // 1. 处理 Buffer (来自缓冲模式的小文件)
        try {
            log('DEBUG', FUNC_NAME, `检测到 Buffer 输入, 大小: ${fileStreamOrBuffer.length} bytes`);
            await fsp.writeFile(finalFilePath, fileStreamOrBuffer);
            const stats = await fsp.stat(finalFilePath);
            return await updateDatabase(stats.size);
        } catch (err) {
            log('ERROR', FUNC_NAME, `Buffer 写入失败: ${err.message}`);
            throw err;
        }
    } else {
        // 2. 处理 Stream (来自流式模式或缓冲模式的大文件)
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(finalFilePath);
            const fileStream = fileStreamOrBuffer; 

            // 安全检查
            if (typeof fileStream.pipe !== 'function') {
                 const msg = '输入不是有效的流或 Buffer';
                 log('ERROR', FUNC_NAME, msg);
                 return reject(new Error(msg));
            }

            fileStream.on('error', err => {
                log('ERROR', FUNC_NAME, `输入流错误: ${err.message}`);
                writeStream.close();
                fs.unlink(finalFilePath, () => {});
                reject(err);
            });

            writeStream.on('finish', async () => {
                try {
                    const stats = await fsp.stat(finalFilePath);
                    log('DEBUG', FUNC_NAME, `流写入完成: Size=${stats.size}`);
                    
                    if (stats.size === 0) {
                        log('WARN', FUNC_NAME, `文件大小为0，可能上传失败`);
                    }
                    
                    const result = await updateDatabase(stats.size);
                    resolve(result);
                } catch (err) {
                    log('ERROR', FUNC_NAME, `DB更新失败: ${err.message}`);
                    reject(err);
                }
            });

            writeStream.on('error', err => {
                log('ERROR', FUNC_NAME, `写入流错误: ${err.message}`);
                fs.unlink(finalFilePath, () => {});
                reject(err);
            });
            
            fileStream.pipe(writeStream);
        });
    }
}

async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set();

    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id);
            // 简单的安全检查：确保路径在 userDir 内
            if (!filePath.startsWith(userDir)) {
                log('WARN', 'remove', `尝试删除越权文件: ${filePath}`);
                continue;
            }
            
            if (fs.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fsp.unlink(filePath);
            }
        } catch (error) {
            results.errors.push(`删除文件失败: ${error.message}`);
            results.success = false;
        }
    }

    for (const folder of folders) {
        try {
            // 安全检查：防止删除根目录或空路径
            if (!folder.path || folder.path === '/' || folder.path === '\\' || folder.path === '.') {
                log('WARN', 'remove', '阻止删除用户根目录');
                continue;
            }

            const folderPath = path.join(userDir, folder.path);
            
            // 再次检查：确保路径在 userDir 内且不是 userDir 本身
            if (!folderPath.startsWith(userDir) || folderPath === userDir) {
                log('WARN', 'remove', `尝试删除非法目录: ${folderPath}`);
                continue;
            }

            if (fs.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fsp.rm(folderPath, { recursive: true, force: true });
            }
        } catch (error) {
            results.errors.push(`删除目录失败: ${error.message}`);
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
        if (!fs.existsSync(directoryPath) || !directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;
        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fs.existsSync(currentPath)) {
            const files = await fsp.readdir(currentPath);
            if (files.length === 0) {
                await fsp.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else { break; }
        }
    } catch (error) {}
}

async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    return path.join(userDir, file_id);
}

function stream(file_id, userId, options) { 
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fs.existsSync(finalFilePath)) {
        return fs.createReadStream(finalFilePath, options);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
