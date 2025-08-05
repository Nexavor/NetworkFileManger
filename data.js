const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const UPLOAD_DIR = path.resolve(__dirname, 'data', 'uploads');

function createUser(username, hashedPassword) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO users (username, password, is_admin) VALUES (?, ?, 0)`;
        db.run(sql, [username, hashedPassword], function(err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, username });
        });
    });
}

function findUserByName(username) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function findUserById(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function changeUserPassword(userId, newHashedPassword) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE users SET password = ? WHERE id = ?`;
        db.run(sql, [newHashedPassword, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

function listNormalUsers() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username ASC`;
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function listAllUsers() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, username FROM users ORDER BY username ASC`;
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}


async function deleteUser(userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    try {
        await fs.rm(userUploadDir, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            // 在生产环境中，可以考虑将此错误记录到专门的日志文件
        }
    }
    
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM users WHERE id = ? AND is_admin = 0`;
        db.run(sql, [userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}


function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const searchQuery = `%${query}%`;
        const sqlFolders = `
            SELECT id, name, parent_id, 'folder' as type
            FROM folders
            WHERE name LIKE ? AND user_id = ? AND parent_id IS NOT NULL
            ORDER BY name ASC`;

        const sqlFiles = `
            SELECT *, message_id as id, fileName as name, 'file' as type
            FROM files
            WHERE fileName LIKE ? AND user_id = ?
            ORDER BY date DESC`;

        let contents = { folders: [], files: [] };

        db.all(sqlFolders, [searchQuery, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders;
            db.all(sqlFiles, [searchQuery, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files.map(f => ({ ...f, message_id: f.id }));
                resolve(contents);
            });
        });
    });
}

function getItemsByIds(itemIds, userId) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        const sql = `
            SELECT id, name, parent_id, 'folder' as type, null as storage_type, null as file_id
            FROM folders 
            WHERE id IN (${placeholders}) AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, folder_id as parent_id, 'file' as type, storage_type, file_id
            FROM files 
            WHERE message_id IN (${placeholders}) AND user_id = ?
        `;
        db.all(sql, [...itemIds, userId, ...itemIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getChildrenOfFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ?
        `;
        db.all(sql, [folderId, userId, folderId, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function getAllDescendantFolderIds(folderId, userId) {
    let descendants = [];
    let queue = [folderId];
    const visited = new Set(queue);

    while (queue.length > 0) {
        const currentId = queue.shift();
        const sql = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const children = await new Promise((resolve, reject) => {
            db.all(sql, [currentId, userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        for (const child of children) {
            if (!visited.has(child.id)) {
                visited.add(child.id);
                descendants.push(child.id);
                queue.push(child.id);
            }
        }
    }
    return descendants;
}

function getFolderContents(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sqlFolders = `SELECT id, name, parent_id, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name ASC`;
        const sqlFiles = `SELECT *, message_id as id, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? ORDER BY name ASC`;
        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [folderId, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders;
            db.all(sqlFiles, [folderId, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files.map(f => ({ ...f, message_id: f.id }));
                resolve(contents);
            });
        });
    });
}

async function getFilesRecursive(folderId, userId, currentPath = '') {
    let allFiles = [];
    const sqlFiles = "SELECT * FROM files WHERE folder_id = ? AND user_id = ?";
    const files = await new Promise((res, rej) => db.all(sqlFiles, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const file of files) {
        allFiles.push({ ...file, path: path.join(currentPath, file.fileName) });
    }

    const sqlFolders = "SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ?";
    const subFolders = await new Promise((res, rej) => db.all(sqlFolders, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const subFolder of subFolders) {
        const nestedFiles = await getFilesRecursive(subFolder.id, userId, path.join(currentPath, subFolder.name));
        allFiles.push(...nestedFiles);
    }
    return allFiles;
}

async function getDescendantFiles(folderIds, userId) {
    let allFiles = [];
    for (const folderId of folderIds) {
        const nestedFiles = await getFilesRecursive(folderId, userId);
        allFiles.push(...nestedFiles);
    }
    return allFiles;
}

function getFolderPath(folderId, userId) {
    let pathArr = [];
    return new Promise((resolve, reject) => {
        function findParent(id) {
            if (!id) return resolve(pathArr.reverse());
            db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [id, userId], (err, folder) => {
                if (err) return reject(err);
                if (folder) {
                    pathArr.push({ id: folder.id, name: folder.name });
                    findParent(folder.parent_id);
                } else {
                    resolve(pathArr.reverse());
                }
            });
        }
        findParent(folderId);
    });
}

function createFolder(name, parentId, userId) {
    const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [name, parentId, userId], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return reject(new Error('同目录下已存在同名资料夹。'));
                return reject(err);
            }
            resolve({ success: true, id: this.lastID });
        });
    });
}

function findFolderByName(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
        db.get(sql, [name, parentId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findFolderByPath(startFolderId, pathParts, userId) {
    let currentParentId = startFolderId;
    for (const part of pathParts) {
        if (!part) continue;
        const folder = await new Promise((resolve, reject) => {
            const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
            db.get(sql, [part, currentParentId, userId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (folder) {
            currentParentId = folder.id;
        } else {
            return null; 
        }
    }
    return currentParentId;
}


function getAllFolders(userId) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? ORDER BY parent_id, name ASC";
        db.all(sql, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function moveItem(itemId, itemType, targetFolderId, userId, options = {}, depth = 0) {
    // console.log(`[Data] moveItem: 开始移动项目 ID ${itemId} (类型: ${itemType}) 到目标资料夹 ID ${targetFolderId}, 深度: ${depth}`);
    const { resolutions = {}, pathPrefix = '' } = options;
    const report = { moved: 0, skipped: 0, errors: 0 };

    const sourceItem = await new Promise((resolve, reject) => {
        const table = itemType === 'folder' ? 'folders' : 'files';
        const idColumn = itemType === 'folder' ? 'id' : 'message_id';
        const nameColumn = itemType === 'folder' ? 'name' : 'fileName';
        const sql = `SELECT ${idColumn} as id, ${nameColumn} as name, '${itemType}' as type FROM ${table} WHERE ${idColumn} = ? AND user_id = ?`;
        db.get(sql, [itemId, userId], (err, row) => err ? reject(err) : resolve(row));
    });

    if (!sourceItem) {
        report.errors++;
        // console.error(`[Data] moveItem: 找不到来源项目 ID ${itemId} (类型: ${itemType})`);
        return report;
    }

    const currentPath = path.posix.join(pathPrefix, sourceItem.name);
    const existingItemInTarget = await findItemInFolder(sourceItem.name, targetFolderId, userId);
    let resolutionAction = resolutions[currentPath] || (existingItemInTarget ? 'skip_default' : 'move');

    // --- *** 关键修正：深度大于0时，将 'merge' 视为 'overwrite' *** ---
    if (depth > 0 && itemType === 'folder' && existingItemInTarget && existingItemInTarget.type === 'folder' && resolutionAction === 'merge') {
        // console.log(`[Data] moveItem: 深度合并 (${depth}) 不被支持，将 "${currentPath}" 的合并操作视为覆盖处理。`);
        resolutionAction = 'overwrite';
    }

    // console.log(`[Data] moveItem: 项目 "${currentPath}" 的解决策略为 "${resolutionAction}"`);

    switch (resolutionAction) {
        case 'skip':
        case 'skip_default':
            report.skipped++;
            // console.log(`[Data] moveItem: 跳过项目 "${currentPath}"`);
            return report;

        case 'rename':
            // console.log(`[Data] moveItem: 重新命名项目 "${currentPath}"`);
            const newName = await findAvailableName(sourceItem.name, targetFolderId, userId, itemType === 'folder');
            // console.log(`[Data] moveItem: 找到可用新名称 "${newName}"`);
            if (itemType === 'folder') {
                await renameFolder(itemId, newName, userId);
                await moveItems([], [itemId], targetFolderId, userId);
            } else {
                await renameAndMoveFile(itemId, newName, targetFolderId, userId);
            }
            report.moved++;
            return report;

        case 'overwrite':
            if (!existingItemInTarget) {
                // console.warn(`[Data] moveItem: 尝试覆盖但目标项目 "${currentPath}" 不存在，跳过。`);
                report.skipped++;
                return report;
            }
            // console.log(`[Data] moveItem: 覆盖目标项目 "${currentPath}" (ID: ${existingItemInTarget.id}, 类型: ${existingItemInTarget.type})`);
            await unifiedDelete(existingItemInTarget.id, existingItemInTarget.type, userId);
            await moveItems(itemType === 'file' ? [itemId] : [], itemType === 'folder' ? [itemId] : [], targetFolderId, userId);
            report.moved++;
            return report;

        case 'merge':
            if (!existingItemInTarget || existingItemInTarget.type !== 'folder' || itemType !== 'folder') {
                // console.warn(`[Data] moveItem: 尝试合并但目标项目 "${currentPath}" 不是资料夹，跳过。`);
                report.skipped++;
                return report;
            }

            // console.log(`[Data] moveItem: 合并资料夹 "${currentPath}" 到目标资料夹 ID ${existingItemInTarget.id}`);
            const { folders: childFolders, files: childFiles } = await getFolderContents(itemId, userId);
            let allChildrenProcessedSuccessfully = true;

            for (const childFolder of childFolders) {
                // console.log(`[Data] moveItem: 递回移动子资料夹 "${childFolder.name}" (ID: ${childFolder.id})`);
                const childReport = await moveItem(childFolder.id, 'folder', existingItemInTarget.id, userId, { ...options, pathPrefix: currentPath }, depth + 1);
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                if (childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            for (const childFile of childFiles) {
                // console.log(`[Data] moveItem: 递回移动子档案 "${childFile.name}" (ID: ${childFile.id})`);
                const childReport = await moveItem(childFile.id, 'file', existingItemInTarget.id, userId, { ...options, pathPrefix: currentPath }, depth + 1);
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                 if (childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            if (allChildrenProcessedSuccessfully) {
                // console.log(`[Data] moveItem: 所有子项目成功合并，删除原始资料夹 ID ${itemId}`);
                await unifiedDelete(itemId, 'folder', userId);
            } else {
                 // console.warn(`[Data] moveItem: 部分子项目未能成功合并，保留原始资料夹 ID ${itemId}`);
            }
            
            return report;

        default: // 'move'
            // console.log(`[Data] moveItem: 直接移动项目 "${currentPath}"`);
            await moveItems(itemType === 'file' ? [itemId] : [], itemType === 'folder' ? [itemId] : [], targetFolderId, userId);
            report.moved++;
            return report;
    }
}


async function unifiedDelete(itemId, itemType, userId) {
    const storage = require('./storage').getStorage();
    let filesForStorage = [];
    let foldersForStorage = [];
    
    if (itemType === 'folder') {
        const deletionData = await getFolderDeletionData(itemId, userId);
        filesForStorage.push(...deletionData.files);
        foldersForStorage.push(...deletionData.folders);
    } else {
        const directFiles = await getFilesByIds([itemId], userId);
        filesForStorage.push(...directFiles);
    }
    
    try {
        await storage.remove(filesForStorage, foldersForStorage, userId);
    } catch (err) {
        throw new Error("实体档案删除失败，操作已中止。");
    }
    
    await executeDeletion(filesForStorage.map(f => f.message_id), foldersForStorage.map(f => f.id), userId);
}

async function moveItems(fileIds = [], folderIds = [], targetFolderId, userId) {
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav') {
        const client = storage.type === 'webdav' ? storage.getClient() : null;
        
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetFullPath = path.posix.join(...targetPathParts.map(p => p.name));

        const filesToMove = await getFilesByIds(fileIds, userId);
        for (const file of filesToMove) {
            const oldRelativePath = file.file_id;
            const newRelativePath = path.posix.join(targetFullPath, file.fileName);
            
            try {
                if (storage.type === 'local') {
                    const oldFullPath = path.join(UPLOAD_DIR, String(userId), oldRelativePath);
                    const newFullPath = path.join(UPLOAD_DIR, String(userId), newRelativePath);
                    await fs.mkdir(path.dirname(newFullPath), { recursive: true });
                    await fs.rename(oldFullPath, newFullPath);
                } else if (client) {
                    await client.moveFile(oldRelativePath, newRelativePath);
                }
                
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [newRelativePath, file.message_id], (e) => e ? rej(e) : res()));

            } catch (err) {
                throw new Error(`物理移动文件 ${file.fileName} 失败`);
            }
        }
        
        const foldersToMove = (await getItemsByIds(folderIds, userId)).filter(i => i.type === 'folder');
        for (const folder of foldersToMove) {
            const oldPathParts = await getFolderPath(folder.id, userId);
            const oldFullPath = path.posix.join(...oldPathParts.map(p => p.name));
            const newFullPath = path.posix.join(targetFullPath, folder.name);

            try {
                 if (storage.type === 'local') {
                    const oldAbsPath = path.join(UPLOAD_DIR, String(userId), oldFullPath);
                    const newAbsPath = path.join(UPLOAD_DIR, String(userId), newFullPath);
                    if (fsSync.existsSync(oldAbsPath)) {
                       await fs.rename(oldAbsPath, newAbsPath);
                    }
                 } else if (client) {
                    await client.moveFile(oldFullPath, newFullPath);
                 }

                const descendantFiles = await getFilesRecursive(folder.id, userId);
                for (const file of descendantFiles) {
                    const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
                    await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
                }
            } catch (err) {
                throw new Error(`物理移动文件夹 ${folder.name} 失败`);
            }
        }
    }

    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];

            if (fileIds.length > 0) {
                const place = fileIds.map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`UPDATE files SET folder_id = ? WHERE message_id IN (${place}) AND user_id = ?`, [targetFolderId, ...fileIds, userId], (e) => e ? rej(e) : res())));
            }

            if (folderIds.length > 0) {
                const place = folderIds.map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`UPDATE folders SET parent_id = ? WHERE id IN (${place}) AND user_id = ?`, [targetFolderId, ...folderIds, userId], (e) => e ? rej(e) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (e) => e ? reject(e) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}

function deleteSingleFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM folders WHERE id = ? AND user_id = ?`;
        db.run(sql, [folderId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

async function getFolderDeletionData(folderId, userId) {
    let filesToDelete = [];
    let foldersToDeleteIds = [folderId];

    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT * FROM files WHERE folder_id = ? AND user_id = ?`;
        const files = await new Promise((res, rej) => db.all(sqlFiles, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        filesToDelete.push(...files);
        
        const sqlFolders = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const subFolders = await new Promise((res, rej) => db.all(sqlFolders, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        
        for (const subFolder of subFolders) {
            foldersToDeleteIds.push(subFolder.id);
            await findContentsRecursive(subFolder.id);
        }
    }

    await findContentsRecursive(folderId);

    const allUserFolders = await getAllFolders(userId);
    const folderMap = new Map(allUserFolders.map(f => [f.id, f]));
    
    function buildPath(fId) {
        let pathParts = [];
        let current = folderMap.get(fId);
        while(current && current.parent_id) {
            pathParts.unshift(current.name);
            current = folderMap.get(current.parent_id);
        }
        return path.join(...pathParts);
    }

    const foldersToDeleteWithPaths = foldersToDeleteIds.map(id => ({
        id: id,
        path: buildPath(id)
    }));

    return { files: filesToDelete, folders: foldersToDeleteWithPaths };
}


function executeDeletion(fileIds, folderIds, userId) {
    return new Promise((resolve, reject) => {
        if (fileIds.length === 0 && folderIds.length === 0) return resolve({ success: true });
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];
            
            if (fileIds.length > 0) {
                const place = Array.from(new Set(fileIds)).map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`DELETE FROM files WHERE message_id IN (${place}) AND user_id = ?`, [...new Set(fileIds), userId], (e) => e ? rej(e) : res())));
            }
            if (folderIds.length > 0) {
                const place = Array.from(new Set(folderIds)).map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`DELETE FROM folders WHERE id IN (${place}) AND user_id = ?`, [...new Set(folderIds), userId], (e) => e ? rej(e) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (e) => e ? reject(e) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}


function addFile(fileData, folderId = 1, userId, storageType) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType], function(err) {
            if (err) reject(err);
            else resolve({ success: true, id: this.lastID, fileId: this.lastID });
        });
    });
}

function getFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) {
        return Promise.resolve([]);
    }
    const placeholders = messageIds.map(() => '?').join(',');
    const sql = `SELECT * FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.all(sql, [...messageIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getFileByShareToken(token) {
     return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM files WHERE share_token = ?";
        db.get(sql, [token], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            if (row.share_expires_at && Date.now() > row.share_expires_at) {
                const updateSql = "UPDATE files SET share_token = NULL, share_expires_at = NULL WHERE message_id = ?";
                db.run(updateSql, [row.message_id]);
                resolve(null);
            } else {
                resolve(row);
            }
        });
    });
}

function getFolderByShareToken(token) {
     return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM folders WHERE share_token = ?";
        db.get(sql, [token], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            if (row.share_expires_at && Date.now() > row.share_expires_at) {
                const updateSql = "UPDATE folders SET share_token = NULL, share_expires_at = NULL WHERE id = ?";
                db.run(updateSql, [row.id]);
                resolve(null);
            } else {
                resolve(row);
            }
        });
    });
}

function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT f.*
            FROM files f
            JOIN folders fo ON f.folder_id = fo.id
            WHERE f.message_id = ? AND fo.share_token = ?
        `;
        db.get(sql, [fileId, folderToken], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function renameFile(messageId, newFileName, userId) {
    const file = (await getFilesByIds([messageId], userId))[0];
    if (!file) return { success: false, message: '文件未找到。' };

    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav') {
        const oldRelativePath = file.file_id;
        const newRelativePath = path.posix.join(path.posix.dirname(oldRelativePath), newFileName);

        try {
            if (storage.type === 'local') {
                const oldFullPath = path.join(UPLOAD_DIR, String(userId), oldRelativePath);
                const newFullPath = path.join(UPLOAD_DIR, String(userId), newRelativePath);
                await fs.rename(oldFullPath, newFullPath);
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldRelativePath, newRelativePath);
            }
        } catch(err) {
            throw new Error(`实体档案重新命名失败`);
        }
        
        const sql = `UPDATE files SET fileName = ?, file_id = ? WHERE message_id = ? AND user_id = ?`;
        return new Promise((resolve, reject) => {
            db.run(sql, [newFileName, newRelativePath, messageId, userId], function(err) {
                 if (err) reject(err);
                 else resolve({ success: true });
            });
        });
    }

    const sql = `UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, messageId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '文件未找到。' });
            else resolve({ success: true });
        });
    });
}

async function renameAndMoveFile(messageId, newFileName, targetFolderId, userId) {
    const file = (await getFilesByIds([messageId], userId))[0];
    if (!file) throw new Error('File not found for rename and move');

    const storage = require('./storage').getStorage();
    if (storage.type === 'local' || storage.type === 'webdav') {
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetRelativePath = path.posix.join(...targetPathParts.map(p => p.name));
        const newRelativePath = path.posix.join(targetRelativePath, newFileName);
        const oldRelativePath = file.file_id;
        
        try {
            if (storage.type === 'local') {
                 const oldFullPath = path.join(UPLOAD_DIR, String(userId), oldRelativePath);
                 const newFullPath = path.join(UPLOAD_DIR, String(userId), newRelativePath);
                 await fs.mkdir(path.dirname(newFullPath), { recursive: true });
                 await fs.rename(oldFullPath, newFullPath);
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldRelativePath, newRelativePath);
            }
        } catch(err) {
            throw new Error(`实体档案移动并重命名失败`);
        }
        
        const sql = `UPDATE files SET fileName = ?, file_id = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
        return new Promise((resolve, reject) => {
            db.run(sql, [newFileName, newRelativePath, targetFolderId, messageId, userId], (err) => err ? reject(err) : resolve({ success: true }));
        });
    }

    const sql = `UPDATE files SET fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, targetFolderId, messageId, userId], (err) => err ? reject(err) : resolve({ success: true }));
    });
}


async function renameFolder(folderId, newFolderName, userId) {
    const folder = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=?", [folderId], (e,r)=>e?rej(e):res(r)));
    if (!folder) return { success: false, message: '资料夹未找到。'};
    
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav') {
        const oldPathParts = await getFolderPath(folderId, userId);
        const oldFullPath = path.posix.join(...oldPathParts.map(p => p.name));
        const newFullPath = path.posix.join(path.posix.dirname(oldFullPath), newFolderName);

        try {
            if (storage.type === 'local') {
                const oldAbsPath = path.join(UPLOAD_DIR, String(userId), oldFullPath);
                const newAbsPath = path.join(UPLOAD_DIR, String(userId), newFullPath);
                if (fsSync.existsSync(oldAbsPath)) {
                    await fs.rename(oldAbsPath, newAbsPath);
                }
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldFullPath, newFullPath);
            }

            const descendantFiles = await getFilesRecursive(folderId, userId);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
            }

        } catch(e) {
            if (e.code !== 'ENOENT') {
                throw new Error("物理资料夹重新命名失败");
            }
        }
    }

    const sql = `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFolderName, folderId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '资料夹未找到。' });
            else resolve({ success: true });
        });
    });
}


