// data.js (最终正式版 - 已修复启动错误)

const db = require('./database.js');
const fsp = require('fs').promises;
// --- *** 关键修正：修复启动错误 *** ---
const path = require('path');
// --- *** 修正结束 *** ---
const storageManager = require('./storage');
const bcrypt = require('bcrypt');
// --- *** 关键修正：为资料夹导航载入加密函数 *** ---
const { encrypt } = require('./crypto.js');

const FILE_NAME = 'data.js';

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    // const timestamp = new Date().toISOString();
    // console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
};

async function findUserByName(username) {
    const FUNC_NAME = 'findUserByName';
    log('DEBUG', FUNC_NAME, `正在依名称寻找使用者: ${username}`);
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (err) {
                log('ERROR', FUNC_NAME, `查询使用者 ${username} 时出错:`, err);
                return reject(err);
            }
            log('DEBUG', FUNC_NAME, `查询完成。 ${row ? '找到' : '未找到'} 使用者。`);
            resolve(row);
        });
    });
}

async function findUserById(id) {
    const FUNC_NAME = 'findUserById';
    log('DEBUG', FUNC_NAME, `正在依 ID 寻找使用者: ${id}`);
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
            if (err) {
                log('ERROR', FUNC_NAME, `查询使用者 ${id} 时出错:`, err);
                return reject(err);
            }
            log('DEBUG', FUNC_NAME, `查询完成。 ${row ? '找到' : '未找到'} 使用者。`);
            resolve(row);
        });
    });
}

async function createUser(username, hashedPassword) {
    const FUNC_NAME = 'createUser';
    log('INFO', FUNC_NAME, `正在建立新使用者: ${username}`);
    return new Promise((resolve, reject) => {
        db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashedPassword], function(err) {
            if (err) {
                log('ERROR', FUNC_NAME, `建立使用者 ${username} 失败:`, err);
                return reject(err);
            }
            log('INFO', FUNC_NAME, `使用者 ${username} 建立成功, ID: ${this.lastID}`);
            resolve({ id: this.lastID, username, is_admin: 0 });
        });
    });
}

async function listNormalUsers() {
    const FUNC_NAME = 'listNormalUsers';
    log('DEBUG', FUNC_NAME, '正在列出所有一般使用者 (is_admin = 0)');
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username FROM users WHERE is_admin = 0", (err, rows) => {
            if (err) {
                log('ERROR', FUNC_NAME, '查询一般使用者列表失败:', err);
                return reject(err);
            }
            log('DEBUG', FUNC_NAME, `查询成功，找到 ${rows.length} 个一般使用者。`);
            resolve(rows);
        });
    });
}

async function listAllUsers() {
    const FUNC_NAME = 'listAllUsers';
    log('DEBUG', FUNC_NAME, '正在列出所有使用者');
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username, is_admin FROM users", (err, rows) => {
            if (err) {
                log('ERROR', FUNC_NAME, '查询所有使用者列表失败:', err);
                return reject(err);
            }
            log('DEBUG', FUNC_NAME, `查询成功，找到 ${rows.length} 个使用者。`);
            resolve(rows);
        });
    });
}

async function deleteUser(userId) {
    const FUNC_NAME = 'deleteUser';
    log('INFO', FUNC_NAME, `准备删除使用者 ID: ${userId}`);
    const storage = storageManager.getStorage();

    try {
        log('DEBUG', FUNC_NAME, `开始资料库事务 (Transaction) for user ${userId}`);
        await db.run('BEGIN');

        log('DEBUG', FUNC_NAME, `正在收集使用者 ${userId} 的所有资料夹...`);
        const folders = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM folders WHERE user_id = ?", [userId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });

        log('DEBUG', FUNC_NAME, `正在收集使用者 ${userId} 的所有档案...`);
        const files = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM files WHERE user_id = ?", [userId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });

        // 1. 删除实体档案/资料夹 (如果储存后端支援)
        if (storage.type === 'local' || storage.type === 'webdav') {
            log('DEBUG', FUNC_NAME, `正在请求储存后端 (${storage.type}) 删除实体档案...`);
            const rootFolder = folders.find(f => f.parent_id === null);
            const folderPaths = [];
            if (rootFolder) {
                // 仅删除根目录，storage.remove 应该会递归处理
                folderPaths.push({ path: '/' }); 
            }
            
            await storage.remove(files, folderPaths, userId);
            
            // 特别处理：删除 Local 模式下的使用者根目录
            if (storage.type === 'local') {
                const userUploadDir = path.join(__dirname, 'data', 'uploads', String(userId));
                try {
                    await fsp.rm(userUploadDir, { recursive: true, force: true });
                    log('DEBUG', FUNC_NAME, `已删除本地使用者目录: ${userUploadDir}`);
                } catch (e) {
                    log('WARN', FUNC_NAME, `删除本地使用者目录 ${userUploadDir} 失败 (可能不存在): ${e.message}`);
                }
            }
        }
        // 注意: Telegram 模式下，档案会留在频道中

        log('DEBUG', FUNC_NAME, `正在从资料库删除使用者 ${userId} 的所有分享连结...`);
        await db.run("DELETE FROM shares WHERE user_id = ?", [userId]);
        
        log('DEBUG', FUNC_NAME, `正在从资料库删除使用者 ${userId} 的所有 auth_tokens...`);
        await db.run("DELETE FROM auth_tokens WHERE user_id = ?", [userId]);

        log('DEBUG', FUNC_NAME, `正在从资料库删除使用者 ${userId} 的所有档案...`);
        await db.run("DELETE FROM files WHERE user_id = ?", [userId]);

        log('DEBUG', FUNC_NAME, `正在从资料库删除使用者 ${userId} 的所有资料夹...`);
        await db.run("DELETE FROM folders WHERE user_id = ?", [userId]);

        log('DEBUG', FUNC_NAME, `正在从资料库删除使用者 ${userId} 本身...`);
        await db.run("DELETE FROM users WHERE id = ?", [userId]);

        log('DEBUG', FUNC_NAME, `提交 (Commit) 资料库事务 for user ${userId}`);
        await db.run('COMMIT');
        
        log('INFO', FUNC_NAME, `使用者 ${userId} 已成功删除。`);
        return { success: true, message: '使用者已成功删除。' };
    } catch (error) {
        log('ERROR', FUNC_NAME, `删除使用者 ${userId} 时发生错误，正在回滚 (Rollback)...`, error);
        await db.run('ROLLBACK');
        throw new Error(`删除使用者失败: ${error.message}`);
    }
}


async function changeUserPassword(userId, hashedPassword) {
    const FUNC_NAME = 'changeUserPassword';
    log('INFO', FUNC_NAME, `正在变更使用者 ID: ${userId} 的密码`);
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId], function(err) {
            if (err) {
                log('ERROR', FUNC_NAME, `变更使用者 ${userId} 密码失败:`, err);
                return reject(err);
            }
            if (this.changes === 0) {
                 log('WARN', FUNC_NAME, `尝试变更密码失败，找不到使用者 ID: ${userId}`);
                 return reject(new Error('找不到使用者'));
            }
            log('INFO', FUNC_NAME, `使用者 ${userId} 密码变更成功。`);
            resolve({ success: true, changes: this.changes });
        });
    });
}

