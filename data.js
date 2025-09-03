const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const bcrypt = require('bcrypt');
const { encryptId } = require('./crypto-utils'); // 引入加密函式

// --- 使用者管理 ---
function createUser(username, password) {
    return new Promise((resolve, reject) => {
        db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, password], function(err) {
            if (err) return reject(err);
            resolve({ id: this.lastID });
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
        db.run("UPDATE users SET password = ? WHERE id = ?", [newHashedPassword, userId], function(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes });
        });
    });
}
function listNormalUsers() {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username", (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function listAllUsers() {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username, is_admin FROM users ORDER BY username", (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function deleteUser(userId) {
    const userDir = path.join(__dirname, 'data', 'uploads', String(userId));
    try {
        if (fsSync.existsSync(userDir)) {
            await fs.rm(userDir, { recursive: true, force: true });
        }
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM users WHERE id = ?", [userId], function(err) {
                if (err) return reject(err);
                resolve({ changes: this.changes });
            });
        });
    } catch (error) {
        throw new Error('删除使用者资料时发生错误: ' + error.message);
    }
}


// --- 档案与资料夾搜寻 ---
function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT 'file' as type, message_id as id, fileName as name, size, date, folder_id, mimetype, storage_type, thumb_file_id
            FROM files 
            WHERE user_id = ? AND fileName LIKE ?
            UNION ALL
            SELECT 'folder' as type, id, name, NULL as size, NULL as date, parent_id as folder_id, NULL as mimetype, NULL as storage_type, NULL as thumb_file_id
            FROM folders 
            WHERE user_id = ? AND name LIKE ?
            ORDER BY type DESC, name ASC
        `;
        const searchTerm = `%${query}%`;
        db.all(sql, [userId, searchTerm, userId, searchTerm], (err, rows) => {
            if (err) return reject(err);
            const folders = rows.filter(r => r.type === 'folder');
            const files = rows.filter(r => r.type === 'file');
            resolve({ folders, files });
        });
    });
}

// --- 核心资料夾与档案函式 ---
function getFolderContents(folderId, userId) {
    return new Promise((resolve, reject) => {
        const foldersSql = "SELECT id, name, parent_id, is_locked, 'folder' as type FROM folders WHERE user_id = ? AND parent_id = ?";
        const filesSql = "SELECT message_id as id, fileName as name, size, date, mimetype, storage_type, thumb_file_id, 'file' as type FROM files WHERE user_id = ? AND folder_id = ?";
        
        Promise.all([
            new Promise((res, rej) => db.all(foldersSql, [userId, folderId], (err, rows) => err ? rej(err) : res(rows || []))),
            new Promise((res, rej) => db.all(filesSql, [userId, folderId], (err, rows) => err ? rej(err) : res(rows || [])))
        ]).then(([folders, files]) => {
            resolve({ folders, files });
        }).catch(reject);
    });
}

async function getFilesRecursive(folderId, userId, basePath = '') {
    let files = [];
    const contents = await getFolderContents(folderId, userId);
    
    for (const file of contents.files) {
        files.push({ ...file, path: path.posix.join(basePath, file.name) });
    }
    
    for (const subFolder of contents.folders) {
        const subFiles = await getFilesRecursive(subFolder.id, userId, path.posix.join(basePath, subFolder.name));
        files.push(...subFiles);
    }
    
    return files;
}

function getFolderPath(folderId, userId) {
    let pathArr = [];
    return new Promise((resolve, reject) => {
        function findParent(id) {
            if (!id) {
                // 如果路径为空 (例如，根目录的父目录)，确保根目录本身被加入
                if (pathArr.length === 0) {
                    db.get("SELECT id, name, parent_id FROM folders WHERE user_id = ? AND id = ?", [userId, folderId], (err, folder) => {
                         if (folder) pathArr.push({ id: folder.id, name: folder.name, encryptedId: encryptId(folder.id) });
                         resolve(pathArr.reverse());
                    });
                } else {
                    return resolve(pathArr.reverse());
                }
                return;
            }
            db.get("SELECT id, name, parent_id FROM folders WHERE user_id = ? AND id = ?", [userId, id], (err, folder) => {
                if (err) return reject(err);
                if (folder) {
                    pathArr.push({ id: folder.id, name: folder.name, encryptedId: encryptId(folder.id) });
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
    return new Promise((resolve, reject) => {
        db.run("INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)", [name, parentId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, id: this.lastID, name: name, type: 'folder' });
        });
    });
}
function findFolderByName(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?", [name, parentId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function getAllFolders(userId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, name, parent_id FROM folders WHERE user_id = ? ORDER BY name", [userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getAllDescendantFolderIds(folderId, userId) {
    return new Promise(async (resolve, reject) => {
        let ids = [folderId];
        let queue = [folderId];
        try {
            while (queue.length > 0) {
                const currentId = queue.shift();
                const children = await new Promise((res, rej) => {
                    db.all("SELECT id FROM folders WHERE parent_id = ? AND user_id = ?", [currentId, userId], (err, rows) => {
                        if(err) return rej(err);
                        res(rows);
                    });
                });
                const childIds = children.map(c => c.id);
                ids.push(...childIds);
                queue.push(...childIds);
            }
            resolve(ids);
        } catch (error) {
            reject(error);
        }
    });
}

async function getFolderDeletionData(folderId, userId) {
    const folderIdsToDelete = await getAllDescendantFolderIds(folderId, userId);
    const filesToDelete = await new Promise((resolve, reject) => {
        const placeholders = folderIdsToDelete.map(() => '?').join(',');
        const sql = `SELECT message_id as id, storage_type, file_id FROM files WHERE folder_id IN (${placeholders}) AND user_id = ?`;
        db.all(sql, [...folderIdsToDelete, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
    return { folderIdsToDelete, filesToDelete };
}

async function executeDeletion(folderIds, fileIds, userId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION", (err) => { if(err) return reject(err); });

            const deleteFilesStmt = db.prepare("DELETE FROM files WHERE message_id = ? AND user_id = ?");
            fileIds.forEach(id => deleteFilesStmt.run(id, userId));
            deleteFilesStmt.finalize();
            
            const deleteFoldersStmt = db.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?");
            folderIds.forEach(id => deleteFoldersStmt.run(id, userId));
            deleteFoldersStmt.finalize();

            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return reject(err);
                }
                resolve();
            });
        });
    });
}

async function deleteSingleFolder(folderId, userId) {
    // 确保资料夾是空的
    const contents = await getFolderContents(folderId, userId);
    if (contents.folders.length > 0 || contents.files.length > 0) {
        throw new Error("资料夾不是空的，无法删除。");
    }

    return new Promise((resolve, reject) => {
        db.run("DELETE FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], function(err) {
            if (err) return reject(err);
            if (this.changes === 0) return reject(new Error("找不到要删除的资料夾或权限不足。"));
            resolve({ success: true, message: '资料夾删除成功' });
        });
    });
}

function addFile({ message_id, fileName, mimetype, size, file_id, thumb_file_id, date, caption }, folder_id, user_id, storage_type) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO files 
            (message_id, fileName, mimetype, size, file_id, thumb_file_id, date, caption, folder_id, user_id, storage_type) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        db.run(sql, [
            message_id, fileName, mimetype, size, file_id, thumb_file_id, date, caption, folder_id, user_id, storage_type
        ], function(err) {
            if (err) return reject(err);
            resolve({ success: true, fileId: message_id });
        });
    });
}
function updateFile(messageId, { fileName, size, date, file_id }, userId) {
    return new Promise((resolve, reject) => {
        const sql = "UPDATE files SET fileName = ?, size = ?, date = ?, file_id = ? WHERE message_id = ? AND user_id = ?";
        db.run(sql, [fileName, size, date, file_id, messageId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

function getFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const placeholders = messageIds.map(() => '?').join(',');
        const sql = `SELECT *, message_id as id, fileName as name FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
        db.all(sql, [...messageIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getItemsByIds(itemIds, userId) {
    if (!itemIds || itemIds.length === 0) return Promise.resolve([]);
    const placeholders = itemIds.map(() => '?').join(',');
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT 'file' as type, message_id as id, fileName as name, folder_id
            FROM files 
            WHERE user_id = ? AND message_id IN (${placeholders})
            UNION ALL
            SELECT 'folder' as type, id, name, parent_id as folder_id
            FROM folders 
            WHERE user_id = ? AND id IN (${placeholders})
        `;
        db.all(sql, [userId, ...itemIds, userId, ...itemIds], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}


function getChildrenOfFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT 'file' as type, message_id as id, fileName as name FROM files WHERE folder_id = ? AND user_id = ?
            UNION ALL
            SELECT 'folder' as type, id, name FROM folders WHERE parent_id = ? AND user_id = ?
        `;
        db.all(sql, [folderId, userId, folderId, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}


// --- 移动、重命名、删除 ---
async function moveItems(itemIds, targetFolderId, userId) {
    if (!itemIds || itemIds.length === 0) return;
    const items = await getItemsByIds(itemIds, userId);
    
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION", (err) => { if(err) return reject(err); });
            const fileStmt = db.prepare("UPDATE files SET folder_id = ? WHERE message_id = ? AND user_id = ?");
            const folderStmt = db.prepare("UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?");
            items.forEach(item => {
                if(item.type === 'file') fileStmt.run(targetFolderId, item.id, userId);
                else folderStmt.run(targetFolderId, item.id, userId);
            });
            fileStmt.finalize();
            folderStmt.finalize();
            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return reject(err);
                }
                resolve();
            });
        });
    });
}

