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

// --- (Helper 1: 定义所有文件栏位) ---
const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted, deleted_at
`;
// --- (Helper 2: 定义读取 message_id 的安全方式) ---
const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;


function createUser(username, hashedPassword) {
    return new Promise((resolve, reject) => {
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
        if (error.code !== 'ENOENT') { }
    }
    
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM users WHERE id = ? AND is_admin = 0`;
        db.run(sql, [userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

// --- 用户配额管理 ---

async function getUserQuota(userId) {
    const user = await new Promise((resolve, reject) => {
        db.get("SELECT max_storage_bytes FROM users WHERE id = ?", [userId], (err, row) => err ? reject(err) : resolve(row));
    });

    const usage = await new Promise((resolve, reject) => {
        db.get("SELECT SUM(size) as total_size FROM files WHERE user_id = ?", [userId], (err, row) => err ? reject(err) : resolve(row));
    });

    return {
        max: user ? (user.max_storage_bytes || 1073741824) : 1073741824,
        used: usage && usage.total_size ? usage.total_size : 0
    };
}

async function checkQuota(userId, incomingSize) {
    const quota = await getUserQuota(userId);
    return (quota.used + incomingSize) <= quota.max;
}

async function listAllUsersWithQuota() {
    const users = await new Promise((resolve, reject) => {
        const sql = `SELECT id, username, is_admin, max_storage_bytes FROM users ORDER BY is_admin DESC, username ASC`;
        db.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows));
    });

    const userIds = users.map(u => u.id);
    if (userIds.length === 0) {
        return [];
    }
    const placeholders = userIds.map(() => '?').join(',');
    
    const usageSql = `SELECT user_id, SUM(size) as total_size FROM files WHERE user_id IN (${placeholders}) GROUP BY user_id`;
    
    const usageData = await new Promise((resolve, reject) => {
        db.all(usageSql, userIds, (err, rows) => err ? reject(err) : resolve(rows));
    });
    
    const usageMap = new Map(usageData.map(row => [row.user_id, row.total_size]));

    return users.map(user => ({
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        max_storage_bytes: user.max_storage_bytes || 1073741824, 
        used_storage_bytes: usageMap.get(user.id) || 0
    }));
}

function setMaxStorageForUser(userId, maxBytes) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE users SET max_storage_bytes = ? WHERE id = ? AND is_admin = 0`; 
        db.run(sql, [maxBytes, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

// --- 搜索与列表 ---

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
            folder_status AS (
                SELECT id, MAX(is_locked) as is_path_locked, MAX(is_deleted) as is_path_deleted
                FROM folder_ancestry
                GROUP BY id
            )
        `;

        const sqlFiles = baseQuery + `
            SELECT 
                ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS},
                ${SAFE_SELECT_ID_AS_TEXT}, 
                f.fileName as name, 
                'file' as type
            FROM files f
            JOIN folder_status fs ON f.folder_id = fs.id
            WHERE f.fileName LIKE ? AND f.user_id = ? 
            AND fs.is_path_locked = 0 AND fs.is_path_deleted = 0 AND f.is_deleted = 0
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
            JOIN folder_status fs ON f.id = fs.id
            WHERE f.name LIKE ? AND f.user_id = ? 
            AND fs.is_path_locked = 0 AND fs.is_path_deleted = 0 AND f.is_deleted = 0
            AND f.parent_id IS NOT NULL
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
    if (!file) {
        return false; 
    }

    if (file.is_deleted) {
        return false;
    }

    const path = await getFolderPath(file.folder_id, userId);
    if (!path || path.length === 0) {
        return false; 
    }

    const folderIds = path.map(p => p.id);
    const placeholders = folderIds.map(() => '?').join(',');
    const sql = `SELECT id, password IS NOT NULL as is_locked, is_deleted FROM folders WHERE id IN (${placeholders}) AND user_id = ?`;
    
    const folderInfos = await new Promise((resolve, reject) => {
        db.all(sql, [...folderIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(new Map(rows.map(row => [row.id, row])));
        });
    });

    for (const folder of path) {
        const info = folderInfos.get(folder.id);
        if (!info) continue;
        
        if (info.is_deleted) return false;

        if (info.is_locked && !unlockedFolders.includes(folder.id)) {
            return false; 
        }
    }

    return true; 
}

function getItemsByIds(itemIds, userId) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        
        const sql = `
            SELECT id, name, parent_id, 'folder' as type, null as storage_type, null as file_id, password IS NOT NULL as is_locked, is_deleted
            FROM folders 
            WHERE id IN (${placeholders}) AND user_id = ?
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, folder_id as parent_id, 'file' as type, storage_type, file_id, 0 as is_locked, is_deleted
            FROM files 
            WHERE message_id IN (${placeholders}) AND user_id = ?
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

