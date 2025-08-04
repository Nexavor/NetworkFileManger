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

// **最终修正：上传逻辑直接接收 fileStream**
async function upload(fileStream, fileName, mimetype, userId, folderId) {
    console.log(`[Local Storage] 开始处理流式上传: ${fileName}`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 获取目标资料夹的完整相对路径
    const folderPathParts = await data.getFolderPath(folderId, userId);
    // 从根目录开始构建相对路径
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');
    console.log(`[Local Storage] 最终档案路径: ${finalFilePath}`);

    const writeStream = fsSync.createWriteStream(finalFilePath);
    let size = 0;

    // 监听数据块来计算文件大小
    fileStream.on('data', (chunk) => {
        size += chunk.length;
    });

    // **核心逻辑：使用 Promise 来等待管道完成**
    await new Promise((resolve, reject) => {
        // 捕获所有潜在的错误
        fileStream.on('error', (err) => {
            console.error(`[Local Storage] 读取来源流时发生错误: ${fileName}`, err);
            reject(err);
        });
        writeStream.on('error', (err) => {
            console.error(`[Local Storage] 写入目标流时发生错误: ${finalFilePath}`, err);
            reject(err);
        });
        writeStream.on('finish', resolve); // 当所有数据都已写入时
        
        // 开始管道传输
        fileStream.pipe(writeStream);
    });
    
    console.log(`[Local Storage] 档案流式传输完成: ${fileName}, 大小: ${size} bytes`);
    
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: size, // 使用流传输过程中计算的大小
        file_id: relativeFilePath,
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');
    
    console.log(`[Local Storage] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
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
