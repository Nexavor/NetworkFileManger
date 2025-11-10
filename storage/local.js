const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto'); // <-- 引入 crypto

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const FILE_NAME = 'storage/local.js';

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    // const timestamp = new Date().toISOString();
    // console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
};

async function setup() {
    try {
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (e) {}
}
setup();

// --- *** 重构 upload 函数 *** ---
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '', existingItem = null) { // <-- 接受 caption
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${fileName}" 到本地储存...`);
    
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fsp.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');

    // 1. 定义临时文件路径
    const tempFilePath = finalFilePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';

    return new Promise((resolve, reject) => {
        log('DEBUG', FUNC_NAME, `创建写入流到 (临时): "${tempFilePath}"`);
        const writeStream = fs.createWriteStream(tempFilePath); // 2. 写入临时文件

        fileStream.on('error', err => {
            log('ERROR', FUNC_NAME, `输入文件流 (fileStream) 发生错误 for "${fileName}":`, err);
            writeStream.close();
            fsp.unlink(tempFilePath).catch(e => {}); // 3. 清理失败的临时文件
            reject(err);
        });

        writeStream.on('pipe', () => {
            log('DEBUG', FUNC_NAME, `输入流已接入 (pipe) 写入流 for "${fileName}"`);
        });
        writeStream.on('drain', () => {
            log('DEBUG', FUNC_NAME, `写入流 'drain' 事件触发 for "${fileName}"。可以继续写入。`);
        });

        writeStream.on('finish', async () => {
            log('INFO', FUNC_NAME, `文件写入磁盘完成 (finish): "${tempFilePath}"`);
            try {
                const stats = await fsp.stat(tempFilePath);
                
                // --- *** 关键修正：保留共享连结 *** ---
                if (existingItem) {
                    // 这是 UPDATE 逻辑
                    log('DEBUG', FUNC_NAME, `覆盖 (Update) 模式: 正在更新数据库条目 (ID: ${existingItem.id})`);

                    // 1. 获取旧文件路径，以便稍后清理
                    const oldRelativePath = existingItem.file_id;
                    const oldFinalPath = path.join(userDir, oldRelativePath);

                    // 2. 原子化移动临时文件到最终位置（覆盖）
                    await fsp.rename(tempFilePath, finalFilePath);
                    log('DEBUG', FUNC_NAME, `临时文件已移动到: "${finalFilePath}"`);
                    
                    // 3. 更新数据库 (UPDATE)
                    await data.updateFile(existingItem.id, userId, {
                        fileName: fileName, // <-- 允许档名变更
                        size: stats.size,
                        file_id: relativeFilePath,
                        mimetype: mimetype,
                        date: Date.now(),
                    });
                    
                    // 4. (清理) 如果档名变了，删除旧的实体档案
                    if (oldFinalPath !== finalFilePath && fs.existsSync(oldFinalPath)) {
                        log('DEBUG', FUNC_NAME, `档名已变更，正在删除旧的实体档案: "${oldFinalPath}"`);
                        await fsp.unlink(oldFinalPath).catch(e => {
                            log('WARN', FUNC_NAME, `删除旧档案 ${oldFinalPath} 失败: ${e.message}`);
                        });
                    }

                    log('INFO', FUNC_NAME, `文件 "${fileName}" (ID: ${existingItem.id}) 已成功更新。`);
                    resolve({ success: true, fileId: existingItem.id }); // <-- 返回旧 ID
                } else {
                    // 这是 INSERT 逻辑 (新上传)
                    log('DEBUG', FUNC_NAME, '新上传模式: 正在新增数据库条目...');

                    // 1. 原子化移动
                    await fsp.rename(tempFilePath, finalFilePath);
                    log('DEBUG', FUNC_NAME, `临时文件已移动到: "${finalFilePath}"`);

                    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
                    
                    // 2. 新增数据库 (INSERT)
                    log('DEBUG', FUNC_NAME, `正在将文件资讯添加到资料库: "${fileName}"`);
                    const dbResult = await data.addFile({
                        message_id: messageId,
                        fileName,
                        mimetype,
                        size: stats.size,
                        file_id: relativeFilePath,
                        thumb_file_id: null,
                        date: Date.now(),
                    }, folderId, userId, 'local');
                    
                    log('INFO', FUNC_NAME, `文件 "${fileName}" 已成功存入资料库。`);
                    resolve({ success: true, message: '文件已储存至本地。', fileId: dbResult.fileId });
                }
                // --- *** 修正结束 *** ---

            } catch (err) {
                 log('ERROR', FUNC_NAME, `写入资料库或移动文件时发生错误 for "${fileName}":`, err);
                 fsp.unlink(tempFilePath).catch(e => {}); // 清理临时文件
                 reject(err);
            }
        });
        writeStream.on('error', err => {
            log('ERROR', FUNC_NAME, `写入流 (writeStream) 发生错误 for "${fileName}":`, err);
            fsp.unlink(tempFilePath).catch(e => {}); // 3. 清理失败的临时文件
            reject(err);
        });
        
        log('DEBUG', FUNC_NAME, `正在将输入流 pipe 到写入流 for "${fileName}"`);
        fileStream.pipe(writeStream);
    });
}
// --- *** upload 函数重构结束 *** ---


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
