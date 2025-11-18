// storage/local.js
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');

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

async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `上传开始: "${fileName}"`);
    
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fsp.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');

    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(finalFilePath);

        fileStream.on('error', err => {
            log('ERROR', FUNC_NAME, `输入流错误: ${err.message}`);
            writeStream.close();
            fs.unlink(finalFilePath, () => {});
            reject(err);
        });

        writeStream.on('finish', async () => {
            try {
                const stats = await fsp.stat(finalFilePath);
                log('DEBUG', FUNC_NAME, `写入完成: Size=${stats.size}`);
                
                if (stats.size === 0) {
                     log('WARN', FUNC_NAME, `文件大小为0，可能上传失败`);
                }

                if (existingItem) {
                    await data.updateFile(existingItem.id, {
                        mimetype: mimetype,
                        file_id: relativeFilePath,
                        size: stats.size,
                        date: Date.now(),
                    }, userId);
                    resolve({ success: true, message: '覆盖成功', fileId: existingItem.id });
                } else {
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
                    resolve({ success: true, message: '上传成功', fileId: dbResult.fileId });
                }
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

function stream(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fs.existsSync(finalFilePath)) {
        return fs.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