async function createFolder(name, parentId, userId) {
    const FUNC_NAME = 'createFolder';
    log('INFO', FUNC_NAME, `正在建立资料夹 "${name}" in parent: ${parentId} for user: ${userId}`);
    return new Promise((resolve, reject) => {
        // 验证 parentId 是否存在且属于该使用者 (根目录 parentId 为 null)
        const checkParentSql = parentId === null 
            ? "SELECT 1" // 如果是根目录，跳过检查
            : "SELECT 1 FROM folders WHERE id = ? AND user_id = ?";
        const checkParams = parentId === null ? [] : [parentId, userId];

        db.get(checkParentSql, checkParams, (err, row) => {
            if (err) {
                 log('ERROR', FUNC_NAME, `验证父资料夹 ${parentId} 时出错:`, err);
                 return reject(new Error('验证父资料夹时出错'));
            }
            if (!row && parentId !== null) {
                 log('WARN', FUNC_NAME, `建立资料夹失败，父资料夹 ${parentId} 不存在或不属于使用者 ${userId}`);
                 return reject(new Error('父资料夾不存在或权限不足'));
            }

            // 插入新资料夹
            db.run("INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)", [name, parentId, userId], function(err) {
                if (err) {
                    log('ERROR', FUNC_NAME, `插入新资料夹 "${name}" 失败:`, err);
                    return reject(err);
                }
                log('INFO', FUNC_NAME, `资料夹 "${name}" 建立成功, ID: ${this.lastID}`);
                resolve({ id: this.lastID, name: name, type: 'folder' });
            });
        });
    });
}

// --- *** 重大修复 1 *** ---
async function getFolderContents(folderId, userId) {
    const FUNC_NAME = 'getFolderContents';
    log('DEBUG', FUNC_NAME, `正在获取资料夹内容: ${folderId} for user: ${userId}`);
    
    // 1. 获取资料夹
    const foldersPromise = new Promise((resolve, reject) => {
        db.all("SELECT id, name, is_locked FROM folders WHERE parent_id = ? AND user_id = ?", [folderId, userId], (err, rows) => {
            if (err) return reject(err);
            // 为每个资料夹添加类型和加密ID，供前端使用
            resolve(rows.map(r => ({ ...r, type: 'folder', encrypted_id: encrypt(r.id) })));
        });
    });
    
    // 2. 获取档案
    const filesPromise = new Promise((resolve, reject) => {
        db.all("SELECT * FROM files WHERE folder_id = ? AND user_id = ?", [folderId, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows.map(r => ({ ...r, type: 'file' })));
        });
    });
    
    const [folders, files] = await Promise.all([foldersPromise, filesPromise]);
    
    log('DEBUG', FUNC_NAME, `获取成功: ${folders.length} 个资料夹, ${files.length} 个档案。`);
    
    // 3. 以物件形式返回，而不是阵列
    return { folders, files };
}
// --- *** 修复 1 结束 *** ---

async function getFolderDetails(folderId, userId) {
    const FUNC_NAME = 'getFolderDetails';
    log('DEBUG', FUNC_NAME, `正在获取资料夹详细资讯: ${folderId} for user: ${userId}`);
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], (err, row) => {
            if (err) {
                log('ERROR', FUNC_NAME, `查询资料夹 ${folderId} 失败:`, err);
                return reject(err);
            }
            log('DEBUG', FUNC_NAME, `查询资料夹 ${folderId} ${row ? '成功' : '失败(未找到)'}。`);
            resolve(row);
        });
    });
}

async function getFolderPath(folderId, userId) {
    const FUNC_NAME = 'getFolderPath';
    log('DEBUG', FUNC_NAME, `正在递归获取资料夹路径: ${folderId} for user: ${userId}`);
    let pathArr = []; // <-- 修正：确保 path 变量在此处定义
    let currentId = folderId;
    while (currentId !== null) {
        const folder = await new Promise((resolve, reject) => {
            db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [currentId, userId], (err, row) => {
                if (err) return reject(err);
                resolve(row);
            });
        });
        if (!folder) {
            log('WARN', FUNC_NAME, `路径追踪中断：在 ${currentId} 找不到资料夹 (user: ${userId})`);
            break; // 找不到资料夹或权限不足
        }
        pathArr.unshift({ id: folder.id, name: folder.name });
        currentId = folder.parent_id;
    }
    log('DEBUG', FUNC_NAME, `路径获取成功，深度: ${pathArr.length}`);
    return pathArr;
}

async function getAllFolders(userId) {
    const FUNC_NAME = 'getAllFolders';
    log('DEBUG', FUNC_NAME, `正在获取使用者 ${userId} 的所有资料夹`);
    return new Promise((resolve, reject) => {
        db.all("SELECT id, name, parent_id FROM folders WHERE user_id = ?", [userId], (err, rows) => {
            if (err) {
                log('ERROR', FUNC_NAME, `获取使用者 ${userId} 的所有资料夹失败:`, err);
                return reject(err);
            }
            log('DEBUG', FUNC_NAME, `成功获取 ${rows.length} 个资料夹。`);
            resolve(rows);
        });
    });
}

async function getFilesByIds(ids, userId) {
    const FUNC_NAME = 'getFilesByIds';
    if (!ids || ids.length === 0) return [];
    log('DEBUG', FUNC_NAME, `正在获取档案 (IDs: ${ids.join(',')}) for user: ${userId}`);
    const placeholders = ids.map(() => '?').join(',');
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM files WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, userId], (err, rows) => {
            if (err) {
                 log('ERROR', FUNC_NAME, `获取档案 ${ids.join(',')} 失败:`, err);
                 return reject(err);
            }
            log('DEBUG', FUNC_NAME, `成功获取 ${rows.length} 个档案。`);
            resolve(rows);
        });
    });
}

