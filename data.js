// data.js
const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const bcrypt = require('bcrypt');
const { encrypt, decrypt } = require('./crypto.js');

const UPLOAD_DIR = path.resolve(__dirname, 'data', 'uploads');
const creatingFolders = new Set();

const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted, deleted_at
`;

// 强制 SQLite 将 BIGINT 返回为字符串，避免 JavaScript 精度丢失
const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;


function createUser(username, hashedPassword) {
    return new Promise((resolve, reject) => {
        // 默认配额 1GB (1073741824 bytes)
        const sql = `INSERT INTO users (username, password, is_admin, max_storage_bytes) VALUES (?, ?, 0, 1073741824)`;
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
        // 计算已用空间 (仅计算未删除的文件)
        const sql = `
            SELECT u.id, u.username, u.max_storage_bytes, 
            (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.user_id = u.id AND f.is_deleted = 0) as used_storage
            FROM users u WHERE u.is_admin = 0 ORDER BY u.username ASC
        `;
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
             // ignore
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

// --- 新增：检查用户配额 ---
async function checkQuota(userId, incomingSize) {
    const user = await findUserById(userId);
    if (!user) throw new Error('User not found');
    
    // 仅计算未删除的文件占用
    const sql = `SELECT COALESCE(SUM(size), 0) as used FROM files WHERE user_id = ? AND is_deleted = 0`;
    const result = await new Promise((resolve, reject) => {
        db.get(sql, [userId], (err, row) => err ? reject(err) : resolve(row));
    });
    
    if (result.used + incomingSize > user.max_storage_bytes) {
        return false;
    }
    return true;
}

function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const searchQuery = `%${query}%`;

        const baseQuery = `
            WITH RECURSIVE folder_ancestry(id, parent_id, is_locked, is_deleted) AS (
                SELECT id, parent_id, (password IS NOT NULL) as is_locked, is_deleted
                FROM folders
                WHERE user_id = ?
                UNION ALL
                SELECT fa.id, f.parent_id, (fa.is_locked OR (f.password IS NOT NULL)), (fa.is_deleted OR f.is_deleted)
                FROM folders f
                JOIN folder_ancestry fa ON f.id = fa.parent_id
                WHERE f.user_id = ?
            ),
            folder_lock_status AS (
                SELECT id, MAX(is_locked) as is_path_locked, MAX(is_deleted) as is_path_deleted
                FROM folder_ancestry
                GROUP BY id
            )
        `;

        // 过滤掉软删除的文件和路径上已被删除的文件
        const sqlFiles = baseQuery + `
            SELECT 
                ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS},
                ${SAFE_SELECT_ID_AS_TEXT}, 
                f.fileName as name, 
                'file' as type
            FROM files f
            JOIN folder_lock_status fls ON f.folder_id = fls.id
            WHERE f.fileName LIKE ? AND f.user_id = ? AND fls.is_path_locked = 0 AND fls.is_path_deleted = 0 AND f.is_deleted = 0
            ORDER BY f.date DESC;
        `;
        
        const sqlFolders = baseQuery + `
            SELECT 
                f.id, 
                f.name, 
                f.parent_id, 
                'folder' as type, 
                (f.password IS NOT NULL) as is_locked
            FROM folders f
            JOIN folder_lock_status fls ON f.id = fls.id
            WHERE f.name LIKE ? AND f.user_id = ? AND fls.is_path_locked = 0 AND fls.is_path_deleted = 0 AND f.parent_id IS NOT NULL AND f.is_deleted = 0
            ORDER BY f.name ASC;
        `;

        let contents = { folders: [], files: [] };

        db.all(sqlFolders, [userId, userId, searchQuery, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) }));
            db.all(sqlFiles, [userId, userId, searchQuery, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

async function isFileAccessible(fileId, userId, unlockedFolders = []) {
    const file = (await getFilesByIds([fileId], userId))[0];
    if (!file || file.is_deleted) { // 增加删除状态检查
        return false; 
    }

    const path = await getFolderPath(file.folder_id, userId);
    if (!path || path.length === 0) {
        return false; 
    }

    const folderIds = path.map(p => p.id);
    const placeholders = folderIds.map(() => '?').join(',');
    const sql = `SELECT id, password IS NOT NULL as is_locked FROM folders WHERE id IN (${placeholders}) AND user_id = ?`;
    
    const folderStatuses = await new Promise((resolve, reject) => {
        db.all(sql, [...folderIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(new Map(rows.map(row => [row.id, row.is_locked])));
        });
    });

    for (const folder of path) {
        if (folderStatuses.get(folder.id) && !unlockedFolders.includes(folder.id)) {
            return false; 
        }
    }

    return true; 
}

function getItemsByIds(itemIds, userId) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        
        // 增加 is_deleted = 0 过滤
        const sql = `
            SELECT id, name, parent_id, 'folder' as type, null as storage_type, null as file_id, password IS NOT NULL as is_locked
            FROM folders 
            WHERE id IN (${placeholders}) AND user_id = ? AND is_deleted = 0
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, folder_id as parent_id, 'file' as type, storage_type, file_id, 0 as is_locked
            FROM files 
            WHERE message_id IN (${placeholders}) AND user_id = ? AND is_deleted = 0
        `;
        const stringItemIds = itemIds.map(id => id.toString());
        db.all(sql, [...stringItemIds, userId, ...stringItemIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getChildrenOfFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        // 增加 is_deleted = 0 过滤
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ? AND is_deleted = 0
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND is_deleted = 0
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
        // 增加 is_deleted = 0 过滤，只查找未删除的子目录
        const sql = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ? AND is_deleted = 0`;
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