async function renameAndMoveFile(fileId, newName, targetFolderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = "UPDATE files SET fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?";
        db.run(sql, [newName, targetFolderId, fileId, userId], function(err) {
            if (err) return reject(err);
            if (this.changes === 0) return reject(new Error('档案找不到或权限不足'));
            resolve({ success: true });
        });
    });
}

async function moveItem(itemId, itemType, targetFolderId, userId, options = {}) {
    const { resolutions = {} } = options;
    let report = { moved: 0, skipped: 0, errors: 0 };
    
    async function handleFolderMove(folderId, destId) {
        const folderInfo = (await getItemsByIds([folderId], userId))[0];
        const conflict = await findFolderByName(folderInfo.name, destId, userId);

        if (conflict) {
            const resolution = resolutions[folderInfo.name];
            if (resolution === 'skip') {
                report.skipped++;
                return;
            } else if (resolution === 'merge') {
                const subItems = await getChildrenOfFolder(folderId, userId);
                for (const subItem of subItems) {
                    if (subItem.type === 'folder') {
                        await handleFolderMove(subItem.id, conflict.id);
                    } else {
                        await handleFileMove(subItem.id, conflict.id);
                    }
                }
                await unifiedDelete(folderId, 'folder', userId, { skipStorage: true });
                return;
            } else if (resolution === 'overwrite') {
                 await unifiedDelete(conflict.id, 'folder', userId);
            }
        }
        await new Promise((res, rej) => db.run("UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?", [destId, folderId, userId], (err) => err ? rej(err) : res()));
        report.moved++;
    }

    async function handleFileMove(fileId, destId) {
        const fileInfo = (await getItemsByIds([fileId], userId))[0];
        const conflict = await findFileInFolder(fileInfo.name, destId, userId);

        if (conflict) {
            const resolution = resolutions[fileInfo.name];
            if (resolution === 'skip') {
                report.skipped++;
                return;
            } else if (resolution === 'overwrite') {
                await unifiedDelete(conflict.id, 'file', userId);
            } else if (resolution === 'rename') {
                 const newName = await findAvailableName(fileInfo.name, destId, userId, false);
                 await renameAndMoveFile(fileId, newName, destId, userId);
                 report.moved++;
                 return; // 因为已经处理，所以提前返回
            }
        }
        await new Promise((res, rej) => db.run("UPDATE files SET folder_id = ? WHERE message_id = ? AND user_id = ?", [destId, fileId, userId], (err) => err ? rej(err) : res()));
        report.moved++;
    }

    try {
        if (itemType === 'folder') {
            await handleFolderMove(itemId, targetFolderId);
        } else {
            await handleFileMove(itemId, targetFolderId);
        }
    } catch (err) {
        report.errors++;
    }

    return report;
}