async function getItemsByIds(ids, userId) {
    const FUNC_NAME = 'getItemsByIds';
    if (!ids || ids.length === 0) return [];
    log('DEBUG', FUNC_NAME, `正在获取项目 (IDs: ${ids.join(',')}) for user: ${userId}`);
    const placeholders = ids.map(() => '?').join(',');
    
    const filesPromise = new Promise((resolve, reject) => {
        db.all(`SELECT *, 'file' as type FROM files WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
    
    const foldersPromise = new Promise((resolve, reject) => {
        db.all(`SELECT *, 'folder' as type FROM folders WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
    
    const [files, folders] = await Promise.all([filesPromise, foldersPromise]);
    log('DEBUG', FUNC_NAME, `获取成功: ${folders.length} 个资料夹, ${files.length} 个档案。`);
    return [...folders, ...files];
}


// --- *** 重大修复 2 *** ---
async function getFilesRecursive(folderId, userId, currentPath = '') {
    const FUNC_NAME = 'getFilesRecursive';
    log('DEBUG', FUNC_NAME, `正在递归获取档案于: ${folderId} (Path: ${currentPath}) for user: ${userId}`);
    let files = [];
    
    // 1. 呼叫已修复的 getFolderContents
    const contents = await getFolderContents(folderId, userId);
    
    // 2. 迭代档案阵列
    for (const item of contents.files) {
        const itemPath = path.posix.join(currentPath, item.name);
        files.push({ ...item, path: itemPath });
    }
    
    // 3. 迭代资料夹阵列
    for (const item of contents.folders) {
        const itemPath = path.posix.join(currentPath, item.name);
        const nestedFiles = await getFilesRecursive(item.id, userId, itemPath);
        files = files.concat(nestedFiles);
    }
    
    return files;
}
// --- *** 修复 2 结束 *** ---

async function addFile(fileData, folderId, userId, storageType) {
    const FUNC_NAME = 'addFile';
    try {
        const { message_id, fileName, mimetype, size, file_id, thumb_file_id, date } = fileData;
        
        // 1. 验证 folderId 是否有效且属于该使用者
        const folder = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], (err, row) => {
                if (err) return reject(new Error('查询资料夾时出错: ' + err.message));
                if (!row) return reject(new Error('目标资料夹无效或权限不足'));
                resolve(row);
            });
        });

        // 2. 插入档案资料
        const result = await db.run(
            `INSERT INTO files 
             (message_id, fileName, mimetype, size, folder_id, user_id, file_id, thumb_file_id, date, storage_type) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [message_id, fileName, mimetype, size, folder.id, userId, file_id, thumb_file_id, date, storageType]
        );
        
        return { success: true, fileId: result.lastID };
    } catch (error) {
        log('ERROR', FUNC_NAME, `新增档案到资料库失败:`, error);
        throw error; 
    }
}

// --- *** 新增 updateFile 函数 (修复共享连结丢失BUG) *** ---
async function updateFile(fileId, userId, newFileInfo) {
    const FUNC_NAME = 'updateFile';
    log('DEBUG', FUNC_NAME, `开始更新档案 ID: ${fileId} for user: ${userId}`);
    
    try {
        const { fileName, size, file_id, mimetype, date, thumb_file_id, message_id } = newFileInfo;

        const fields = [];
        const params = [];

        // 只有在提供了值的情况下才更新栏位
        if (fileName !== undefined) { fields.push('fileName = ?'); params.push(fileName); }
        if (size !== undefined) { fields.push('size = ?'); params.push(size); }
        if (file_id !== undefined) { fields.push('file_id = ?'); params.push(file_id); }
        if (mimetype !== undefined) { fields.push('mimetype = ?'); params.push(mimetype); }
        if (date !== undefined) { fields.push('date = ?'); params.push(date); }
        if (thumb_file_id !== undefined) { fields.push('thumb_file_id = ?'); params.push(thumb_file_id); }
        if (message_id !== undefined) { fields.push('message_id = ?'); params.push(message_id); }

        if (fields.length === 0) {
            log('WARN', FUNC_NAME, `更新档案 ${fileId} 失败：没有提供任何栏位。`);
            return; // 没有要更新的
        }

        params.push(fileId, userId);
        
        const query = `UPDATE files SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`;
        
        log('DEBUG', FUNC_NAME, `执行 SQL: ${query}
 参数: ${JSON.stringify(params)}`);
        
        const result = await db.run(query, params);
        
        if (result.changes === 0) {
            log('WARN', FUNC_NAME, `更新档案 ${fileId} 时找不到匹配的行。`);
            throw new Error('找不到要更新的档案或权限不足。');
        }
        
        log('INFO', FUNC_NAME, `档案 ${fileId} 更新成功。`);
        return { success: true, changes: result.changes };
        
    } catch (error) {
        log('ERROR', FUNC_NAME, `更新档案 ${fileId} 到资料库失败:`, error);
        throw error;
    }
}
// --- *** updateFile 函数结束 *** ---

async function findFileInFolder(fileName, folderId, userId) {
    const FUNC_NAME = 'findFileInFolder';
    log('DEBUG', FUNC_NAME, `正在寻找档案 "${fileName}" in folder ${folderId} for user ${userId}`);
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT * FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?",
            [fileName, folderId, userId],
            (err, row) => {
                if (err) {
                    log('ERROR', FUNC_NAME, `寻找档案 "${fileName}" 时出错:`, err);
                    return reject(err);
                }
                log('DEBUG', FUNC_NAME, `寻找档案 "${fileName}" ${row ? '成功' : '失败(未找到)'}。`);
                resolve(row);
            }
        );
    });
}

async function findItemInFolder(name, folderId, userId) {
    const FUNC_NAME = 'findItemInFolder';
    log('DEBUG', FUNC_NAME, `正在寻找项目 "${name}" in folder ${folderId} for user ${userId}`);
    const file = await findFileInFolder(name, folderId, userId);
    if (file) return { ...file, type: 'file' };
    
    const folder = await new Promise((resolve, reject) => {
        db.get(
            "SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?",
            [name, folderId, userId],
            (err, row) => {
                if (err) return reject(err);
                resolve(row);
            }
        );
    });
    if (folder) return { ...folder, type: 'folder' };
    
    log('DEBUG', FUNC_NAME, `项目 "${name}" 在 folder ${folderId} 中未找到。`);
    return null;
}

async function checkFullConflict(name, folderId, userId) {
    const FUNC_NAME = 'checkFullConflict';
    log('DEBUG', FUNC_NAME, `正在检查完整冲突 "${name}" in folder ${folderId} for user ${userId}`);
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT 'file' as type FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
             UNION ALL
             SELECT 'folder' as type FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`,
            [name, folderId, userId, name, folderId, userId],
            (err, row) => {
                if (err) {
                     log('ERROR', FUNC_NAME, `检查冲突 "${name}" 时出错:`, err);
                     return reject(err);
                }
                log('DEBUG', FUNC_NAME, `检查冲突 "${name}" ${row ? `发现冲突 (type: ${row.type})` : '无冲突'}。`);
                resolve(row);
            }
        );
    });
}

async function findAvailableName(baseName, folderId, userId, isFolder) {
    const FUNC_NAME = 'findAvailableName';
    log('DEBUG', FUNC_NAME, `正在寻找可用名称，基础: "${baseName}" in folder ${folderId}`);
    let newName = baseName;
    let counter = 1;
    const extension = isFolder ? '' : path.extname(baseName);
    const nameWithoutExt = isFolder ? baseName : baseName.substring(0, baseName.length - extension.length);

    while (true) {
        const conflict = await checkFullConflict(newName, folderId, userId);
        if (!conflict) {
            log('DEBUG', FUNC_NAME, `找到可用名称: "${newName}"`);
            return newName;
        }
        newName = `${nameWithoutExt} (${counter})${extension}`;
        counter++;
        if (counter > 100) { // 防止无限回圈
             log('ERROR', FUNC_NAME, `无法为 "${baseName}" 找到可用名称 (已尝试 100 次)`);
             throw new Error("无法找到可用的档名");
        }
    }
}