function createShareLink(itemId, itemType, expiresIn, userId) {
    const token = crypto.randomBytes(16).toString('hex');
    let expiresAt = null;
    const now = Date.now();
    const hours = (h) => h * 60 * 60 * 1000;
    const days = (d) => d * 24 * hours(1);
    switch (expiresIn) {
        case '1h': expiresAt = now + hours(1); break;
        case '3h': expiresAt = now + hours(3); break;
        case '5h': expiresAt = now + hours(5); break;
        case '7h': expiresAt = now + hours(7); break;
        case '24h': expiresAt = now + hours(24); break;
        case '7d': expiresAt = now + days(7); break;
        case '0': expiresAt = null; break;
        default: expiresAt = now + hours(24);
    }

    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';

    const sql = `UPDATE ${table} SET share_token = ?, share_expires_at = ? WHERE ${idColumn} = ? AND user_id = ?`;

    return new Promise((resolve, reject) => {
        db.run(sql, [token, expiresAt, itemId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '项目未找到。' });
            else resolve({ success: true, token });
        });
    });
}

function deleteFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) {
        return Promise.resolve({ success: true, changes: 0 });
    }
    const placeholders = messageIds.map(() => '?').join(',');
    const sql = `DELETE FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [...messageIds, userId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
}

function getActiveShares(userId) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const sqlFiles = `SELECT message_id as id, fileName as name, 'file' as type, share_token, share_expires_at FROM files WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`;
        const sqlFolders = `SELECT id, name, 'folder' as type, share_token, share_expires_at FROM folders WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`;

        let shares = [];
        db.all(sqlFiles, [now, userId], (err, files) => {
            if (err) return reject(err);
            shares = shares.concat(files);
            db.all(sqlFolders, [now, userId], (err, folders) => {
                if (err) return reject(err);
                shares = shares.concat(folders);
                resolve(shares);
            });
        });
    });
}

function cancelShare(itemId, itemType, userId) {
    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    const sql = `UPDATE ${table} SET share_token = NULL, share_expires_at = NULL WHERE ${idColumn} = ? AND user_id = ?`;

    return new Promise((resolve, reject) => {
        db.run(sql, [itemId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '项目未找到或无需取消' });
            else resolve({ success: true });
        });
    });
}

async function getConflictingItems(itemsToMove, destinationFolderId, userId) {
    const fileConflicts = new Set();
    const folderConflicts = new Set();

    const destContents = await getChildrenOfFolder(destinationFolderId, userId);
    const destMap = new Map(destContents.map(item => [item.name, item.type]));

    for (const item of itemsToMove) {
        const destType = destMap.get(item.name);
        if (destType) {
            if (item.type === 'folder' && destType === 'folder') {
                folderConflicts.add(item.name);
            } else {
                fileConflicts.add(item.name);
            }
        }
    }
    
    return {
        fileConflicts: Array.from(fileConflicts),
        folderConflicts: Array.from(folderConflicts)
    };
}


function checkFullConflict(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT name FROM (
                SELECT name FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?
                UNION ALL
                SELECT fileName as name FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
            ) LIMIT 1
        `;
        db.get(sql, [name, folderId, userId, name, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

function findFileInFolder(fileName, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT message_id FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?`;
        db.get(sql, [fileName, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function findItemInFolder(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, 'file' as type FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
        `;
        db.get(sql, [name, folderId, userId, name, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findAvailableName(originalName, folderId, userId, isFolder) {
    let newName = originalName;
    let counter = 1;
    const nameWithoutExt = isFolder ? originalName : path.parse(originalName).name;
    const ext = isFolder ? '' : path.parse(originalName).ext;

    while (await findItemInFolder(newName, folderId, userId)) {
        newName = `${nameWithoutExt} (${counter})${ext}`;
        counter++;
    }
    return newName;
}


function findFileByFileId(fileId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT message_id FROM files WHERE file_id = ? AND user_id = ?`;
        db.get(sql, [fileId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}


function getRootFolder(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findOrCreateFolderByPath(fullPath, userId) {
    if (!fullPath || fullPath === '/') {
        const root = await getRootFolder(userId);
        return root.id;
    }

    const pathParts = fullPath.split('/').filter(p => p);
    let parentId = (await getRootFolder(userId)).id;

    for (const part of pathParts) {
        let folder = await findFolderByName(part, parentId, userId);
        if (folder) {
            parentId = folder.id;
        } else {
            const result = await createFolder(part, parentId, userId);
            parentId = result.id;
        }
    }
    return parentId;
}

async function resolvePathToFolderId(startFolderId, pathParts, userId) {
    let currentParentId = startFolderId;
    for (const part of pathParts) {
        if (!part) continue;

        let folder = await new Promise((resolve, reject) => {
            const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
            db.get(sql, [part, currentParentId, userId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (folder) {
            currentParentId = folder.id;
        } else {
            const newFolder = await new Promise((resolve, reject) => {
                const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
                db.run(sql, [part, currentParentId, userId], function(err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                });
            });
            currentParentId = newFolder.id;
        }
    }
    return currentParentId;
}

module.exports = {
    createUser,
    findUserByName,
    findUserById,
    changeUserPassword,
    listNormalUsers,
    listAllUsers,
    deleteUser,
    searchItems,
    getFolderContents,
    getFilesRecursive,
    getFolderPath,
    createFolder,
    findFolderByName,
    getAllFolders,
    getAllDescendantFolderIds,
    executeDeletion,
    getFolderDeletionData,
    deleteSingleFolder,
    addFile,
    getFilesByIds,
    getItemsByIds,
    getChildrenOfFolder,
    moveItems,
    moveItem,
    getFileByShareToken,
    getFolderByShareToken,
    findFileInSharedFolder,
    createShareLink,
    getActiveShares,
    cancelShare,
    renameFile,
    renameFolder,
    deleteFilesByIds,
    findFileInFolder,
    getConflictingItems,
    checkFullConflict,
    resolvePathToFolderId,
    findFolderByPath,
    getDescendantFiles,
    findFileByFileId,
    findOrCreateFolderByPath,
    getRootFolder,
    unifiedDelete,
    findItemInFolder,
    findAvailableName,
    renameAndMoveFile,
};