function getFolderDetails(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, name, parent_id, password, password IS NOT NULL as is_locked, is_deleted FROM folders WHERE id = ? AND user_id = ?`;
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

// --- 回收站 ---
function getTrashContents(userId) {
    return new Promise((resolve, reject) => {
        const sqlFolders = `SELECT id, name, deleted_at, 'folder' as type FROM folders WHERE user_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`;
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, size, deleted_at, 'file' as type FROM files WHERE user_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`;

        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) }));
            db.all(sqlFiles, [userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

async function softDeleteItems(fileIds = [], folderIds = [], userId) {
    const now = Date.now();
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];

            if (fileIds.length > 0) {
                const stringFileIds = fileIds.map(id => id.toString());
                const place = stringFileIds.map(() => '?').join(',');
                const sql = `UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id IN (${place}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => db.run(sql, [now, ...stringFileIds, userId], (e) => e ? rej(e) : res())));
            }

            if (folderIds.length > 0) {
                const place = folderIds.map(() => '?').join(',');
                const sql = `UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id IN (${place}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => db.run(sql, [now, ...folderIds, userId], (e) => e ? rej(e) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (e) => e ? reject(e) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}

async function restoreItems(fileIds = [], folderIds = [], userId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];

            if (fileIds.length > 0) {
                const stringFileIds = fileIds.map(id => id.toString());
                const place = stringFileIds.map(() => '?').join(',');
                const sql = `UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE message_id IN (${place}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => db.run(sql, [...stringFileIds, userId], (e) => e ? rej(e) : res())));
            }

            if (folderIds.length > 0) {
                const place = folderIds.map(() => '?').join(',');
                const sql = `UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id IN (${place}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => db.run(sql, [...folderIds, userId], (e) => e ? rej(e) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (e) => e ? reject(e) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}

async function cleanupTrash(retentionDays = 30) {
    const cutoffDate = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    
    const expiredFilesSql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, user_id FROM files WHERE is_deleted = 1 AND deleted_at < ?`;
    const expiredFoldersSql = `SELECT id, user_id FROM folders WHERE is_deleted = 1 AND deleted_at < ?`;

    try {
        const files = await new Promise((res, rej) => db.all(expiredFilesSql, [cutoffDate], (e, r) => e ? rej(e) : res(r)));
        const folders = await new Promise((res, rej) => db.all(expiredFoldersSql, [cutoffDate], (e, r) => e ? rej(e) : res(r)));
        
        const itemsByUser = {};
        
        files.forEach(f => {
            if(!itemsByUser[f.user_id]) itemsByUser[f.user_id] = { files: [], folders: [] };
            itemsByUser[f.user_id].files.push(BigInt(f.message_id));
        });
        
        folders.forEach(f => {
            if(!itemsByUser[f.user_id]) itemsByUser[f.user_id] = { files: [], folders: [] };
            itemsByUser[f.user_id].folders.push(f.id);
        });
        
        for (const userId in itemsByUser) {
            const { files, folders } = itemsByUser[userId];
            if (files.length > 0 || folders.length > 0) {
                await unifiedDelete(null, null, parseInt(userId), files, folders); 
            }
        }
        return { filesCount: files.length, foldersCount: folders.length };

    } catch (error) {
        console.error("自动清理回收站失败:", error);
        throw error;
    }
}


async function getFilesRecursive(folderId, userId, currentPath = '') {
    let allFiles = [];
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ?`;
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
                const sql = `SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
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

// 修正：createFolder 处理 UNIQUE 错误，自动尝试恢复已删除文件夹
function createFolder(name, parentId, userId) {
    const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [name, parentId, userId], function (err) {
            if (err) {
                // 如果遇到唯一性约束错误
                if (err.message.includes('UNIQUE')) {
                    // 检查是否存在（无论是否被删除）
                    db.get("SELECT id, is_deleted FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?", [name, parentId, userId], (err2, row) => {
                        if (err2) return reject(err); // 返回原始错误
                        if (row) {
                            if (row.is_deleted) {
                                // 恢复已删除的文件夹
                                db.run("UPDATE folders SET is_deleted = 0 WHERE id = ?", [row.id], (err3) => {
                                    if (err3) return reject(err3);
                                    resolve({ success: true, id: row.id, restored: true });
                                });
                            } else {
                                // 文件夹已存在且未删除，视为成功 (幂等性)
                                resolve({ success: true, id: row.id, existed: true });
                            }
                        } else {
                            // 极罕见情况：报错但查不到，直接抛出
                            return reject(err); 
                        }
                    });
                    return;
                }
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
        
        const sql = `SELECT ${selectId}, ${nameColumn} as name, '${itemType}' as type FROM ${table} WHERE ${idColumn} = ? AND user_id = ?`;
        
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
            // 覆盖时执行物理删除
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
                // 成功合并后，物理删除空的源文件夹
                await unifiedDelete(sourceItemId, 'folder', userId);
            }
            
            return report;

        default: // 'move'
            await moveItems(itemType === 'file' ? [sourceItemId] : [], itemType === 'folder' ? [sourceItemId] : [], targetFolderId, userId);
            report.moved++;
            return report;
    }
}

// 修改 unifiedDelete 以支持直接传入 ID 数组 (重载)，执行物理删除
async function unifiedDelete(itemId, itemType, userId, explicitFileIds = null, explicitFolderIds = null) {
    const storage = require('./storage').getStorage();
    let filesForStorage = [];
    let foldersForStorage = [];
    
    if (explicitFileIds || explicitFolderIds) {
        // 批量模式
        if (explicitFileIds && explicitFileIds.length > 0) {
             const directFiles = await getFilesByIds(explicitFileIds, userId);
             filesForStorage.push(...directFiles);
        }
        // 文件夹需要递归获取内容来物理删除
        if (explicitFolderIds && explicitFolderIds.length > 0) {
             for(const fid of explicitFolderIds) {
                 const deletionData = await getFolderDeletionData(fid, userId);
                 filesForStorage.push(...deletionData.files);
                 foldersForStorage.push(...deletionData.folders);
             }
        }
    } else {
        // 单项模式 (旧逻辑)
        if (itemType === 'folder') {
            const deletionData = await getFolderDeletionData(itemId, userId);
            filesForStorage.push(...deletionData.files);
            foldersForStorage.push(...deletionData.folders);
        } else {
            const directFiles = await getFilesByIds([itemId], userId);
            filesForStorage.push(...directFiles);
        }
    }
    
    // 物理删除
    try {
        await storage.remove(filesForStorage, foldersForStorage, userId);
    } catch (err) {
        console.error("实体档案删除失败:", err);
    }
    
    // 数据库物理删除
    const fileIdsToDelete = filesForStorage.map(f => BigInt(f.message_id));
    let folderIdsToDelete = foldersForStorage.map(f => f.id);
    
    if (explicitFolderIds) {
        folderIdsToDelete = [...new Set([...folderIdsToDelete, ...explicitFolderIds])];
    } else if (itemType === 'folder') {
        folderIdsToDelete.push(itemId);
    }

    await executeDeletion(fileIdsToDelete, folderIdsToDelete, userId);
}

async function moveItems(fileIds = [], folderIds = [], targetFolderId, userId) {
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav' || storage.type === 's3') {
        const client = storage.type === 'webdav' ? storage.getClient() : null;
        
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetFullPath = path.posix.join('/', ...targetPathParts.slice(1).map(p => p.name));

        const filesToMove = await getFilesByIds(fileIds, userId);
        for (const file of filesToMove) {
            const oldRelativePath = file.file_id;
            const newRelativePath = path.posix.join(targetFullPath, file.fileName);
            
            try {
                if (storage.type === 'local') {
                    const oldFullPath = path.join(UPLOAD_DIR, String(userId), oldRelativePath.replace(/^[\/\\]/, ''));
                    const newFullPath = path.join(UPLOAD_DIR, String(userId), newRelativePath.replace(/^[\/\\]/, ''));
                    
                    if (fsSync.existsSync(oldFullPath)) {
                        await fs.mkdir(path.dirname(newFullPath), { recursive: true });
                        await fs.rename(oldFullPath, newFullPath);
                    }
                } else if (client) {
                    await client.moveFile(oldRelativePath, newRelativePath);
                }
                
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [newRelativePath, file.message_id.toString()], (e) => e ? rej(e) : res()));

            } catch (err) {
                throw new Error(`物理移动文件 ${file.fileName} 失败: ${err.message}`);
            }
        }
        
        const foldersToMove = (await getItemsByIds(folderIds, userId)).filter(i => i.type === 'folder');
        for (const folder of foldersToMove) {
            const oldPathParts = await getFolderPath(folder.id, userId);
            const oldFullPath = path.posix.join('/', ...oldPathParts.slice(1).map(p => p.name));
            const newFullPath = path.posix.join(targetFullPath, folder.name);

            try {
                 if (storage.type === 'local') {
                    const oldAbsPath = path.join(UPLOAD_DIR, String(userId), oldFullPath.replace(/^[\/\\]/, ''));
                    const newAbsPath = path.join(UPLOAD_DIR, String(userId), newFullPath.replace(/^[\/\\]/, ''));
                    if (fsSync.existsSync(oldAbsPath)) {
                       await fs.mkdir(path.dirname(newAbsPath), { recursive: true });
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
                throw new Error(`物理移动文件夹 ${folder.name} 失败: ${err.message}`);
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
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ?`;
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
        return path.posix.join('/', ...pathParts);
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


function addFile(fileData, folderId = 1, userId, storageType) {
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
    
    const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    
    return new Promise((resolve, reject) => {
        db.all(sql, [...stringMessageIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getFileByShareToken(token) {
    const getShareSql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, share_password, share_expires_at FROM files WHERE share_token = ?`;
    
    const row = await new Promise((resolve, reject) => {
        db.get(getShareSql, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });

    if (!row) {
        return null;
    }

    const isExpired = row.share_expires_at && Date.now() > row.share_expires_at;

    if (isExpired) {
        return null; 
    }
    
    return row;
}

async function getFolderByShareToken(token) {
    const getShareSql = "SELECT *, password as share_password FROM folders WHERE share_token = ?";

    const row = await new Promise((resolve, reject) => {
        db.get(getShareSql, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });

    if (!row) {
        return null;
    }

    const isExpired = row.share_expires_at && Date.now() > row.share_expires_at;

    if (isExpired) {
        return null; 
    }

    return row;
}

async function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        const sql = `
            WITH RECURSIVE shared_folder_tree(id) AS (
                SELECT id FROM folders WHERE share_token = ? AND password IS NULL
                UNION ALL
                SELECT f.id FROM folders f
                JOIN shared_folder_tree sft ON f.parent_id = sft.id
                WHERE f.password IS NULL
            )
            SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files f
            WHERE f.message_id = ? AND f.folder_id IN (SELECT id FROM shared_folder_tree);
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

    if (storage.type === 'local' || storage.type === 'webdav' || storage.type === 's3') {
        const oldRelativePath = file.file_id;
        const newRelativePath = path.posix.join(path.posix.dirname(oldRelativePath), newFileName);

        try {
            if (storage.type === 'local') {
                const userDir = path.join(UPLOAD_DIR, String(userId));
                const oldFullPath = path.join(userDir, oldRelativePath.replace(/^[\/\\]/, ''));
                const newFullPath = path.join(userDir, newRelativePath.replace(/^[\/\\]/, ''));
                
                if (fsSync.existsSync(oldFullPath)) {
                    await fs.rename(oldFullPath, newFullPath);
                }
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldRelativePath, newRelativePath);
            }
        } catch(err) {
            throw new Error(`实体档案重新命名失败: ${err.message}`);
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
    if (storage.type === 'local' || storage.type === 'webdav' || storage.type === 's3') {
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetRelativePath = path.posix.join('/', ...targetPathParts.slice(1).map(p => p.name));
        const newRelativePath = path.posix.join(targetRelativePath, newFileName);
        const oldRelativePath = file.file_id;
        
        try {
            if (storage.type === 'local') {
                 const userDir = path.join(UPLOAD_DIR, String(userId));
                 const oldFullPath = path.join(userDir, oldRelativePath.replace(/^[\/\\]/, ''));
                 const newFullPath = path.join(userDir, newRelativePath.replace(/^[\/\\]/, ''));
                 
                 if (fsSync.existsSync(oldFullPath)) {
                    await fs.mkdir(path.dirname(newFullPath), { recursive: true });
                    await fs.rename(oldFullPath, newFullPath);
                 }
            } else if (storage.type === 'webdav') {
                const client = storage.getClient();
                await client.moveFile(oldRelativePath, newRelativePath);
            }
        } catch(err) {
            throw new Error(`实体档案移动并重命名失败: ${err.message}`);
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
    const folder = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=? AND user_id=?", [folderId, userId], (e,r)=>e?rej(e):res(r)));
    if (!folder) return { success: false, message: '资料夾未找到。'};
    
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav' || storage.type === 's3') {
        const oldPathParts = await getFolderPath(folderId, userId);
        const oldFullPath = path.posix.join('/', ...oldPathParts.slice(1).map(p => p.name));
        const newFullPath = path.posix.join(path.posix.dirname(oldFullPath), newFolderName);

        try {
            if (storage.type === 'local') {
                const userDir = path.join(UPLOAD_DIR, String(userId));
                const oldAbsPath = path.join(userDir, oldFullPath.replace(/^[\/\\]/, ''));
                const newAbsPath = path.join(userDir, newFullPath.replace(/^[\/\\]/, ''));
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
                throw new Error(`物理资料夹重新命名失败: ${e.message}`);
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
    if (storage.type === 'local' || storage.type === 'webdav' || storage.type === 's3') {
        const oldPathParts = await getFolderPath(folderId, userId);
        const oldFullPath = path.posix.join('/', ...oldPathParts.slice(1).map(p => p.name));

        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetBasePath = path.posix.join('/', ...targetPathParts.slice(1).map(p => p.name));
        const newFullPath = path.posix.join(targetBasePath, newName);

        try {
            if (storage.type === 'local') {
                 const userDir = path.join(UPLOAD_DIR, String(userId));
                 const oldAbsPath = path.join(userDir, oldFullPath.replace(/^[\/\\]/, ''));
                 const newAbsPath = path.join(userDir, newFullPath.replace(/^[\/\\]/, ''));
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
        const sqlFiles = `SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type, share_token, share_expires_at FROM files WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`;
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
        const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID} FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ? AND is_deleted = 0`;
        db.get(sql, [fileName, folderId, userId], (err, row) => {
            if (err) return reject(err);
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
        const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID} FROM files WHERE file_id = ? AND user_id = ?`;
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
            // 修正：这里调用增强版 createFolder，它会自动处理软删除恢复
            const result = await createFolder(part, parentId, userId);
            parentId = result.id;
        }
    }
    return parentId;
}

// 修正：resolvePathToFolderId 处理 UNIQUE 错误，自动尝试恢复已删除文件夹
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
                    // 查询包含已删除的记录
                    const selectSql = `SELECT id, is_deleted FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
                    db.get(selectSql, [part, currentParentId, userId], (err, row) => {
                        if (err) return reject(err);
                        
                        if (row) {
                            if (row.is_deleted) {
                                // 恢复
                                db.run("UPDATE folders SET is_deleted = 0 WHERE id = ?", [row.id], (err2) => {
                                    if(err2) return reject(err2);
                                    resolve(row.id);
                                });
                            } else {
                                resolve(row.id);
                            }
                            return;
                        }
                        
                        const insertSql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
                        db.run(insertSql, [part, currentParentId, userId], function(err) {
                            if (err) {
                                // 处理并发下的 UNIQUE 错误
                                if (err.message.includes('UNIQUE')) {
                                    // 再次尝试查询 (递归一次即可)
                                    db.get(selectSql, [part, currentParentId, userId], (retryErr, retryRow) => {
                                        if (retryErr) return reject(retryErr);
                                        if (retryRow) {
                                            if (retryRow.is_deleted) {
                                                db.run("UPDATE folders SET is_deleted = 0 WHERE id = ?", [retryRow.id], (e) => e ? reject(e) : resolve(retryRow.id));
                                            } else {
                                                resolve(retryRow.id);
                                            }
                                        } else {
                                            reject(err);
                                        }
                                    });
                                    return;
                                }
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
    updateFile,
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
    renameAndMoveFolder,
    getFolderDetails,
    setFolderPassword,
    verifyFolderPassword,
    isFileAccessible,
    findFolderBySharePath,
    createAuthToken,
    findAuthToken,
    deleteAuthToken,
    deleteExpiredAuthTokens,
    getUserQuota,
    checkQuota,
    getTrashContents,
    softDeleteItems,
    restoreItems,
    cleanupTrash,
    listAllUsersWithQuota,
    setMaxStorageForUser
};