function getFolderDetails(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, name, parent_id, password, password IS NOT NULL as is_locked FROM folders WHERE id = ? AND user_id = ? AND is_deleted = 0`;
        db.get(sql, [folderId, userId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function getFolderContents(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, password IS NOT NULL as is_locked FROM folders WHERE parent_id = ? AND user_id = ? AND is_deleted = 0 ORDER BY name ASC`;
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND is_deleted = 0 ORDER BY name ASC`;
        
        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [folderId, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) }));
            db.all(sqlFiles, [folderId, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

async function getFilesRecursive(folderId, userId, currentPath = '') {
    let allFiles = [];
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ? AND is_deleted = 0`;
    const files = await new Promise((res, rej) => db.all(sqlFiles, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const file of files) {
        allFiles.push({ ...file, path: path.join(currentPath, file.fileName) });
    }

    const sqlFolders = "SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ? AND is_deleted = 0";
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
                    pathArr.push({ id: folder.id, name: folder.name, encrypted_id: encrypt(folder.id) });
                    findParent(folder.parent_id);
                } else {
                    resolve(pathArr.reverse());
                }
            });
        }
        findParent(folderId);
    });
}

async function findFolderBySharePath(shareToken, pathSegments = []) {
    return new Promise(async (resolve, reject) => {
        try {
            const rootFolder = await getFolderByShareToken(shareToken);
            if (!rootFolder) {
                return resolve(null);
            }

            if (pathSegments.length === 0) {
                return resolve(rootFolder);
            }

            let currentParentId = rootFolder.id;
            let currentFolder = rootFolder;
            const userId = rootFolder.user_id;

            for (const segment of pathSegments) {
                // 确保只查找未删除的文件夹
                const sql = `SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND is_deleted = 0`;
                const row = await new Promise((res, rej) => {
                    db.get(sql, [segment, currentParentId, userId], (err, row) => err ? rej(err) : res(row));
                });

                if (!row) {
                    return resolve(null); 
                }
                
                if(row.password) {
                    return resolve(null); 
                }

                currentFolder = row;
                currentParentId = row.id;
            }
            resolve(currentFolder);
        } catch (error) {
            reject(error);
        }
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
        const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND is_deleted = 0`;
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
            const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND is_deleted = 0`;
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
        const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? AND is_deleted = 0 ORDER BY parent_id, name ASC";
        db.all(sql, [userId], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                const foldersWithEncryptedId = rows.map(folder => ({
                    ...folder,
                    encrypted_id: encrypt(folder.id)
                }));
                resolve(foldersWithEncryptedId);
            }
        });
    });
}

