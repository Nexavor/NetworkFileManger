// storage/local.js
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto'); // 确保引入 crypto

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

async function setup() {
    try { await fsp.mkdir(UPLOAD_DIR, { recursive: true }); } catch (e) {}
}
setup();

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
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
            await data.updateFile(existingItem.message_id, {
                mimetype: mimetype,
                file_id: relativeFilePath,
                size: size,
                date: Date.now(),
            }, userId);
            return { success: true, message: '覆盖成功', fileId: existingItem.message_id };
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
            await fsp.writeFile(finalFilePath, fileStreamOrBuffer);
            const stats = await fsp.stat(finalFilePath);
            return await updateDatabase(stats.size);
        } catch (err) {
            throw err;
        }
    } else {
        // 2. 处理 Stream (来自流式模式或缓冲模式的大文件)
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(finalFilePath);
            const fileStream = fileStreamOrBuffer; 

            // 安全检查
            if (typeof fileStream.pipe !== 'function') {
                 return reject(new Error('输入不是有效的流或 Buffer'));
            }

            fileStream.on('error', err => {
                writeStream.close();
                fs.unlink(finalFilePath, () => {});
                reject(err);
            });

            writeStream.on('finish', async () => {
                try {
                    const stats = await fsp.stat(finalFilePath);
                    
                    const result = await updateDatabase(stats.size);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });

            writeStream.on('error', err => {
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
            if (fs.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fsp.unlink(filePath);
            }
        } catch (error) {
            results.errors.push(`删除文件失败: ${error.message}`);
            results.success = false;
        }
    }

    // 本地文件夹删除仅在物理删除时进行
    // 注意：如果是软删除，folders 数组可能为空，这里不会执行
    for (const folder of folders) {
        try {
            const folderPath = path.join(userDir, folder.path);
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

// --- 新增 Copy 功能 ---
async function copy(file, newRelativePath, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const oldPath = path.join(userDir, file.file_id);
    
    // data.js 会计算好包含目标文件夹路径的 newRelativePath
    const newPath = path.join(userDir, newRelativePath);
    
    // 确保目标目录存在
    await fsp.mkdir(path.dirname(newPath), { recursive: true });
    
    // 执行物理复制
    await fsp.copyFile(oldPath, newPath);
    
    return newRelativePath;
}

module.exports = { upload, remove, getUrl, stream, copy, type: 'local' };