async function getConflictingItems(items, targetFolderId, userId) {
    const FUNC_NAME = 'getConflictingItems';
    log('DEBUG', FUNC_NAME, `正在检查 ${items.length} 个项目移至 ${targetFolderId} 时的冲突`);
    const fileConflicts = [];
    const folderConflicts = [];

    for (const item of items) {
        const conflict = await checkFullConflict(item.name, targetFolderId, userId);
        if (conflict) {
            if (conflict.type === 'file') fileConflicts.push(item.name);
            if (conflict.type === 'folder') folderConflicts.push(item.name);
        }
    }
    log('DEBUG', FUNC_NAME, `冲突检查完成: ${fileConflicts.length} 个档案, ${folderConflicts.length} 个资料夹。`);
    return { fileConflicts, folderConflicts };
}


async function moveItem(itemId, itemType, targetFolderId, userId, options = {}) {
    const FUNC_NAME = 'moveItem';
    log('INFO', FUNC_NAME, `准备移动 ${itemType} ID: ${itemId} 至资料夹 ${targetFolderId} (User: ${userId})`);
    
    const { resolutions = {} } = options;
    const report = { moved: 0, skipped: 0, errors: 0 };

    try {
        let item;
        if (itemType === 'file') {
            item = (await getFilesByIds([itemId], userId))[0];
        } else {
            item = await getFolderDetails(itemId, userId);
        }

        if (!item) {
            log('WARN', FUNC_NAME, `移动失败：找不到 ${itemType} ID: ${itemId}`);
            report.errors++;
            return report;
        }

        // 1. 检查是否移动到自身
        if (itemType === 'folder' && item.id === targetFolderId) {
             log('WARN', FUNC_NAME, `移动失败：无法将资料夹 ${itemId} 移至其自身。`);
             report.errors++;
             return report;
        }
        
        // 2. 检查是否移动到自己的子资料夹
        if (itemType === 'folder') {
            const targetFolderPath = await getFolderPath(targetFolderId, userId);
            if (targetFolderPath.some(p => p.id === item.id)) {
                 log('WARN', FUNC_NAME, `移动失败：无法将资料夹 ${itemId} 移至其子资料夹 ${targetFolderId}`);
                 report.errors++;
                 return report;
            }
        }
        
        // 3. 检查是否已经在目标资料夹
        const parentIdKey = (itemType === 'file') ? 'folder_id' : 'parent_id';
        if (item[parentIdKey] === targetFolderId) {
             log('INFO', FUNC_NAME, `项目 ${itemId} 已在目标资料夹 ${targetFolderId}，跳过。`);
             report.skipped++;
             return report;
        }

        // 4. 检查名称冲突
        const conflict = await findItemInFolder(item.name, targetFolderId, userId);
        let action = 'move';
        if (conflict) {
            action = resolutions[item.name] || 'skip'; // 预设为跳过
            log('DEBUG', FUNC_NAME, `发现冲突: "${item.name}", 解决策略: ${action}`);
        }

        if (action === 'skip') {
            report.skipped++;
            return report;
        }
        
        if (action === 'overwrite') {
            if (conflict.type === itemType) {
                // 覆盖：删除目标项目
                log('DEBUG', FUNC_NAME, `覆盖: 正在删除目标 ${conflict.type} ID: ${conflict.id}`);
                await unifiedDelete(conflict.id, conflict.type, userId);
            } else {
                // 无法覆盖 (档案 vs 资料夹)
                 log('WARN', FUNC_NAME, `移动失败：无法用 ${itemType} 覆盖 ${conflict.type} ("${item.name}")`);
                 report.errors++;
                 return report;
            }
        }
        
        if (action === 'rename') {
            const newName = await findAvailableName(item.name, targetFolderId, userId, itemType === 'folder');
            log('DEBUG', FUNC_NAME, `重命名: "${item.name}" -> "${newName}"`);
            if (itemType === 'file') {
                await renameFile(item.id, newName, userId);
            } else {
                await renameFolder(item.id, newName, userId);
            }
            item.name = newName; // 更新本地物件以进行后续移动
        }

        // 5. 执行移动 (更新父 ID)
        if (itemType === 'file') {
            await db.run("UPDATE files SET folder_id = ? WHERE id = ? AND user_id = ?", [targetFolderId, item.id, userId]);
        } else {
            await db.run("UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?", [targetFolderId, item.id, userId]);
        }

        log('INFO', FUNC_NAME, `移动成功: ${itemType} ID: ${item.id} ("${item.name}") 移至 ${targetFolderId}`);
        report.moved++;
        return report;
        
    } catch (error) {
        log('ERROR', FUNC_NAME, `移动 ${itemType} ID: ${itemId} 时发生严重错误:`, error);
        report.errors++;
        return report;
    }
}


async function renameFile(fileId, newName, userId) {
    const FUNC_NAME = 'renameFile';
    log('INFO', FUNC_NAME, `准备重命名档案 ${fileId} 为 "${newName}" (User: ${userId})`);
    
    // 1. 获取档案资讯
    const file = (await getFilesByIds([fileId], userId))[0];
    if (!file) {
        log('WARN', FUNC_NAME, `重命名失败：找不到档案 ${fileId}`);
        throw new Error('找不到档案');
    }
    
    // 2. 检查新名称冲突
    const conflict = await checkFullConflict(newName, file.folder_id, userId);
    if (conflict) {
        log('WARN', FUNC_NAME, `重命名失败：名称 "${newName}" 已存在于资料夹 ${file.folder_id}`);
        throw new Error('名称已存在');
    }
    
    // 3. (仅 Local/WebDAV) 重命名实体档案
    const storage = storageManager.getStorage();
    let newFileId = file.file_id; // TG 模式下 file_id 不变
    
    if (storage.type === 'local' || storage.type === 'webdav') {
        const oldPath = file.file_id;
        const newPath = path.posix.join(path.posix.dirname(oldPath), newName);
        newFileId = newPath;
        
        try {
            if (storage.type === 'local') {
                const userDir = path.join(__dirname, 'data', 'uploads', String(userId));
                const oldLocalPath = path.join(userDir, oldPath);
                const newLocalPath = path.join(userDir, newPath);
                await fsp.rename(oldLocalPath, newLocalPath);
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldPath, newPath);
            }
            log('DEBUG', FUNC_NAME, `实体档案已重命名: "${oldPath}" -> "${newPath}"`);
        } catch (e) {
            log('ERROR', FUNC_NAME, `重命名实体档案 "${oldPath}" 失败:`, e);
            throw new Error(`重命名储存后端档案失败: ${e.message}`);
        }
    }
    
    // 4. 更新资料库
    try {
        await db.run(
            "UPDATE files SET fileName = ?, file_id = ? WHERE id = ? AND user_id = ?", 
            [newName, newFileId, fileId, userId]
        );
        log('INFO', FUNC_NAME, `资料库已更新：档案 ${fileId} 重命名为 "${newName}"`);
        return { success: true };
    } catch (dbError) {
         log('ERROR', FUNC_NAME, `更新资料库中的档案 ${fileId} 名称失败:`, dbError);
         // (回滚) 尝试将实体档案改回去
         if (storage.type === 'local' || storage.type === 'webdav') {
            try {
                if (storage.type === 'local') {
                    const userDir = path.join(__dirname, 'data', 'uploads', String(userId));
                    await fsp.rename(path.join(userDir, newPath), path.join(userDir, oldPath));
                } else if (storage.type === 'webdav') {
                    await storage.getClient().moveFile(newPath, oldPath);
                }
                 log('WARN', FUNC_NAME, `(回滚) 实体档案已从 "${newPath}" 恢复为 "${oldPath}"`);
            } catch(rollbackError) {
                 log('ERROR', FUNC_NAME, `(灾难) 资料库更新失败且实体档案回滚失败! 路径: "${newPath}"`);
            }
         }
         throw new Error(`更新资料库失败: ${dbError.message}`);
    }
}