async function moveItem(itemId, itemType, targetFolderId, userId, options = {}, depth = 0) {
    const { resolutions = {}, pathPrefix = '' } = options;
    const report = { moved: 0, skipped: 0, errors: 0 };

    const sourceItem = await new Promise((resolve, reject) => {
        const table = itemType === 'folder' ? 'folders' : 'files';
        const idColumn = itemType === 'folder' ? 'id' : 'message_id';
        const nameColumn = itemType === 'folder' ? 'name' : 'fileName';
        const selectId = itemType === 'folder' ? 'id' : `${SAFE_SELECT_ID_AS_TEXT}`;
        
        // 移动时只查找未删除的项目
        const sql = `SELECT ${selectId}, ${nameColumn} as name, '${itemType}' as type FROM ${table} WHERE ${idColumn} = ? AND user_id = ? AND is_deleted = 0`;
        
        db.get(sql, [itemId.toString(), userId], (err, row) => err ? reject(err) : resolve(row));
    });

    if (!sourceItem) {
        report.errors++;
        return report;
    }
    
    const sourceItemId = itemType === 'folder' ? parseInt(sourceItem.id, 10) : BigInt(sourceItem.id);
    const currentPath = path.posix.join(pathPrefix, sourceItem.name);
    const existingItemInTarget = await findItemInFolder(sourceItem.name, targetFolderId, userId);
    let resolutionAction = resolutions[currentPath] || (existingItemInTarget ? 'skip_default' : 'move');

    switch (resolutionAction) {
        case 'skip':
        case 'skip_default':
            report.skipped++;
            return report;

        case 'rename':
            const newName = await findAvailableName(sourceItem.name, targetFolderId, userId, itemType === 'folder');
            if (itemType === 'folder') {
                await renameAndMoveFolder(sourceItemId, newName, targetFolderId, userId);
            } else {
                await renameAndMoveFile(sourceItemId, newName, targetFolderId, userId);
            }
            report.moved++;
            return report;

        case 'overwrite':
            if (!existingItemInTarget) {
                report.skipped++;
                return report;
            }
            const targetId = existingItemInTarget.type === 'folder' ? parseInt(existingItemInTarget.id, 10) : BigInt(existingItemInTarget.id);
            // 覆盖操作现在是软删除目标
            await unifiedDelete(targetId, existingItemInTarget.type, userId);
            
            await moveItems(itemType === 'file' ? [sourceItemId] : [], itemType === 'folder' ? [sourceItemId] : [], targetFolderId, userId);
            report.moved++;
            return report;

        case 'merge':
            if (!existingItemInTarget || existingItemInTarget.type !== 'folder' || itemType !== 'folder') {
                report.skipped++;
                return report;
            }
            
            const targetFolderIdInt = parseInt(existingItemInTarget.id, 10);

            const { folders: childFolders, files: childFiles } = await getFolderContents(sourceItemId, userId);
            let allChildrenProcessedSuccessfully = true;

            for (const childFolder of childFolders) {
                const childReport = await moveItem(childFolder.id, 'folder', targetFolderIdInt, userId, { ...options, pathPrefix: currentPath }, depth + 1);
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                if (childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            for (const childFile of childFiles) {
                const childReport = await moveItem(BigInt(childFile.id), 'file', targetFolderIdInt, userId, { ...options, pathPrefix: currentPath }, depth + 1);
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                 if (childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            if (allChildrenProcessedSuccessfully) {
                await unifiedDelete(sourceItemId, 'folder', userId);
            }
            
            return report;

        default: // 'move'
            await moveItems(itemType === 'file' ? [sourceItemId] : [], itemType === 'folder' ? [sourceItemId] : [], targetFolderId, userId);
            report.moved++;
            return report;
    }
}

// --- 重构：实现软删除 ---
async function unifiedDelete(itemId, itemType, userId) {
    const deletedAt = Date.now();
    
    if (itemType === 'file') {
        await new Promise((resolve, reject) => {
            db.run(`UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id = ? AND user_id = ?`, [deletedAt, itemId.toString(), userId], (err) => err ? reject(err) : resolve());
        });
    } else {
        // 文件夹软删除：递归标记所有子内容
        const items = await getFolderDeletionData(itemId, userId, true); // true: 获取未删除的项目
        const fileIds = items.files.map(f => f.message_id.toString());
        const folderIds = items.folders.map(f => f.id);
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            if (fileIds.length > 0) {
                const place = fileIds.map(() => '?').join(',');
                db.run(`UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id IN (${place})`, [deletedAt, ...fileIds]);
            }
            if (folderIds.length > 0) {
                const place = folderIds.map(() => '?').join(',');
                db.run(`UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id IN (${place})`, [deletedAt, ...folderIds]);
            }
            db.run("COMMIT;");
        });
    }
}

async function moveItems(fileIds = [], folderIds = [], targetFolderId, userId) {
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav') {
        const client = storage.type === 'webdav' ? storage.getClient() : null;
        
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetFullPath = path.posix.join(...targetPathParts.slice(1).map(p => p.name));

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
                
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [newRelativePath, file.message_id.toString()], (e) => e ? rej(e) : res()));

            } catch (err) {
                throw new Error(`物理移动文件 ${file.fileName} 失败`);
            }
        }
        
        const foldersToMove = (await getItemsByIds(folderIds, userId)).filter(i => i.type === 'folder');
        for (const folder of foldersToMove) {
            const oldPathParts = await getFolderPath(folder.id, userId);
            const oldFullPath = path.posix.join(...oldPathParts.slice(1).map(p => p.name));
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
                    await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id.toString()], (e) => e ? rej(e) : res()));
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
                promises.push(new Promise((res, rej) => db.run(`UPDATE files SET folder_id = ? WHERE message_id IN (${place}) AND user_id = ?`, [targetFolderId, ...fileIds.map(id => id.toString()), userId], (e) => e ? rej(e) : res())));
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
        // 用于永久删除空文件夹
        const sql = `DELETE FROM folders WHERE id = ? AND user_id = ?`;
        db.run(sql, [folderId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

// 获取文件夹数据，可选择查找 active (is_deleted=0) 或 deleted (is_deleted=1)
async function getFolderDeletionData(folderId, userId, findActive = true) {
    let filesToDelete = [];
    let foldersToDeleteIds = [folderId];
    const condition = findActive ? 'AND is_deleted = 0' : 'AND is_deleted = 1';

    // 辅助递归函数
    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ? ${condition}`;
        const files = await new Promise((res, rej) => db.all(sqlFiles, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        filesToDelete.push(...files);
        
        // 查找子文件夹时，如果我们要找已删除的，需要注意父文件夹被删除后子文件夹的状态
        // 软删除逻辑中，子文件夹也会被标记为 deleted。
        const sqlFolders = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ? ${condition}`;
        const subFolders = await new Promise((res, rej) => db.all(sqlFolders, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        
        for (const subFolder of subFolders) {
            foldersToDeleteIds.push(subFolder.id);
            await findContentsRecursive(subFolder.id);
        }
    }

    await findContentsRecursive(folderId);

    const allUserFolders = await getAllFolders(userId); // 这个函数现在只返回 active 的，可能需要调整以获取路径
    // 实际上，删除时如果是物理删除，路径可能已经断了。如果是软删除，不需要路径。
    // 这里为了物理删除逻辑，我们可能需要构建路径
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
                const stringFileIds = Array.from(new Set(fileIds)).map(id => id.toString());
                const place = stringFileIds.map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`DELETE FROM files WHERE message_id IN (${place}) AND user_id = ?`, [...stringFileIds, userId], (e) => e ? rej(e) : res())));
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


async function addFile(fileData, folderId = 1, userId, storageType) {
    // 安全起见，再次检查配额
    if (!(await checkQuota(userId, fileData.size))) {
        throw new Error("存储配额不足");
    }

    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [message_id.toString(), fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType], function(err) {
            if (err) reject(err);
            else resolve({ success: true, id: this.lastID, fileId: message_id });
        });
    });
}

