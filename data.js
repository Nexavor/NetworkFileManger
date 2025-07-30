// nexavor/networkfilemanger/NetworkFileManger-ece0c16c1ce8238333a40fd0f76eda3f8fdfe55f/data.js
const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');

async function findUserByName(username) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findUserById(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE id = ?", [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function createUser(username, hashedPassword) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
        db.run(sql, [username, hashedPassword], function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, username });
        });
    });
}

async function listNormalUsers() {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username", (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function listAllUsers() {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username, is_admin FROM users ORDER BY is_admin DESC, username ASC", (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}


async function changeUserPassword(userId, hashedPassword) {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId], function(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes });
        });
    });
}

async function deleteUser(userId) {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM users WHERE id = ? AND is_admin = 0", [userId], function (err) {
            if (err) return reject(err);
            resolve({ deleted: this.changes });
        });
    });
}


async function getRootFolder(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}


async function getFolderContents(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT 
                id, name, NULL as message_id, NULL as fileName, NULL as size, NULL as date, 'folder' as type, NULL as thumb_file_id
            FROM folders 
            WHERE parent_id = ? AND user_id = ?
            UNION ALL
            SELECT 
                NULL as id, fileName as name, message_id, fileName, size, date, 'file' as type, thumb_file_id
            FROM files 
            WHERE folder_id = ? AND user_id = ?
            ORDER BY type DESC, name COLLATE NOCASE ASC
        `;
        db.all(sql, [folderId, userId, folderId, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getFolderPath(folderId, userId) {
    const path = [];
    let currentFolderId = folderId;

    while (currentFolderId) {
        const folder = await new Promise((resolve, reject) => {
            db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [currentFolderId, userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (folder) {
            path.unshift({ id: folder.id, name: folder.name });
            currentFolderId = folder.parent_id;
        } else {
            break;
        }
    }
    return path;
}

async function createFolder(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
        db.run(sql, [name, parentId, userId], function (err) {
            if (err) return reject(err);
            resolve({ success: true, id: this.lastID, name, type: 'folder' });
        });
    });
}

async function addFile(file, folderId, userId, storageType = 'telegram') {
    return new Promise((resolve, reject) => {
        const { message_id, fileName, mimetype, size, file_id, thumb_file_id, date } = file;
        const sql = `
            INSERT INTO files (message_id, fileName, mimetype, size, file_id, thumb_file_id, folder_id, user_id, date, storage_type) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        db.run(sql, [message_id, fileName, mimetype, size, file_id, thumb_file_id, folderId, userId, date, storageType], function(err) {
            if (err) return reject(err);
            resolve({ success: true, fileId: message_id });
        });
    });
}