async function renameFolder(folderId, newName, userId) {
    const FUNC_NAME = 'renameFolder';
    log('INFO', FUNC_NAME, `准备重命名资料夹 ${folderId} 为 "${newName}" (User: ${userId})`);

    // 1. 获取资料夹资讯
    const folder = await getFolderDetails(folderId, userId);
    if (!folder) {
        log('WARN', FUNC_NAME, `重命名失败：找不到资料夹 ${folderId}`);
        throw new Error('找不到资料夹');
    }
    // 无法重命名根目录
    if (folder.parent_id === null) {
        log('WARN', FUNC_NAME, '重命名失败：无法重命名根目录');
        throw new Error('无法重命名根目录');
    }
    
    // 2. 检查新名称冲突
    const conflict = await checkFullConflict(newName, folder.parent_id, userId);
    if (conflict) {
        log('WARN', FUNC_NAME, `重命名失败：名称 "${newName}" 已存在于资料夹 ${folder.parent_id}`);
        throw new Error('名称已存在');
    }

    const storage = storageManager.getStorage();

    // 3. (仅 Local/WebDAV) 重命名实体资料夹
    if (storage.type === 'local' || storage.type === 'webdav') {
        // 我们需要重新命名资料夹，这会影响其下所有子档案的 file_id
        await db.run('BEGIN');
        try {
            const folderPathParts = await getFolderPath(folderId, userId);
            const oldFolderPath = path.posix.join(...folderPathParts.slice(1).map(p => p.name));
            
            // 替换路径的最后一部分
            folderPathParts[folderPathParts.length - 1].name = newName; 
            const newFolderPath = path.posix.join(...folderPathParts.slice(1).map(p => p.name));
            
            // 3a. 重命名实体资料夹
            if (storage.type === 'local') {
                const userDir = path.join(__dirname, 'data', 'uploads', String(userId));
                const oldLocalPath = path.join(userDir, oldFolderPath);
                const newLocalPath = path.join(userDir, newFolderPath);
                
                // --- 修正：检查旧路径是否存在 ---
                const fs = require('fs'); // 引入 fs (sync)
                if (fs.existsSync(oldLocalPath)) {
                    await fsp.rename(oldLocalPath, newLocalPath);
                } else {
                    await fsp.mkdir(newLocalPath, { recursive: true });
                }
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                if (await client.exists(oldFolderPath)) {
                    await client.moveFile(oldFolderPath, newFolderPath);
                } else {
                    await storage.createDirectory(newFolderPath);
                }
            }
            log('DEBUG', FUNC_NAME, `实体资料夹已重命名: "${oldFolderPath}" -> "${newFolderPath}"`);
            
            // 3b. 更新资料库中的资料夹名称
            await db.run("UPDATE folders SET name = ? WHERE id = ? AND user_id = ?", [newName, folderId, userId]);
            
            // 3c. 递归更新所有子档案的 file_id
            log('DEBUG', FUNC_NAME, `正在递归更新子档案的 file_id...`);
            await db.run(
                `UPDATE files 
                 SET file_id = ? || SUBSTR(file_id, ?) 
                 WHERE file_id LIKE ? AND user_id = ?`,
                [newFolderPath + '/', oldFolderPath.length + 2, oldFolderPath + '/%', userId]
            );

            await db.run('COMMIT');
            log('INFO', FUNC_NAME, `资料夹 ${folderId} (及子档案) 重命名为 "${newName}" 成功。`);
            return { success: true };
            
        } catch (e) {
            await db.run('ROLLBACK');
            log('ERROR', FUNC_NAME, `重命名 (Local/WebDAV) 资料夹 ${folderId} 失败:`, e);
            throw new Error(`重命名储存后端资料夹失败: ${e.message}`);
        }
    } else {
        // 4. (仅 TG 模式) 只更新资料库
        try {
            await db.run("UPDATE folders SET name = ? WHERE id = ? AND user_id = ?", [newName, folderId, userId]);
            log('INFO', FUNC_NAME, `(TG模式) 资料夹 ${folderId} 重命名为 "${newName}" 成功。`);
            return { success: true };
        } catch (dbError) {
             log('ERROR', FUNC_NAME, `(TG模式) 更新资料库中的资料夹 ${folderId} 名称失败:`, dbError);
             throw new Error(`更新资料库失败: ${dbError.message}`);
        }
    }
}


async function deleteFilesByIds(dbIds, userId) {
    const FUNC_NAME = 'deleteFilesByIds';
    if (!dbIds || dbIds.length === 0) return;
    log('DEBUG', FUNC_NAME, `准备从资料库删除档案 (DB IDs): ${dbIds.join(',')} (User: ${userId})`);
    
    try {
        const placeholders = dbIds.map(() => '?').join(',');
        
        // 1. 删除关联的分享连结
        await db.run(`DELETE FROM shares WHERE item_id IN (${placeholders}) AND type = 'file' AND user_id = ?`, [...dbIds, userId]);
        
        // 2. 删除档案条目
        const result = await db.run(`DELETE FROM files WHERE id IN (${placeholders}) AND user_id = ?`, [...dbIds, userId]);
        
        log('INFO', FUNC_NAME, `成功从资料库删除 ${result.changes} 个档案条目。`);
    } catch (error) {
        log('ERROR', FUNC_NAME, `从资料库删除档案 (IDs: ${dbIds.join(',')}) 失败:`, error);
        throw new Error(`资料库档案删除失败: ${error.message}`);
    }
}