// --- 分享功能 ---
function getFileByShareToken(token) {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT f.*, f.fileName as name 
            FROM files f JOIN shares s ON f.message_id = s.item_id AND s.type = 'file'
            WHERE s.share_token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
        `, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}
function getFolderByShareToken(token) {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT fo.*, fo.name as name
            FROM folders fo JOIN shares s ON fo.id = s.item_id AND s.type = 'folder'
            WHERE s.share_token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
        `, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT f.*
            FROM files f
            INNER JOIN shares s ON s.share_token = ? AND s.type = 'folder'
            WHERE f.message_id = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
        `;
        db.get(sql, [folderToken, fileId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function createShareLink(itemId, itemType, expiresIn, userId) {
    return new Promise((resolve, reject) => {
        const token = crypto.randomBytes(16).toString('hex');
        const expires_at = expiresIn === 'never' ? null : new Date(Date.now() + parseInt(expiresIn) * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const sql = "INSERT INTO shares (item_id, type, share_token, user_id, expires_at) VALUES (?, ?, ?, ?, ?)";
        
        db.run(sql, [itemId, itemType, token, userId, expires_at], function(err) {
            if (err) return reject(err);
            resolve({ success: true, token: token });
        });
    });
}
function getActiveShares(userId) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                s.item_id, s.type, s.share_token, s.created_at, s.expires_at,
                CASE s.type
                    WHEN 'file' THEN f.fileName
                    WHEN 'folder' THEN fo.name
                END as item_name
            FROM shares s
            LEFT JOIN files f ON s.item_id = f.message_id AND s.type = 'file'
            LEFT JOIN folders fo ON s.item_id = fo.id AND s.type = 'folder'
            WHERE s.user_id = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
            ORDER BY s.created_at DESC
        `, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}