function updateFile(fileId, updates, userId) {
    return new Promise((resolve, reject) => {
        const fields = [];
        const values = [];
        const validKeys = ['fileName', 'mimetype', 'file_id', 'thumb_file_id', 'size', 'date', 'message_id'];

        for (const key in updates) {
            if (Object.hasOwnProperty.call(updates, key) && validKeys.includes(key)) {
                fields.push(`${key} = ?`);
                values.push(key === 'message_id' ? updates[key].toString() : updates[key]);
            }
        }

        if (fields.length === 0) {
            return resolve({ success: true, changes: 0 });
        }
        
        values.push(fileId.toString(), userId);
        const sql = `UPDATE files SET ${fields.join(', ')} WHERE message_id = ? AND user_id = ?`;
        
        db.run(sql, values, function(err) {
            if (err) {
                return reject(err);
            }
            resolve({ success: true, changes: this.changes });
        });
    });
}


function getFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) {
        return Promise.resolve([]);
    }
    const stringMessageIds = messageIds.map(id => id.toString());
    const placeholders = stringMessageIds.map(() => '?').join(',');
    
    // 增加 is_deleted = 0
    const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id IN (${placeholders}) AND user_id = ? AND is_deleted = 0`;
    
    return new Promise((resolve, reject) => {
        db.all(sql, [...stringMessageIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getFileByShareToken(token) {
    const getShareSql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, share_password, share_expires_at FROM files WHERE share_token = ? AND is_deleted = 0`;
    
    const row = await new Promise((resolve, reject) => {
        db.get(getShareSql, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });

    if (!row) return null;
    const isExpired = row.share_expires_at && Date.now() > row.share_expires_at;
    if (isExpired) return null; 
    return row;
}