async function unifiedDelete(itemId, itemType, userId) {
    const FUNC_NAME = 'unifiedDelete';
    log('INFO', FUNC_NAME, `开始统一删除 ${itemType} ID: ${itemId} (User: ${userId})`);
    
    const storage = storageManager.getStorage();
    
    try {
        if (itemType === 'file') {
            const files = await getFilesByIds([itemId], userId);
            if (files.length === 0) {
                 log('WARN', FUNC_NAME, `找不到要删除的档案 ID: ${itemId}`);
                 return; // 找不到档案
            }
            
            // 1. (TG/Local/WebDAV) 删除实体档案
            // 注意: `storage.remove` 在 TG 模式下也会处理资料库删除 (deleteFilesByIds)
            // 但在 Local/WebDAV 模式下不会
            const removeResult = await storage.remove(files, [], userId);
            
            // 2. (仅 Local/WebDAV) 删除资料库条目
            if (storage.type === 'local' || storage.type === 'webdav') {
                if (removeResult.success) {
                    await deleteFilesByIds([itemId], userId);
                } else {
                     throw new Error(`删除实体档案失败: ${removeResult.errors.join(', ')}`);
                }
            }
            log('INFO', FUNC_NAME, `档案 ${itemId} 删除成功。`);

        } else if (itemType === 'folder') {
            const folder = await getFolderDetails(itemId, userId);
            if (!folder) {
                 log('WARN', FUNC_NAME, `找不到要删除的资料夹 ID: ${itemId}`);
                 return; // 找不到资料夹
            }
            if (folder.parent_id === null) {
                log('ERROR', FUNC_NAME, `拒绝删除根目录 ID: ${itemId}`);
                throw new Error("无法删除根目录");
            }
            
            await db.run('BEGIN');
            
            // 1. 递归收集所有子项目
            const folderPathParts = await getFolderPath(itemId, userId);
            const folderRelativePath = path.posix.join(...folderPathParts.slice(1).map(p => p.name));
            
            const filesToDelete = await getFilesRecursive(itemId, userId, folderRelativePath);
            const foldersToDelete = await (async function getSubFolders(fId) {
                let subs = [];
                const children = await new Promise((resolve, reject) => {
                     db.all("SELECT * FROM folders WHERE parent_id = ? AND user_id = ?", [fId, userId], (err, rows) => {
                         if (err) return reject(err);
                         resolve(rows);
                     });
                });
                for (const child of children) {
                    subs.push(child);
                    subs = subs.concat(await getSubFolders(child.id));
                }
                return subs;
            })(itemId);
            
            // 将自身加入待删列表
            foldersToDelete.push(folder);

            const fileDbIds = filesToDelete.map(f => f.id);
            const folderDbIds = foldersToDelete.map(f => f.id);
            const folderPaths = foldersToDelete.map(async f => {
                 const pParts = await getFolderPath(f.id, userId);
                 return { path: path.posix.join(...pParts.slice(1).map(p => p.name)) };
            });
            const folderPathObjects = await Promise.all(folderPaths);
            
            log('DEBUG', FUNC_NAME, `递归删除 ${itemId}: ${fileDbIds.length} 档案, ${folderDbIds.length} 资料夹`);

            // 2. (TG/Local/WebDAV) 删除实体档案/资料夹
            if (filesToDelete.length > 0 || folderPathObjects.length > 0) {
                 const removeResult = await storage.remove(filesToDelete, folderPathObjects, userId);
                 // (仅 Local/WebDAV)
                 if (storage.type === 'local' || storage.type === 'webdav') {
                     if (!removeResult.success) {
                         throw new Error(`删除实体项目失败: ${removeResult.errors.join(', ')}`);
                     }
                 }
            }

            // 3. 删除资料库条目 (所有模式)
            if (fileDbIds.length > 0) {
                await deleteFilesByIds(fileDbIds, userId);
            }
            if (folderDbIds.length > 0) {
                const folderPlaceholders = folderDbIds.map(() => '?').join(',');
                // 3a. 删除关联分享
                await db.run(`DELETE FROM shares WHERE item_id IN (${folderPlaceholders}) AND type = 'folder' AND user_id = ?`, [...folderDbIds, userId]);
                // 3b. 删除资料夹
                await db.run(`DELETE FROM folders WHERE id IN (${folderPlaceholders}) AND user_id = ?`, [...folderDbIds, userId]);
            }
            
            await db.run('COMMIT');
             log('INFO', FUNC_NAME, `资料夹 ${itemId} (及所有子项目) 删除成功。`);

        }
    } catch (error) {
         if (itemType === 'folder') await db.run('ROLLBACK');
         log('ERROR', FUNC_NAME, `统一删除 ${itemType} ID: ${itemId} 失败:`, error);
         throw error;
    }
}

async function isFileAccessible(fileId, userId, unlockedFolderIds = []) {
    const FUNC_NAME = 'isFileAccessible';
    log('DEBUG', FUNC_NAME, `检查档案 ${fileId} 存取权 for user ${userId}`);
    
    let file;
    try {
        file = (await getFilesByIds([fileId], userId))[0];
    } catch(e) { return false; }
    
    if (!file) {
        log('DEBUG', FUNC_NAME, `存取 ${fileId} 失败：档案不存在或不属于 user ${userId}`);
        return false;
    }

    let currentFolderId = file.folder_id;
    let checkedCount = 0;
    
    while (currentFolderId !== null) {
        if (checkedCount++ > 50) { // 防止无限回圈
             log('ERROR', FUNC_NAME, `检查存取权 ${fileId} 时路径过深 (超过 50 层)`);
             return false;
        }
        
        const folder = await getFolderDetails(currentFolderId, userId);
        if (!folder) {
             log('DEBUG', FUNC_NAME, `存取 ${fileId} 失败：路径上的资料夹 ${currentFolderId} 找不到`);
             return false;
        }
        
        if (folder.is_locked && !unlockedFolderIds.includes(folder.id)) {
            log('DEBUG', FUNC_NAME, `存取 ${fileId} 失败：资料夹 ${folder.id} ("${folder.name}") 已锁定`);
            return false;
        }
        
        currentFolderId = folder.parent_id;
    }
    
    log('DEBUG', FUNC_NAME, `存取 ${fileId} 成功。`);
    return true;
}

async function setFolderPassword(folderId, hashedPassword, userId) {
    const FUNC_NAME = 'setFolderPassword';
    const isLocked = hashedPassword !== null;
    log('INFO', FUNC_NAME, `正在设定资料夹 ${folderId} 锁定状态为: ${isLocked} (User: ${userId})`);
    return db.run(
        "UPDATE folders SET password = ?, is_locked = ? WHERE id = ? AND user_id = ?",
        [hashedPassword, isLocked ? 1 : 0, folderId, userId]
    );
}

async function verifyFolderPassword(folderId, password, userId) {
    const FUNC_NAME = 'verifyFolderPassword';
    log('DEBUG', FUNC_NAME, `正在验证资料夹 ${folderId} 密码 (User: ${userId})`);
    const folder = await getFolderDetails(folderId, userId);
    if (!folder) {
         log('WARN', FUNC_NAME, `验证 ${folderId} 失败：找不到资料夹。`);
         return false;
    }
    if (!folder.is_locked || !folder.password) {
         log('DEBUG', FUNC_NAME, `验证 ${folderId} 失败：资料夹未锁定。`);
         return false;
    }
    const isMatch = await bcrypt.compare(password, folder.password);
    log('DEBUG', FUNC_NAME, `验证 ${folderId} ${isMatch ? '成功' : '失败'}`);
    return isMatch;
}