function cancelShare(itemId, itemType, userId) {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM shares WHERE item_id = ? AND type = ? AND user_id = ?", [itemId, itemType, userId], function(err) {
            if (err) return reject({ success: false, message: err.message });
            if (this.changes > 0) resolve({ success: true });
            else resolve({ success: false, message: '找不到分享记录' });
        });
    });
}

async function renameFile(id, newName, userId) {
    const [file] = await getFilesByIds([id], userId);
    if (!file) throw new Error('找不到档案或权限不足');
    
    const conflict = await findItemInFolder(newName, file.folder_id, userId);
    if (conflict) throw new Error('目标资料夾中已存在同名档案或资料夾。');
    
    return new Promise((resolve, reject) => {
        db.run("UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?", [newName, id, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true });
        });
    });
}

async function renameFolder(id, newName, userId) {
    const [folder] = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [id, userId], (e,r)=> e?rej(e):res([r])));
    if (!folder) throw new Error('找不到资料夾或权限不足。');
    if (folder.parent_id === null) throw new Error('无法重新命名根目录。');

    const conflict = await findItemInFolder(newName, folder.parent_id, userId);
    if (conflict) throw new Error('目标资料夾中已存在同名档案或资料夾。');

    return new Promise((resolve, reject) => {
        db.run("UPDATE folders SET name = ? WHERE id = ? AND user_id = ?", [newName, id, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true });
        });
    });
}