async function getFolderByShareToken(token) {
    const getShareSql = "SELECT *, password as share_password FROM folders WHERE share_token = ? AND is_deleted = 0";

    const row = await new Promise((resolve, reject) => {
        db.get(getShareSql, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });

    if (!row) return null;
    const isExpired = row.share_expires_at && Date.now() > row.share_expires_at;
    if (isExpired) return null; 
    return row;
}

async function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        // 增加 is_deleted = 0
        const sql = `
            WITH RECURSIVE shared_folder_tree(id) AS (
                SELECT id FROM folders WHERE share_token = ? AND password IS NULL AND is_deleted = 0
                UNION ALL
                SELECT f.id FROM folders f
                JOIN shared_folder_tree sft ON f.parent_id = sft.id
                WHERE f.password IS NULL AND f.is_deleted = 0
            )
            SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files f
            WHERE f.message_id = ? AND f.folder_id IN (SELECT id FROM shared_folder_tree) AND f.is_deleted = 0;
        `;
        db.get(sql, [folderToken, fileId.toString()], (err, row) => {
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
            db.run(sql, [newFileName, newRelativePath, messageId.toString(), userId], function(err) {
                 if (err) reject(err);
                 else resolve({ success: true });
            });
        });
    }

    const sql = `UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, messageId.toString(), userId], function(err) {
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
        const targetRelativePath = path.posix.join(...targetPathParts.slice(1).map(p => p.name));
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
            db.run(sql, [newFileName, newRelativePath, targetFolderId, messageId.toString(), userId], (err) => err ? reject(err) : resolve({ success: true }));
        });
    }

    const sql = `UPDATE files SET fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, targetFolderId, messageId.toString(), userId], (err) => err ? reject(err) : resolve({ success: true }));
    });
}


async function renameFolder(folderId, newFolderName, userId) {
    const folder = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=?", [folderId], (e,r)=>e?rej(e):res(r)));
    if (!folder) return { success: false, message: '资料夾未找到。'};
    
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav') {
        const oldPathParts = await getFolderPath(folderId, userId);
        const oldFullPath = path.posix.join(...oldPathParts.slice(1).map(p => p.name));
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
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id.toString()], (e) => e ? rej(e) : res()));
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
            else if (this.changes === 0) resolve({ success: false, message: '资料夾未找到。' });
            else resolve({ success: true });
        });
    });
}

async function renameAndMoveFolder(folderId, newName, targetFolderId, userId) {
    const folder = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=? AND user_id=?", [folderId, userId], (e,r)=>e?rej(e):res(r)));
    if (!folder) throw new Error('Folder not found for rename and move');

    const storage = require('./storage').getStorage();
    if (storage.type === 'local' || storage.type === 'webdav') {
        const oldPathParts = await getFolderPath(folderId, userId);
        const oldFullPath = path.posix.join(...oldPathParts.slice(1).map(p => p.name));

        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetBasePath = path.posix.join(...targetPathParts.slice(1).map(p => p.name));
        const newFullPath = path.posix.join(targetBasePath, newName);

        try {
            if (storage.type === 'local') {
                 const oldAbsPath = path.join(UPLOAD_DIR, String(userId), oldFullPath);
                 const newAbsPath = path.join(UPLOAD_DIR, String(userId), newFullPath);
                 if (fsSync.existsSync(oldAbsPath)) {
                    await fs.mkdir(path.dirname(newAbsPath), { recursive: true });
                    await fs.rename(oldAbsPath, newAbsPath);
                 }
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldFullPath, newFullPath);
            }

            const descendantFiles = await getFilesRecursive(folderId, userId);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id.toString()], (e) => e ? rej(e) : res()));
            }
        } catch(err) {
            throw new Error(`实体资料夾移动并重命名失败: ${err.message}`);
        }
    }

    const sql = `UPDATE folders SET name = ?, parent_id = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newName, targetFolderId, folderId, userId], (err) => err ? reject(err) : resolve({ success: true }));
    });
}

function setFolderPassword(folderId, password, userId) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE folders SET password = ? WHERE id = ? AND user_id = ?`;
        db.run(sql, [password, folderId, userId], function(err) {
            if (err) return reject(err);
            if (this.changes === 0) return reject(new Error('Folder not found or permission denied'));
            resolve({ success: true });
        });
    });
}