async function deleteFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) return { deleted: 0 };
    return new Promise((resolve, reject) => {
        const placeholders = messageIds.map(() => '?').join(',');
        const sql = `DELETE FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
        db.run(sql, [...messageIds, userId], function (err) {
            if (err) return reject(err);
            resolve({ deleted: this.changes });
        });
    });
}

async function findFileInFolder(fileName, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?";
        db.get(sql, [fileName, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function resolvePathToFolderId(initialFolderId, pathParts, userId) {
    let currentFolderId = initialFolderId;
    for (const part of pathParts) {
        if (!part) continue; // Skip empty parts
        let folder = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?", [part, currentFolderId, userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        if (!folder) {
            const result = await createFolder(part, currentFolderId, userId);
            folder = { id: result.id };
        }
        currentFolderId = folder.id;
    }
    return currentFolderId;
}

async function findFolderByPath(initialFolderId, pathParts, userId) {
    let currentFolderId = initialFolderId;
    for (const part of pathParts) {
        if (!part) continue;
        const folder = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?", [part, currentFolderId, userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!folder) {
            return null;
        }
        currentFolderId = folder.id;
    }
    return currentFolderId;
}

async function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const searchTerm = `%${query}%`;
        const sql = `
            SELECT 
                id, name, NULL as message_id, NULL as fileName, NULL as size, NULL as date, 'folder' as type, NULL as thumb_file_id
            FROM folders 
            WHERE name LIKE ? AND user_id = ?
            UNION ALL
            SELECT 
                NULL as id, fileName as name, message_id, fileName, size, date, 'file' as type, thumb_file_id
            FROM files 
            WHERE fileName LIKE ? AND user_id = ?
            ORDER BY type DESC, name COLLATE NOCASE ASC
        `;
        db.all(sql, [searchTerm, userId, searchTerm, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getFilesByIds(messageIds, userId) {
    return new Promise((resolve, reject) => {
        if (!messageIds || messageIds.length === 0) return resolve([]);
        const placeholders = messageIds.map(() => '?').join(',');
        const sql = `SELECT *, 'file' as type FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
        db.all(sql, [...messageIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getFoldersByIds(folderIds, userId) {
    return new Promise((resolve, reject) => {
        if (!folderIds || folderIds.length === 0) return resolve([]);
        const placeholders = folderIds.map(() => '?').join(',');
        const sql = `SELECT *, 'folder' as type FROM folders WHERE id IN (${placeholders}) AND user_id = ?`;
        db.all(sql, [...folderIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getItemsByIds(itemIds, userId) {
    const fileIds = [];
    const folderIds = [];
    for (const itemId of itemIds) {
        if (itemId.startsWith('folder-')) {
            folderIds.push(parseInt(itemId.replace('folder-', ''), 10));
        } else {
            fileIds.push(parseInt(itemId, 10));
        }
    }
    const files = await getFilesByIds(fileIds, userId);
    const folders = await getFoldersByIds(folderIds, userId);
    return [...files, ...folders];
}


async function getFolderDeletionData(folderId, userId) {
    const filesToDelete = [];
    const foldersToDelete = [];

    async function recurse(currentFolderId) {
        const folder = await new Promise((resolve, reject) => {
             db.get("SELECT id, name FROM folders WHERE id = ? AND user_id = ?", [currentFolderId, userId], (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        if(folder) foldersToDelete.push(folder);

        const childrenFiles = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM files WHERE folder_id = ? AND user_id = ?", [currentFolderId, userId], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
        filesToDelete.push(...childrenFiles);

        const subFolders = await new Promise((resolve, reject) => {
            db.all("SELECT id FROM folders WHERE parent_id = ? AND user_id = ?", [currentFolderId, userId], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
        for (const sub of subFolders) {
            await recurse(sub.id);
        }
    }
    await recurse(folderId);
    return { files: filesToDelete, folders: foldersToDelete };
}

async function executeDeletion(fileIds, folderIds, userId) {
     return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION", (err) => { if(err) return reject(err); });

            const deleteFilesSql = `DELETE FROM files WHERE message_id IN (${fileIds.map(()=>'?').join(',')}) AND user_id = ?`;
            if (fileIds.length > 0) {
                db.run(deleteFilesSql, [...fileIds, userId], (err) => { if(err) return db.run("ROLLBACK", () => reject(err)); });
            }

            const deleteFoldersSql = `DELETE FROM folders WHERE id IN (${folderIds.map(()=>'?').join(',')}) AND user_id = ?`;
            if (folderIds.length > 0) {
                 db.run(deleteFoldersSql, [...folderIds, userId], (err) => { if(err) return db.run("ROLLBACK", () => reject(err)); });
            }

            db.run("COMMIT", (err) => {
                if(err) return db.run("ROLLBACK", () => reject(err));
                resolve({ success: true });
            });
        });
    });
}

async function renameFile(messageId, newName, userId) {
    return new Promise((resolve, reject) => {
        const sql = "UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?";
        db.run(sql, [newName, messageId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: this.changes > 0 });
        });
    });
}

async function renameFolder(folderId, newName, userId) {
    return new Promise((resolve, reject) => {
        const sql = "UPDATE folders SET name = ? WHERE id = ? AND user_id = ?";
        db.run(sql, [newName, folderId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: this.changes > 0 });
        });
    });
}

async function moveItem(itemId, itemType, targetFolderId, userId, { overwriteList = [], mergeList = [] } = {}) {
    if (itemType === 'file') {
        const fileName = (await getFilesByIds([itemId], userId))[0].fileName;
        const conflict = await findFileInFolder(fileName, targetFolderId, userId);
        if (conflict) {
            await deleteFilesByIds([conflict.message_id], userId);
        }
        return db.run("UPDATE files SET folder_id = ? WHERE message_id = ? AND user_id = ?", [targetFolderId, itemId, userId]);
    } else if (itemType === 'folder') {
        const folderId = parseInt(itemId.replace('folder-', ''), 10);
        const folderName = (await getFoldersByIds([folderId], userId))[0].name;

        const conflict = await findFolderByName(folderName, targetFolderId, userId);

        if (conflict) {
            if (mergeList.includes(folderName)) {
                const sourceChildren = await getChildrenOfFolder(folderId, userId);
                for(const child of sourceChildren) {
                    await moveItem(child.type === 'file' ? child.message_id : `folder-${child.id}`, child.type, conflict.id, userId, { overwriteList, mergeList });
                }
                return db.run("DELETE FROM folders WHERE id = ? AND user_id = ?", [folderId, userId]);
            } else {
                 await db.run("DELETE FROM folders WHERE id = ? AND user_id = ?", [conflict.id, userId]);
            }
        }
        return db.run("UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?", [targetFolderId, folderId, userId]);
    }
}

async function getChildrenOfFolder(folderId, userId) {
     return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, name, NULL as message_id, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ?
            UNION ALL
            SELECT id, name, message_id, 'file' as type FROM files WHERE folder_id = ? AND user_id = ?
        `;
        db.all(sql, [folderId, userId, folderId, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function findFolderByName(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?";
        db.get(sql, [name, parentId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}


async function checkFullConflict(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT 1 FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?
            UNION ALL
            SELECT 1 FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
        `;
        db.get(sql, [name, parentId, userId, name, parentId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

async function getConflictingItems(itemNames, targetFolderId, userId) {
    return new Promise((resolve, reject) => {
        const placeholders = itemNames.map(() => '?').join(',');
        const sql = `
            SELECT name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND fileName IN (${placeholders})
            UNION ALL
            SELECT name, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ? AND name IN (${placeholders})
        `;
        db.all(sql, [targetFolderId, userId, ...itemNames, targetFolderId, userId, ...itemNames], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function getAllFolders(userId) {
    return new Promise((resolve, reject) => {
        const folders = [];
        db.each("SELECT id, name, parent_id FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC", [userId], (err, row) => {
            if (err) return reject(err);
            folders.push(row);
        }, (err) => {
            if (err) return reject(err);
            resolve(folders);
        });
    });
}

async function createShareLink(itemId, itemType, expiresIn, userId) {
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + expiresIn * 24 * 60 * 60 * 1000;
    const tableName = itemType === 'file' ? 'files' : 'folders';
    const idColumn = itemType === 'file' ? 'message_id' : 'id';

    return new Promise((resolve, reject) => {
        const sql = `UPDATE ${tableName} SET share_token = ?, share_expires_at = ? WHERE ${idColumn} = ? AND user_id = ?`;
        db.run(sql, [token, expiresAt, itemId, userId], function (err) {
            if (err) return reject(err);
            if (this.changes > 0) {
                resolve({ success: true, token });
            } else {
                resolve({ success: false, message: '找不到项目或权限不足' });
            }
        });
    });
}


async function getFileByShareToken(token) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM files WHERE share_token = ? AND share_expires_at > ?`;
        db.get(sql, [token, Date.now()], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

async function getFolderByShareToken(token) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM folders WHERE share_token = ? AND share_expires_at > ?`;
        db.get(sql, [token, Date.now()], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}


async function getActiveShares(userId) {
     return new Promise((resolve, reject) => {
        const now = Date.now();
        const sql = `
            SELECT id, name, share_token, share_expires_at, 'folder' as type FROM folders WHERE user_id = ? AND share_token IS NOT NULL AND share_expires_at > ?
            UNION ALL
            SELECT message_id as id, fileName as name, share_token, share_expires_at, 'file' as type FROM files WHERE user_id = ? AND share_token IS NOT NULL AND share_expires_at > ?
        `;
        db.all(sql, [userId, now, userId, now], (err, rows) => {
            if(err) reject(err);
            else resolve(rows);
        });
    });
}

async function cancelShare(itemId, itemType, userId) {
     return new Promise((resolve, reject) => {
        const tableName = itemType === 'file' ? 'files' : 'folders';
        const idColumn = itemType === 'file' ? 'message_id' : 'id';
        const sql = `UPDATE ${tableName} SET share_token = NULL, share_expires_at = NULL WHERE ${idColumn} = ? AND user_id = ?`;
        db.run(sql, [itemId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: this.changes > 0 });
        });
    });
}

async function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT f.* FROM files f
            JOIN folders fo ON f.folder_id = fo.id
            WHERE f.message_id = ? AND fo.share_token = ? AND fo.share_expires_at > ?
        `;
        db.get(sql, [fileId, folderToken, Date.now()], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

async function getFilesRecursive(folderId, userId, currentPath = '') {
    let files = [];
    const children = await getFolderContents(folderId, userId);
    for (const child of children) {
        const newPath = path.posix.join(currentPath, child.name);
        if (child.type === 'file') {
            files.push({ ...child, path: newPath });
        } else if (child.type === 'folder') {
            const nestedFiles = await getFilesRecursive(child.id, userId, newPath);
            files = files.concat(nestedFiles);
        }
    }
    return files;
}

async function findFileByFileId(fileId, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM files WHERE file_id = ? AND user_id = ?", [fileId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findOrCreateFolderByPath(folderPath, userId) {
    const rootFolder = await getRootFolder(userId);
    if (!rootFolder) throw new Error('Cannot find root folder for user');
    if (folderPath === '' || folderPath === '/') return rootFolder.id;

    const pathParts = folderPath.split('/').filter(p => p);
    return resolvePathToFolderId(rootFolder.id, pathParts, userId);
}

async function getFirstFileInFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT file_id 
            FROM files 
            WHERE folder_id = ? AND user_id = ?
            LIMIT 1
        `;
        db.get(sql, [folderId, userId], (err, row) => {
            if (err) return reject(new Error('查询资料夹中档案时出错: ' + err.message));
            resolve(row);
        });
    });
}


module.exports = {
    findUserByName,
    findUserById,
    createUser,
    listNormalUsers,
    listAllUsers,
    changeUserPassword,
    deleteUser,
    getRootFolder,
    getFolderContents,
    getFolderPath,
    createFolder,
    addFile,
    deleteFilesByIds,
    findFileInFolder,
    resolvePathToFolderId,
    findFolderByPath,
    searchItems,
    getFilesByIds,
    getItemsByIds,
    getFoldersByIds,
    getFolderDeletionData,
    executeDeletion,
    renameFile,
    renameFolder,
    moveItem,
    getChildrenOfFolder,
    findFolderByName,
    checkFullConflict,
    getConflictingItems,
    getAllFolders,
    createShareLink,
    getFileByShareToken,
    getFolderByShareToken,
    getActiveShares,
    cancelShare,
    findFileInSharedFolder,
    getFilesRecursive,
    findFileByFileId,
    findOrCreateFolderByPath,
    getFirstFileInFolder
};