async function deleteFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) return { success: true, message: '没有档案被删除' };
    const placeholders = messageIds.map(() => '?').join(',');
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`, [...messageIds, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, message: `${this.changes} 个档案已删除` });
        });
    });
}

async function findItemInFolder(name, folderId, userId) {
    const file = await findFileInFolder(name, folderId, userId);
    if (file) return { ...file, type: 'file' };
    const folder = await findFolderByName(name, folderId, userId);
    if (folder) return { ...folder, type: 'folder' };
    return null;
}

function findFileInFolder(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT message_id as id, fileName as name FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?", [name, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function getConflictingItems(items, targetFolderId, userId) {
    const targetFolderContents = await getChildrenOfFolder(targetFolderId, userId);
    const targetFolderNames = new Set(targetFolderContents.map(i => i.name));
    
    const fileConflicts = items.filter(i => i.type === 'file' && targetFolderNames.has(i.name)).map(i => i.name);
    const folderConflicts = items.filter(i => i.type === 'folder' && targetFolderNames.has(i.name)).map(i => i.name);

    return { fileConflicts, folderConflicts };
}

async function checkFullConflict(name, parentId, userId) {
    const fileConflict = await findFileInFolder(name, parentId, userId);
    if (fileConflict) return true;
    const folderConflict = await findFolderByName(name, parentId, userId);
    if (folderConflict) return true;
    return false;
}

async function resolvePathToFolderId(initialFolderId, pathParts, userId) {
    let currentFolderId = initialFolderId;
    for (const part of pathParts) {
        if (!part) continue;
        let folder = await findFolderByName(part, currentFolderId, userId);
        if (!folder) {
            const result = await createFolder(part, currentFolderId, userId);
            folder = { id: result.id };
        }
        currentFolderId = folder.id;
    }
    return currentFolderId;
}

function findFolderByPath(initialFolderId, pathParts, userId) {
    return new Promise(async (resolve, reject) => {
        try {
            let currentFolderId = initialFolderId;
            for (const part of pathParts) {
                if (!part) continue;
                const folder = await findFolderByName(part, currentFolderId, userId);
                if (!folder) {
                    resolve(null);
                    return;
                }
                currentFolderId = folder.id;
            }
            resolve(currentFolderId);
        } catch (error) {
            reject(error);
        }
    });
}

async function getDescendantFiles(folderId, userId) {
    const folderIds = await getAllDescendantFolderIds(folderId, userId);
    const placeholders = folderIds.map(() => '?').join(',');
    const sql = `SELECT message_id as id, storage_type, file_id FROM files WHERE folder_id IN (${placeholders}) AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.all(sql, [...folderIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}
function findFileByFileId(fileId, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM files WHERE file_id = ? AND user_id = ?", [fileId, userId], (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}
async function findOrCreateFolderByPath(fullPath, userId) {
    const rootFolder = await getRootFolder(userId);
    if (!rootFolder) throw new Error("找不到根目录");

    let currentFolderId = rootFolder.id;
    if (fullPath === '.' || fullPath === '/') return currentFolderId;

    const parts = fullPath.split('/').filter(p => p);
    for (const part of parts) {
        let folder = await findFolderByName(part, currentFolderId, userId);
        if (!folder) {
            const result = await createFolder(part, currentFolderId, userId);
            currentFolderId = result.id;
        } else {
            currentFolderId = folder.id;
        }
    }
    return currentFolderId;
}
function getRootFolder(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE parent_id IS NULL AND user_id = ?", [userId], (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}
const storageManager = require('./storage');

async function unifiedDelete(itemId, itemType, userId, options = {}) {
    const { skipStorage = false } = options;
    const storage = storageManager.getStorage();

    if (itemType === 'file') {
        const [fileInfo] = await getFilesByIds([itemId], userId);
        if (fileInfo) {
            if (!skipStorage) await storage.delete(fileInfo);
            await deleteFilesByIds([itemId], userId);
        }
    } else if (itemType === 'folder') {
        const { folderIdsToDelete, filesToDelete } = await getFolderDeletionData(itemId, userId);
        if (!skipStorage) {
            for (const file of filesToDelete) {
                await storage.delete(file);
            }
        }
        await executeDeletion(folderIdsToDelete, filesToDelete.map(f => f.id), userId);
    }
}
async function findAvailableName(baseName, folderId, userId, isFolder) {
    const { name, ext } = path.parse(baseName);
    let newName = baseName;
    let counter = 1;
    while (true) {
        const conflict = await findItemInFolder(newName, folderId, userId);
        if (!conflict) return newName;
        newName = isFolder ? `${name} (${counter})` : `${name} (${counter})${ext}`;
        counter++;
    }
}
function getFolderDetails(folderId, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function setFolderPassword(folderId, hashedPassword, userId) {
    const isLocked = hashedPassword !== null;
    return new Promise((resolve, reject) => {
        db.run("UPDATE folders SET password = ?, is_locked = ? WHERE id = ? AND user_id = ?", 
            [hashedPassword, isLocked, folderId, userId], 
            function(err) {
                if (err) return reject(err);
                if (this.changes === 0) return reject(new Error('找不到资料夾或权限不足。'));
                resolve({ success: true });
            }
        );
    });
}

async function verifyFolderPassword(folderId, password, userId) {
    const folder = await getFolderDetails(folderId, userId);
    if (!folder || !folder.is_locked || !folder.password) {
        throw new Error('资料夾未加密或找不到。');
    }
    return bcrypt.compare(password, folder.password);
}
async function isFileAccessible(fileId, userId, unlockedFolderIds = []) {
    const [fileInfo] = await getFilesByIds([fileId], userId);
    if (!fileInfo) return false;

    let currentFolderId = fileInfo.folder_id;
    while (currentFolderId) {
        const folder = await getFolderDetails(currentFolderId, userId);
        if (!folder) return false; 
        if (folder.is_locked && !unlockedFolderIds.includes(folder.id)) {
            return false;
        }
        currentFolderId = folder.parent_id;
    }
    return true;
}
async function findFolderBySharePath(token, pathSegments) {
    const rootFolder = await getFolderByShareToken(token);
    if (!rootFolder) return null;

    let currentFolder = rootFolder;
    for (const segment of pathSegments) {
        const nextFolder = await findFolderByName(segment, currentFolder.id, currentFolder.user_id);
        if (!nextFolder) return null;
        currentFolder = nextFolder;
    }
    return currentFolder;
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
    getFolderDetails,
    setFolderPassword,
    verifyFolderPassword,
    isFileAccessible,
    findFolderBySharePath,
};