// --- *** 重大修复 3 *** ---
async function searchItems(query, userId) {
    const FUNC_NAME = 'searchItems';
    log('DEBUG', FUNC_NAME, `正在搜寻 "${query}" for user ${userId}`);
    const searchTerm = `%${query}%`;
    
    // 1. 搜寻资料夹
    const foldersPromise = new Promise((resolve, reject) => {
        db.all("SELECT id, name, is_locked FROM folders WHERE name LIKE ? AND user_id = ? AND parent_id IS NOT NULL", [searchTerm, userId], (err, rows) => {
            if (err) return reject(err);
            // 为每个资料夹添加类型和加密ID
            resolve(rows.map(r => ({ ...r, type: 'folder', encrypted_id: encrypt(r.id) })));
        });
    });
    
    // 2. 搜寻档案
    const filesPromise = new Promise((resolve, reject) => {
        db.all("SELECT * FROM files WHERE fileName LIKE ? AND user_id = ?", [searchTerm, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows.map(r => ({ ...r, type: 'file' })));
        });
    });

    const [folders, files] = await Promise.all([foldersPromise, filesPromise]);
    log('DEBUG', FUNC_NAME, `搜寻 "${query}" 结束: ${folders.length} 资料夹, ${files.length} 档案`);
    
    // 3. 以物件形式返回
    return { folders, files };
}
// --- *** 修复 3 结束 *** ---


// --- 分享功能 ---

