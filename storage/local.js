const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const data = require('../data.js');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const FILE_NAME = 'storage/local.js';
const MAX_PATH_LENGTH = 240; // 为安全起见，设定一个比大多数系统（255/260）略短的限制

const log = (level, func, message, ...args) => {};

async function setup() {
    try { await fsp.mkdir(UPLOAD_DIR, { recursive: true }); } catch (e) {}
}
setup();

async function upload(fileStream, originalFileName, mimetype, userId, folderId) {
    const FUNC_NAME = 'upload';
    
    const userBaseDir = path.join(UPLOAD_DIR, String(userId));
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    
    let safeFileName = originalFileName;
    const finalFolderAbsPath = path.join(userBaseDir, relativeFolderPath);
    const originalFileAbsPath = path.join(finalFolderAbsPath, originalFileName);

    // --- 关键修正：检查最终的绝对路径长度 ---
    if (originalFileAbsPath.length > MAX_PATH_LENGTH) {
        const ext = path.extname(originalFileName);
        const hash = crypto.createHash('sha1').update(originalFileName).digest('hex').substring(0, 16);
        safeFileName = `${hash}${ext}`;
        log('WARN', FUNC_NAME, `路径过长，文件名 "${originalFileName}" 被哈希为 "${safeFileName}"`);
    }

    const finalFileAbsPath = path.join(finalFolderAbsPath, safeFileName);
    const safeStoragePath = path.join(relativeFolderPath, safeFileName).replace(/\\/g, '/');

    await fsp.mkdir(finalFolderAbsPath, { recursive: true });

    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(finalFileAbsPath);

        fileStream.on('error', err => {
            writeStream.close();
            reject(err);
        });
        
        writeStream.on('finish', async () => {
            try {
                const stats = await fsp.stat(finalFileAbsPath);
                const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
                
                const dbResult = await data.addFile({
                    message_id: messageId,
                    originalFileName: originalFileName,
                    mimetype,
                    size: stats.size,
                    safeStoragePath: safeStoragePath,
                    thumb_file_id: null,
                    date: Date.now(),
                }, folderId, userId, 'local');
                
                resolve({ success: true, message: '文件已储存至本地。', fileId: dbResult.fileId });
            } catch (err) {
                 reject(err);
            }
        });
        writeStream.on('error', err => reject(err));
        
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
            results.errors.push(`删除本地文件 [${file.file_id}] 失败: ${error.message}`);
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
        if (!fs.existsSync(directoryPath) || !directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) {
            return;
        }
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
    } catch (error) {}
}

async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    return finalFilePath;
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