async function verifyFolderPassword(folderId, password, userId) {
    const folder = await getFolderDetails(folderId, userId);
    if (!folder || !folder.password) {
        throw new Error('Folder is not locked or does not exist.');
    }
    const isMatch = await bcrypt.compare(password, folder.password);
    return isMatch;
}

function createShareLink(itemId, itemType, expiresIn, userId, password = null, customExpiresAt = null) {
    const token = crypto.randomBytes(4).toString('hex');
    
    let expiresAt = null;

    if (expiresIn === 'custom' && customExpiresAt) {
        expiresAt = parseInt(customExpiresAt, 10);
    } else {
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
    }

    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';

    return new Promise(async (resolve, reject) => {
        let hashedPassword = null;
        if (password && password.length > 0) {
            const salt = await bcrypt.genSalt(10);
            hashedPassword = await bcrypt.hash(password, salt);
        }

        const sql = `UPDATE ${table} SET share_token = ?, share_expires_at = ?, share_password = ? WHERE ${idColumn} = ? AND user_id = ?`;
        const stringItemId = itemType === 'folder' ? itemId : itemId.toString();
        db.run(sql, [token, expiresAt, hashedPassword, stringItemId, userId], function(err) {
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
    const stringMessageIds = messageIds.map(id => id.toString());
    const placeholders = stringMessageIds.map(() => '?').join(',');
    const sql = `DELETE FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [...stringMessageIds, userId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
}

function getActiveShares(userId) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const sqlFiles = `SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type, share_token, share_expires_at FROM files WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ? AND is_deleted = 0`;
        const sqlFolders = `SELECT id, name, 'folder' as type, share_token, share_expires_at FROM folders WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ? AND is_deleted = 0`;

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
    const sql = `UPDATE ${table} SET share_token = NULL, share_expires_at = NULL, share_password = NULL WHERE ${idColumn} = ? AND user_id = ?`;

    return new Promise((resolve, reject) => {
        const stringItemId = itemType === 'folder' ? itemId : itemId.toString();
        db.run(sql, [stringItemId, userId], function(err) {
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
        // 仅检查未删除的项目
        const sql = `
            SELECT name FROM (
                SELECT name FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND is_deleted = 0
                UNION ALL
                SELECT fileName as name FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ? AND is_deleted = 0
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
        // 修正：列名应为 storage_type，而不是 type
        const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, storage_type FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ? AND is_deleted = 0`;
        db.get(sql, [fileName, folderId, userId], (err, row) => {
            if (err) return reject(err);
            // findFileInFolder 被 upload 使用，这里还需要返回 storage_type 吗？
            // 之前的版本只返回 message_id。
            // 让我们保持兼容性，返回整行。
            resolve(row);
        });
    });
}

function findItemInFolder(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND is_deleted = 0
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ? AND is_deleted = 0
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
        const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID} FROM files WHERE file_id = ? AND user_id = ? AND is_deleted = 0`;
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

        const lockId = `${userId}-${currentParentId}-${part}`;
        
        while (creatingFolders.has(lockId)) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        creatingFolders.add(lockId);
        try {
            const foundId = await new Promise((resolve, reject) => {
                db.serialize(() => {
                    const selectSql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND is_deleted = 0`;
                    db.get(selectSql, [part, currentParentId, userId], (err, row) => {
                        if (err) {
                            return reject(err);
                        }
                        if (row) {
                            return resolve(row.id);
                        }
                        
                        const insertSql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
                        db.run(insertSql, [part, currentParentId, userId], function(err) {
                            if (err) {
                                return reject(err);
                            }
                            resolve(this.lastID);
                        });
                    });
                });
            });
            currentParentId = foundId;
        } finally {
            creatingFolders.delete(lockId);
        }
    }
    return currentParentId;
}


// --- Auth Tokens Management ---

function createAuthToken(userId, token, expiresAt) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`;
        db.run(sql, [userId, token, expiresAt], function(err) {
            if (err) return reject(err);
            resolve({ id: this.lastID });
        });
    });
}

function findAuthToken(token) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT t.id, t.user_id, t.expires_at, u.username, u.is_admin 
                     FROM auth_tokens t
                     JOIN users u ON t.user_id = u.id
                     WHERE t.token = ?`;
        db.get(sql, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function deleteAuthToken(token) {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM auth_tokens WHERE token = ?`;
        db.run(sql, [token], function(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes });
        });
    });
}

function deleteExpiredAuthTokens() {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const sql = `DELETE FROM auth_tokens WHERE expires_at <= ?`;
        db.run(sql, [now], function(err) {
            if (err) {
                return reject(err);
            }
            resolve({ changes: this.changes });
        });
    });
}

// --- 新增：回收站相关 ---
function getRecycleBinContents(userId) {
    return new Promise((resolve, reject) => {
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE user_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`;
        const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, deleted_at FROM folders WHERE user_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`;
        
        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders;
            db.all(sqlFiles, [userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

async function restoreItem(itemId, itemType, userId) {
    if (itemType === 'file') {
        await new Promise((resolve, reject) => {
             db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE message_id = ? AND user_id = ?`, [itemId.toString(), userId], (err) => err ? reject(err) : resolve());
        });
    } else {
        // 还原文件夹：递归还原
        // 先还原文件夹本身
        await new Promise((resolve, reject) => {
             db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND user_id = ?`, [itemId, userId], (err) => err ? reject(err) : resolve());
        });
        // 递归还原所有子文件
        const descendantFolderIds = await getAllDescendantFolderIdsIncludingDeleted(itemId, userId);
        const allFolderIds = [itemId, ...descendantFolderIds];
        const place = allFolderIds.map(() => '?').join(',');
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE folder_id IN (${place}) AND user_id = ?`, [...allFolderIds, userId]);
            db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id IN (${place}) AND user_id = ?`, [...allFolderIds, userId]);
            db.run("COMMIT;");
        });
    }
}

async function permanentDelete(itemId, itemType, userId) {
    const storage = require('./storage').getStorage();
    let filesForStorage = [];
    let foldersForStorage = [];
    
    if (itemType === 'folder') {
        const deletionData = await getDeletedFolderData(itemId, userId);
        filesForStorage.push(...deletionData.files);
        foldersForStorage.push(...deletionData.folders);
    } else {
        const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id = ? AND user_id = ?`;
        const file = await new Promise((res) => db.get(sql, [itemId.toString(), userId], (e, r) => res(r)));
        if(file) filesForStorage.push(file);
    }

    try {
        await storage.remove(filesForStorage, foldersForStorage, userId);
    } catch (err) { /* log */ }

    const fileIds = filesForStorage.map(f => BigInt(f.message_id));
    const folderIds = foldersForStorage.map(f => f.id);
    
    // 如果是单个文件夹永久删除，记得加上它自己
    if (itemType === 'folder' && !folderIds.includes(parseInt(itemId))) {
        folderIds.push(parseInt(itemId));
    }
    
    await executeDeletion(fileIds, folderIds, userId);
}

async function emptyRecycleBin(userId) {
    const contents = await getRecycleBinContents(userId);
    // 这里只获取了顶层。其实我们需要获取所有 deleted 的物理文件来删除。
    // 这是一个复杂操作。
    // 简化策略：找出所有 is_deleted = 1 的文件，调用 storage.remove，然后 delete from DB
    
    const sqlAllDeletedFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE user_id = ? AND is_deleted = 1`;
    const allFiles = await new Promise((res) => db.all(sqlAllDeletedFiles, [userId], (e, r) => res(r || [])));
    
    const storage = require('./storage').getStorage();
    try {
        await storage.remove(allFiles, [], userId);
    } catch(e) {}

    await new Promise((res, rej) => db.run(`DELETE FROM files WHERE user_id = ? AND is_deleted = 1`, [userId], (e)=>e?rej(e):res()));
    await new Promise((res, rej) => db.run(`DELETE FROM folders WHERE user_id = ? AND is_deleted = 1`, [userId], (e)=>e?rej(e):res()));
}

async function getDeletedFolderData(folderId, userId) {
    let filesToDelete = [];
    let foldersToDeleteIds = [folderId];
    
    const ids = await getAllDescendantFolderIdsIncludingDeleted(folderId, userId);
    foldersToDeleteIds.push(...ids);
    
    if (foldersToDeleteIds.length > 0) {
        const placeholders = foldersToDeleteIds.map(() => '?').join(',');
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id IN (${placeholders}) AND user_id = ?`;
        const files = await new Promise((res) => db.all(sqlFiles, [...foldersToDeleteIds, userId], (e,r) => res(r || [])));
        filesToDelete.push(...files);
    }

    return { files: filesToDelete, folders: foldersToDeleteIds.map(id => ({ id, path: '' })) };
}

async function getAllDescendantFolderIdsIncludingDeleted(folderId, userId) {
    let descendants = []; let queue = [folderId];
    while (queue.length > 0) {
        const current = queue.shift();
        const rows = await new Promise(r => db.all(`SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`, [current, userId], (e,ro)=>r(ro||[])));
        for(const row of rows) { descendants.push(row.id); queue.push(row.id); }
    }
    return descendants;
}

// --- 新增：复制功能 ---
async function copyItem(itemId, itemType, targetFolderId, userId) {
    const storage = require('./storage').getStorage();
    const report = { copied: 0, errors: 0 };
    
    if (itemType === 'file') {
        const file = (await getFilesByIds([itemId], userId))[0];
        if (!file) throw new Error('File not found');
        
        if (!(await checkQuota(userId, file.size))) {
            throw new Error('存储配额不足');
        }

        const newName = await findAvailableName(file.fileName, targetFolderId, userId, false);
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetRelativePath = path.posix.join(...targetPathParts.slice(1).map(p => p.name), newName);

        let newFileId, newSize = file.size, thumbId = file.thumb_file_id;
        
        if (storage.type === 'telegram') {
             const copyResult = await storage.copy(file, newName, userId);
             newFileId = copyResult.file_id;
             // message_id will be generated in addFile
             thumbId = copyResult.thumb_file_id;
        } else {
             newFileId = await storage.copy(file, targetRelativePath, userId);
        }
        
        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
        await addFile({
            message_id: messageId,
            fileName: newName,
            mimetype: file.mimetype,
            size: newSize,
            file_id: newFileId,
            thumb_file_id: thumbId,
            date: Date.now()
        }, targetFolderId, userId, storage.type);
        report.copied++;

    } else {
        const folder = await getFolderDetails(itemId, userId);
        const newName = await findAvailableName(folder.name, targetFolderId, userId, true);
        
        const newFolderRes = await createFolder(newName, targetFolderId, userId);
        const newFolderId = newFolderRes.id;
        
        const { folders, files } = await getFolderContents(itemId, userId);
        
        for (const f of folders) {
            await copyItem(f.id, 'folder', newFolderId, userId);
        }
        for (const f of files) {
            await copyItem(BigInt(f.message_id), 'file', newFolderId, userId);
        }
        report.copied++;
    }
    return report;
}

module.exports = {
    createUser, findUserByName, findUserById, changeUserPassword, listNormalUsers, listAllUsers, deleteUser,
    searchItems, getFolderContents, getFilesRecursive, getFolderPath, createFolder, findFolderByName,
    getAllFolders, getAllDescendantFolderIds, executeDeletion, deleteSingleFolder, addFile, updateFile,
    getFilesByIds, getItemsByIds, getChildrenOfFolder, moveItem,
    getFileByShareToken, getFolderByShareToken, findFileInSharedFolder, createShareLink, getActiveShares, cancelShare,
    renameFile, renameFolder, deleteFilesByIds, findFileInFolder, getConflictingItems, checkFullConflict,
    resolvePathToFolderId, findFolderByPath, getDescendantFiles, findFileByFileId, findOrCreateFolderByPath, getRootFolder,
    unifiedDelete, findItemInFolder, findAvailableName, renameAndMoveFile, renameAndMoveFolder,
    getFolderDetails, setFolderPassword, verifyFolderPassword, isFileAccessible, findFolderBySharePath,
    createAuthToken, findAuthToken, deleteAuthToken, deleteExpiredAuthTokens,
    checkQuota, copyItem, restoreItem, permanentDelete, emptyRecycleBin, getRecycleBinContents, getFolderDeletionData
};