async function createShareLink(itemId, itemType, expiresIn, userId, password, customExpiresAt) {
    const FUNC_NAME = 'createShareLink';
    log('INFO', FUNC_NAME, `正在建立分享: ${itemType} ID: ${itemId} (User: ${userId}), 效期: ${expiresIn}`);
    
    // 1. 验证项目存在
    if (itemType === 'file') {
        const file = (await getFilesByIds([itemId], userId))[0];
        if (!file) return { success: false, message: '找不到档案' };
    } else {
        const folder = await getFolderDetails(itemId, userId);
        if (!folder) return { success: false, message: '找不到资料夹' };
    }

    // 2. 取消现有的分享
    await cancelShare(itemId, itemType, userId);

    // 3. 设定参数
    const token = require('crypto').randomBytes(16).toString('hex'); // <--- 修正：在此处引入 crypto
    let expiresAt = null;
    if (expiresIn === '1h') expiresAt = Date.now() + 3600000;
    else if (expiresIn === '24h') expiresAt = Date.now() + 86400000;
    else if (expiresIn === '7d') expiresAt = Date.now() + 604800000;
    else if (expiresIn === 'custom' && customExpiresAt) {
        expiresAt = parseInt(customExpiresAt, 10);
    }
    
    let hashedPassword = null;
    if (password) {
        const salt = await bcrypt.genSalt(10);
        hashedPassword = await bcrypt.hash(password, salt);
    }
    
    // 4. 写入资料库
    try {
        await db.run(
            `INSERT INTO shares (item_id, type, user_id, share_token, expires_at, share_password) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [itemId, itemType, userId, token, expiresAt, hashedPassword]
        );
        log('INFO', FUNC_NAME, `分享建立成功: ${itemType} ID: ${itemId}, Token: ${token}`);
        return { success: true, token: token };
    } catch (e) {
        log('ERROR', FUNC_NAME, `建立分享 ${itemType} ID: ${itemId} 失败:`, e);
        return { success: false, message: '建立分享时发生资料库错误' };
    }
}

async function cancelShare(itemId, itemType, userId) {
    const FUNC_NAME = 'cancelShare';
    log('INFO', FUNC_NAME, `正在取消分享: ${itemType} ID: ${itemId} (User: ${userId})`);
    try {
        const result = await db.run(
            "DELETE FROM shares WHERE item_id = ? AND type = ? AND user_id = ?",
            [itemId, itemType, userId]
        );
        return { success: true, message: '分享已取消', changes: result.changes };
    } catch (e) {
        log('ERROR', FUNC_NAME, `取消分享 ${itemType} ID: ${itemId} 失败:`, e);
        return { success: false, message: '取消分享时发生资料库错误' };
    }
}

async function getActiveShares(userId) {
    const FUNC_NAME = 'getActiveShares';
    log('DEBUG', FUNC_NAME, `正在获取使用者 ${userId} 的有效分享`);
    
    // 1. 清理过期的
    await db.run("DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?", [Date.now()]);
    
    // 2. 获取档案分享
    const filesPromise = db.all(
        `SELECT s.item_id, s.type, s.share_token, s.expires_at, s.share_password, f.fileName as name 
         FROM shares s JOIN files f ON s.item_id = f.id 
         WHERE s.user_id = ? AND s.type = 'file'`, 
        [userId]
    );
    
    // 3. 获取资料夹分享
    const foldersPromise = db.all(
        `SELECT s.item_id, s.type, s.share_token, s.expires_at, s.share_password, f.name 
         FROM shares s JOIN folders f ON s.item_id = f.id 
         WHERE s.user_id = ? AND s.type = 'folder'`, 
        [userId]
    );
    
    const [files, folders] = await Promise.all([filesPromise, foldersPromise]);
    log('DEBUG', FUNC_NAME, `获取成功: ${folders.length} 资料夹, ${files.length} 档案`);
    return [...files, ...folders].map(s => ({ ...s, has_password: !!s.share_password }));
}

async function getFileByShareToken(token) {
    const FUNC_NAME = 'getFileByShareToken';
    log('DEBUG', FUNC_NAME, `正在依 Token 寻找分享档案: ${token}`);
    
    const row = await db.get(
        `SELECT f.*, s.share_password 
         FROM files f JOIN shares s ON f.id = s.item_id 
         WHERE s.share_token = ? AND s.type = 'file' 
         AND (s.expires_at IS NULL OR s.expires_at > ?)`,
        [token, Date.now()]
    );
    
    if (!row) {
        log('DEBUG', FUNC_NAME, `Token ${token} 未找到或已过期。`);
        // 清理过期的
        await db.run("DELETE FROM shares WHERE share_token = ?", [token]);
    }
    return row;
}

async function getFolderByShareToken(token) {
    const FUNC_NAME = 'getFolderByShareToken';
     log('DEBUG', FUNC_NAME, `正在依 Token 寻找分享资料夹: ${token}`);
     
    const row = await db.get(
        `SELECT f.*, s.share_password 
         FROM folders f JOIN shares s ON f.id = s.item_id 
         WHERE s.share_token = ? AND s.type = 'folder' 
         AND (s.expires_at IS NULL OR s.expires_at > ?)`,
        [token, Date.now()]
    );
    
    if (!row) {
         log('DEBUG', FUNC_NAME, `Token ${token} 未找到或已过期。`);
        // 清理过期的
        await db.run("DELETE FROM shares WHERE share_token = ?", [token]);
    }
    return row;
}

async function findFolderBySharePath(token, pathSegments) {
    const FUNC_NAME = 'findFolderBySharePath';
    log('DEBUG', FUNC_NAME, `正在依分享路径寻找资料夹: ${token} / ${pathSegments.join('/')}`);
    
    const rootFolder = await getFolderByShareToken(token);
    if (!rootFolder) return null;

    let currentFolder = rootFolder;
    for (const segment of pathSegments) {
        const nextFolder = await new Promise((resolve, reject) => {
            db.get(
                "SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?",
                [segment, currentFolder.id, rootFolder.user_id],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
        if (!nextFolder) {
             log('DEBUG', FUNC_NAME, `路径 ${segment} 在 ${currentFolder.id} 中未找到。`);
             return null; // 路径无效
        }
        currentFolder = nextFolder;
    }
    
    log('DEBUG', FUNC_NAME, `分享路径寻找成功，找到资料夹 ID: ${currentFolder.id}`);
    return currentFolder;
}

async function findFileInSharedFolder(fileId, folderToken) {
    const FUNC_NAME = 'findFileInSharedFolder';
    log('DEBUG', FUNC_NAME, `正在检查档案 ${fileId} 是否在分享 ${folderToken} 中`);
    
    const rootFolder = await getFolderByShareToken(folderToken);
    if (!rootFolder) return null;
    
    const file = (await getFilesByIds([fileId], rootFolder.user_id))[0];
    if (!file) return null;
    
    // 检查档案是否在分享的资料夹或其子资料夹中
    let currentFolderId = file.folder_id;
    let checkedCount = 0;
    while (currentFolderId !== null) {
        if (checkedCount++ > 50) return null; // 防回圈
        if (currentFolderId === rootFolder.id) {
             log('DEBUG', FUNC_NAME, `档案 ${fileId} 验证成功在分享 ${folderToken} 中。`);
             return file; // 找到了
        }
        
        const folder = await getFolderDetails(currentFolderId, rootFolder.user_id);
        if (!folder) return null; // 路径中断
        
        currentFolderId = folder.parent_id;
    }
    
    log('DEBUG', FUNC_NAME, `档案 ${fileId} 不在分享 ${folderToken} 的层级下。`);
    return null; // 未找到
}

// --- Auth Token 功能 ---

async function createAuthToken(userId, token, expiresAt) {
    const FUNC_NAME = 'createAuthToken';
    log('DEBUG', FUNC_NAME, `正在为使用者 ${userId} 建立 auth token`);
    return db.run(
        "INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
        [userId, token, expiresAt]
    );
}

async function findAuthToken(token) {
    const FUNC_NAME = 'findAuthToken';
    log('DEBUG', FUNC_NAME, `正在寻找 auth token (前 8 码: ${token.substring(0, 8)}... )`);
    return db.get(
        `SELECT t.user_id, t.expires_at, u.username, u.is_admin 
         FROM auth_tokens t 
         JOIN users u ON t.user_id = u.id 
         WHERE t.token = ?`, 
        [token]
    );
}

async function deleteAuthToken(token) {
    const FUNC_NAME = 'deleteAuthToken';
     log('DEBUG', FUNC_NAME, `正在删除 auth token (前 8 码: ${token.substring(0, 8)}... )`);
    return db.run("DELETE FROM auth_tokens WHERE token = ?", [token]);
}

async function deleteExpiredAuthTokens() {
    const FUNC_NAME = 'deleteExpiredAuthTokens';
    log('DEBUG', FUNC_NAME, `正在删除所有过期的 auth tokens...`);
    return db.run("DELETE FROM auth_tokens WHERE expires_at < ?", [Date.now()]);
}


async function resolvePathToFolderId(initialFolderId, pathParts, userId) {
    const FUNC_NAME = 'resolvePathToFolderId';
    log('DEBUG', FUNC_NAME, `正在解析路径 ${pathParts.join('/')} from ${initialFolderId}`);
    
    let currentFolderId = initialFolderId;
    
    for (const part of pathParts) {
        if (!part) continue; // 忽略空路径
        
        // 尝试寻找现有的资料夹
        const existingFolder = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?", 
                   [part, currentFolderId, userId], (err, row) => {
                if (err) return reject(err);
                resolve(row);
            });
        });

        if (existingFolder) {
            currentFolderId = existingFolder.id;
        } else {
            // 资料夹不存在，建立它
            log('DEBUG', FUNC_NAME, `路径 ${part} 不存在，正在建立...`);
            const newFolder = await createFolder(part, currentFolderId, userId);
            
            // (仅 Local/WebDAV) 建立实体资料夹
            const storage = storageManager.getStorage();
            if (storage.type === 'local' || storage.type === 'webdav') {
                const newFolderPathParts = await getFolderPath(newFolder.id, userId);
                const newFullPath = path.posix.join(...newFolderPathParts.slice(1).map(p => p.name));
                
                if (storage.type === 'local') {
                    const newLocalPath = path.join(__dirname, 'data', 'uploads', String(userId), newFullPath);
                    await fsp.mkdir(newLocalPath, { recursive: true });
                } else if (storage.type === 'webdav' && storage.createDirectory) {
                    await storage.createDirectory(newFullPath);
                }
            }
            
            currentFolderId = newFolder.id;
        }
    }
    
    log('DEBUG', FUNC_NAME, `路径解析完成，最终资料夹 ID: ${currentFolderId}`);
    return currentFolderId;
}

async function findFolderByPath(initialFolderId, pathParts, userId) {
    const FUNC_NAME = 'findFolderByPath';
    log('DEBUG', FUNC_NAME, `正在寻找路径 ${pathParts.join('/')} from ${initialFolderId}`);
    
    let currentFolderId = initialFolderId;
    
    for (const part of pathParts) {
         if (!part) continue;
         
         const existingFolder = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?", 
                   [part, currentFolderId, userId], (err, row) => {
                if (err) return reject(err);
                resolve(row);
            });
        });
        
        if (existingFolder) {
            currentFolderId = existingFolder.id;
        } else {
            log('DEBUG', FUNC_NAME, `路径 ${part} 未找到。`);
            return null; // 路径不存在
        }
    }
    log('DEBUG', FUNC_NAME, `寻找路径成功，最终资料夹 ID: ${currentFolderId}`);
    return currentFolderId;
}


module.exports = {
    findUserByName,
    findUserById,
    createUser,
    listNormalUsers,
    listAllUsers,
    deleteUser,
    changeUserPassword,
    createFolder,
    getFolderContents,
    getFolderDetails,
    getFolderPath,
    getAllFolders,
    getFilesByIds,
    getItemsByIds,
    getFilesRecursive,
    addFile,
    updateFile, // <--- *** 在此处添加 updateFile ***
    findFileInFolder,
    findItemInFolder,
    checkFullConflict,
    findAvailableName,
    getConflictingItems,
    moveItem,
    renameFile,
    renameFolder,
    deleteFilesByIds,
    unifiedDelete,
    isFileAccessible,
    setFolderPassword,
    verifyFolderPassword,
    searchItems,
    createShareLink,
    cancelShare,
    getActiveShares,
    getFileByShareToken,
    getFolderByShareToken,
    findFolderBySharePath,
    findFileInSharedFolder,
    createAuthToken,
    findAuthToken,
    deleteAuthToken,
    deleteExpiredAuthTokens,
    resolvePathToFolderId,
    findFolderByPath
};
