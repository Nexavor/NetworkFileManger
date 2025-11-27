// data.js (真正最终修正版 - 修复 SQL 语法错误 和 module.exports 语法错误)

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
// 避免在每个查询中重复输入 "SELECT *"
const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type
`;
// --- (Helper 2: 定义读取 message_id 的安全方式) ---
// 这会强制 SQLite 在 node-sqlite3 驱动程式取得它之前，
// 就将 BIGINT 转换为 TEXT (字串)。
const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;


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

// --- *** 关键修正 开始 *** ---
// 重写 searchItems 函数以正确处理加密
function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const searchQuery = `%${query}%`;

        // 此 CTE (Common Table Expression) 递归地建立每个资料夾的祖先路径，
        // 并确定路径中是否有任何一个资料夾被加密。
        const baseQuery = `
            WITH RECURSIVE folder_ancestry(id, parent_id, is_locked) AS (
                -- 基底查询: 选出该使用者的所有资料夾，并标记其自身的加密状态
                SELECT id, parent_id, (password IS NOT NULL) as is_locked
                FROM folders
                WHERE user_id = ?
                UNION ALL
                -- 递归步骤: 向上查找父资料夹，并继承其加密状态
                SELECT fa.id, f.parent_id, (fa.is_locked OR (f.password IS NOT NULL))
                FROM folders f
                JOIN folder_ancestry fa ON f.id = fa.parent_id
                WHERE f.user_id = ?
            ),
            -- 聚合结果: 对每个资料夾ID，只要其路径上有任一加密，最终状态就是加密
            folder_lock_status AS (
                SELECT id, MAX(is_locked) as is_path_locked
                FROM folder_ancestry
                GROUP BY id
            )
        `;

        // 查询未被加密路径下的文件
        // --- *** 最终修正：移除多余的 "as id" *** ---
        const sqlFiles = baseQuery + `
            SELECT 
                ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS},
                ${SAFE_SELECT_ID_AS_TEXT}, 
                f.fileName as name, 
                'file' as type
            FROM files f
            JOIN folder_lock_status fls ON f.folder_id = fls.id
            WHERE f.fileName LIKE ? AND f.user_id = ? AND fls.is_path_locked = 0
            ORDER BY f.date DESC;
        `;
        
        // 查询未被加密路径下的资料夾
        const sqlFolders = baseQuery + `
            SELECT 
                f.id, 
                f.name, 
                f.parent_id, 
                'folder' as type, 
                (f.password IS NOT NULL) as is_locked
            FROM folders f
            JOIN folder_lock_status fls ON f.id = fls.id
            WHERE f.name LIKE ? AND f.user_id = ? AND fls.is_path_locked = 0 AND f.parent_id IS NOT NULL
            ORDER BY f.name ASC;
        `;

        let contents = { folders: [], files: [] };

        db.all(sqlFolders, [userId, userId, searchQuery, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) }));
            db.all(sqlFiles, [userId, userId, searchQuery, userId], (err, files) => {
                if (err) return reject(err);
                // --- *** 最终修正：移除不必要的 map *** ---
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

// 新增 isFileAccessible 函数用于在直接存取文件前进行权限验证
async function isFileAccessible(fileId, userId, unlockedFolders = []) {
    // --- *** 最终修正：此处 fileId 是 BigInt，getFilesByIds 必须能处理 *** ---
    const file = (await getFilesByIds([fileId], userId))[0];
    if (!file) {
        return false; // 找不到档案或档案不属于该使用者
    }

    const path = await getFolderPath(file.folder_id, userId);
    if (!path || path.length === 0) {
        return false; // 资料库不一致，这不应该发生
    }

    // 一次性查询路径上所有资料夾的加密状态
    const folderIds = path.map(p => p.id);
    const placeholders = folderIds.map(() => '?').join(',');
    const sql = `SELECT id, password IS NOT NULL as is_locked FROM folders WHERE id IN (${placeholders}) AND user_id = ?`;
    
    const folderStatuses = await new Promise((resolve, reject) => {
        db.all(sql, [...folderIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(new Map(rows.map(row => [row.id, row.is_locked])));
        });
    });

    // 检查路径上的每个资料夾
    for (const folder of path) {
        if (folderStatuses.get(folder.id) && !unlockedFolders.includes(folder.id)) {
            return false; // 发现一个已加密但在 session 中未解锁的资料夾
        }
    }

    return true; // 路径上所有资料夾都可存取
}
// --- *** 关键修正 结束 *** ---

function getItemsByIds(itemIds, userId) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        
        // --- *** 最终修正：移除多余的 "as id" *** ---
        const sql = `
            SELECT id, name, parent_id, 'folder' as type, null as storage_type, null as file_id, password IS NOT NULL as is_locked
            FROM folders 
            WHERE id IN (${placeholders}) AND user_id = ?
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, folder_id as parent_id, 'file' as type, storage_type, file_id, 0 as is_locked
            FROM files 
            WHERE message_id IN (${placeholders}) AND user_id = ?
        `;
        // --- *** 最终修正：将 BigInt 转换为 String *** ---
        const stringItemIds = itemIds.map(id => id.toString());
        db.all(sql, [...stringItemIds, userId, ...stringItemIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getChildrenOfFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        // --- *** 最终修正：移除多余的 "as id" *** ---
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ?
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ?
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
        const sql = `SELECT id, name, parent_id, password, password IS NOT NULL as is_locked FROM folders WHERE id = ? AND user_id = ?`;
        db.get(sql, [folderId, userId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function getFolderContents(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, password IS NOT NULL as is_locked FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name ASC`;
        // --- *** 最终修正：移除多余的 "as id" *** ---
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? ORDER BY name ASC`;
        
        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [folderId, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) }));
            db.all(sqlFiles, [folderId, userId], (err, files) => {
                if (err) return reject(err);
                // --- *** 最终修正：移除不必要的 map *** ---
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

async function getFilesRecursive(folderId, userId, currentPath = '') {
    let allFiles = [];
    // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
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

// --- *** 关键修正 开始 *** ---
async function findFolderBySharePath(shareToken, pathSegments = []) {
    return new Promise(async (resolve, reject) => {
        try {
            // 首先，验证 token 并找到根分享资料夾
            const rootFolder = await getFolderByShareToken(shareToken);
            if (!rootFolder) {
                return resolve(null);
            }

            if (pathSegments.length === 0) {
                return resolve(rootFolder);
            }

            // 从根目录开始，逐层验证路径
            let currentParentId = rootFolder.id;
            let currentFolder = rootFolder;
            const userId = rootFolder.user_id;

            for (const segment of pathSegments) {
                const sql = `SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
                const row = await new Promise((res, rej) => {
                    db.get(sql, [segment, currentParentId, userId], (err, row) => err ? rej(err) : res(row));
                });

                if (!row) {
                    return resolve(null); // 路径无效
                }
                
                // 检查子资料夾是否已加密
                if(row.password) {
                    return resolve(null); // 不允许存取加密的子资料夾
                }

                currentFolder = row;
                currentParentId = row.id;
            }
            
            // 返回最终找到的子资料夹资讯
            resolve(currentFolder);

        } catch (error) {
            reject(error);
        }
    });
}
// --- *** 关键修正 结束 *** ---

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
    // console.log(`[Data] moveItem: 开始移动项目 ID ${itemId} (类型: ${itemType}) 到目标资料夾 ID ${targetFolderId}, 深度: ${depth}`);
    const { resolutions = {}, pathPrefix = '' } = options;
    const report = { moved: 0, skipped: 0, errors: 0 };

    const sourceItem = await new Promise((resolve, reject) => {
        const table = itemType === 'folder' ? 'folders' : 'files';
        const idColumn = itemType === 'folder' ? 'id' : 'message_id';
        const nameColumn = itemType === 'folder' ? 'name' : 'fileName';
        
        // --- *** 最终修正：在 files 表中使用 CAST(message_id AS TEXT) *** ---
        const selectId = itemType === 'folder' ? 'id' : `${SAFE_SELECT_ID_AS_TEXT}`;
        
        const sql = `SELECT ${selectId}, ${nameColumn} as name, '${itemType}' as type FROM ${table} WHERE ${idColumn} = ? AND user_id = ?`;
        
        // --- *** 最终修正：将 BigInt 转换为 String *** ---
        // (注意: itemId 在 moveItem 内部调用时可能是 BigInt 或 Int，统一转 string)
        db.get(sql, [itemId.toString(), userId], (err, row) => err ? reject(err) : resolve(row));
    });

    if (!sourceItem) {
        report.errors++;
        // console.error(`[Data] moveItem: 找不到来源项目 ID ${itemId} (类型: ${itemType})`);
        return report;
    }
    
    // --- *** 最终修正：确保 sourceItem.id 是 BigInt/Int，以便后续比较 *** ---
    // (还原从数据库读出的 ID)
    // (因为我们 CAST AS TEXT，所以 sourceItem.id 总是 string)
    const sourceItemId = itemType === 'folder' ? parseInt(sourceItem.id, 10) : BigInt(sourceItem.id);


    const currentPath = path.posix.join(pathPrefix, sourceItem.name);
    const existingItemInTarget = await findItemInFolder(sourceItem.name, targetFolderId, userId);
    let resolutionAction = resolutions[currentPath] || (existingItemInTarget ? 'skip_default' : 'move');

    // --- *** 关键修正 开始：修复深度合并BUG *** ---
    // (已在上一版修复)
    // --- *** 关键修正 结束 *** ---

    // console.log(`[Data] moveItem: 项目 "${currentPath}" 的解决策略为 "${resolutionAction}"`);

    switch (resolutionAction) {
        case 'skip':
        case 'skip_default':
            report.skipped++;
            // console.log(`[Data] moveItem: 跳过项目 "${currentPath}"`);
            return report;

        // --- *** 关键修正 开始：修复文件夹移动时“重命名”执行“覆盖”的BUG *** ---
        case 'rename':
            // console.log(`[Data] moveItem: 重新命名项目 "${currentPath}"`);
            const newName = await findAvailableName(sourceItem.name, targetFolderId, userId, itemType === 'folder');
            // console.log(`[Data] moveItem: 找到可用新名称 "${newName}"`);
            if (itemType === 'folder') {
                // 使用专用的 renameAndMoveFolder 函数，确保操作的原子性和正确性
                await renameAndMoveFolder(sourceItemId, newName, targetFolderId, userId);
            } else {
                await renameAndMoveFile(sourceItemId, newName, targetFolderId, userId);
            }
            report.moved++;
            return report;
        // --- *** 关键修正 结束 *** ---

        case 'overwrite':
            if (!existingItemInTarget) {
                // console.warn(`[Data] moveItem: 尝试覆盖但目标项目 "${currentPath}" 不存在，跳过。`);
                report.skipped++;
                return report;
            }
            // console.log(`[Data] moveItem: 覆盖目标项目 "${currentPath}" (ID: ${existingItemInTarget.id}, 类型: ${existingItemInTarget.type})`);
            
            // --- *** 最终修正：确保 existingItemInTarget.id 是正确的类型 *** ---
            // (findItemInFolder 返回的 id 是 string)
            const targetId = existingItemInTarget.type === 'folder' ? parseInt(existingItemInTarget.id, 10) : BigInt(existingItemInTarget.id);
            await unifiedDelete(targetId, existingItemInTarget.type, userId);
            
            await moveItems(itemType === 'file' ? [sourceItemId] : [], itemType === 'folder' ? [sourceItemId] : [], targetFolderId, userId);
            report.moved++;
            return report;

        case 'merge':
            if (!existingItemInTarget || existingItemInTarget.type !== 'folder' || itemType !== 'folder') {
                // console.warn(`[Data] moveItem: 尝试合并但目标项目 "${currentPath}" 不是资料夾，跳过。`);
                report.skipped++;
                return report;
            }
            
            // --- *** 最终修正：确保 existingItemInTarget.id 是 Int *** ---
            const targetFolderIdInt = parseInt(existingItemInTarget.id, 10);

            // console.log(`[Data] moveItem: 合并资料夾 "${currentPath}" 到目标资料夾 ID ${targetFolderIdInt}`);
            const { folders: childFolders, files: childFiles } = await getFolderContents(sourceItemId, userId);
            let allChildrenProcessedSuccessfully = true;

            for (const childFolder of childFolders) {
                // console.log(`[Data] moveItem: 递回移动子资料夹 "${childFolder.name}" (ID: ${childFolder.id})`);
                const childReport = await moveItem(childFolder.id, 'folder', targetFolderIdInt, userId, { ...options, pathPrefix: currentPath }, depth + 1);
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                if (childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            for (const childFile of childFiles) {
                // console.log(`[Data] moveItem: 递回移动子档案 "${childFile.name}" (ID: ${childFile.id})`);
                // --- *** 最终修正：childFile.id 是 BigInt (string) *** ---
                const childReport = await moveItem(BigInt(childFile.id), 'file', targetFolderIdInt, userId, { ...options, pathPrefix: currentPath }, depth + 1);
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                 if (childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            if (allChildrenProcessedSuccessfully) {
                // console.log(`[Data] moveItem: 所有子项目成功合并，删除原始资料夾 ID ${sourceItemId}`);
                await unifiedDelete(sourceItemId, 'folder', userId);
            } else {
                 // console.warn(`[Data] moveItem: 部分子项目未能成功合并，保留原始资料夾 ID ${sourceItemId}`);
            }
            
            return report;

        default: // 'move'
            // console.log(`[Data] moveItem: 直接移动项目 "${currentPath}"`);
            await moveItems(itemType === 'file' ? [sourceItemId] : [], itemType === 'folder' ? [sourceItemId] : [], targetFolderId, userId);
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
        // --- *** 最终修正：itemId 是 BigInt *** ---
        const directFiles = await getFilesByIds([itemId], userId);
        filesForStorage.push(...directFiles);
    }
    
    try {
        await storage.remove(filesForStorage, foldersForStorage, userId);
    } catch (err) {
        throw new Error("实体档案删除失败，操作已中止。");
    }
    
    // --- *** 最终修正：itemId 是 BigInt *** ---
    const fileIds = filesForStorage.map(f => BigInt(f.message_id));
    const folderIds = foldersForStorage.map(f => f.id);
    
    await executeDeletion(fileIds, folderIds, userId);
}

async function moveItems(fileIds = [], folderIds = [], targetFolderId, userId) {
    const storage = require('./storage').getStorage();

    if (storage.type === 'local' || storage.type === 'webdav') {
        const client = storage.type === 'webdav' ? storage.getClient() : null;
        
        const targetPathParts = await getFolderPath(targetFolderId, userId);
        const targetFullPath = path.posix.join(...targetPathParts.slice(1).map(p => p.name));

        // --- *** 最终修正：fileIds 是 BigInt 数组 *** ---
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
                
                // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
                    // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
                // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
        // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
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
                // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
        // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
                // --- *** 最终修正：如果更新 message_id，也转 String *** ---
                values.push(key === 'message_id' ? updates[key].toString() : updates[key]);
            }
        }

        if (fields.length === 0) {
            return resolve({ success: true, changes: 0 });
        }
        
        // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
    // --- *** 最终修正：将 BigInt 转换为 String *** ---
    const stringMessageIds = messageIds.map(id => id.toString());
    const placeholders = stringMessageIds.map(() => '?').join(',');
    
    // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
    const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    
    return new Promise((resolve, reject) => {
        db.all(sql, [...stringMessageIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// --- *** 关键修正 开始 *** ---
// 修复了访问过期分享链接可能导致密码失效的BUG。
// 重构函数以确保在检查链接状态时，严格执行“只读”操作，绝不修改数据库。
// 这样可以防止因意外的“清理”逻辑而错误地清除了分享密码。
async function getFileByShareToken(token) {
    // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
    const getShareSql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, share_password, share_expires_at FROM files WHERE share_token = ?`;
    
    const row = await new Promise((resolve, reject) => {
        db.get(getShareSql, [token], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });

    // 如果根据token找不到任何分享，直接返回null
    if (!row) {
        return null;
    }

    // 检查分享是否已过期 (row.share_expires_at 为 null 表示永不过期)
    const isExpired = row.share_expires_at && Date.now() > row.share_expires_at;

    // 如果链接已过期，我们将其视为无效链接，返回 null。
    // 重要的是，我们不执行任何数据库写操作，从而避免了因过期检查而清除密码的风险。
    if (isExpired) {
        return null; 
    }
    
    // 如果分享有效且未过期，返回完整的分享信息。
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

    // 如果根据token找不到任何分享，直接返回null
    if (!row) {
        return null;
    }

    // 检查分享是否已过期 (row.share_expires_at 为 null 表示永不过期)
    const isExpired = row.share_expires_at && Date.now() > row.share_expires_at;

    // 如果链接已过期，我们将其视为无效链接，返回 null。
    // 重要的是，我们在这里不执行任何数据库写操作（如 UPDATE 或 DELETE）。
    // 这可以防止仅仅因为一次过期的访问就清除了分享密码等重要信息。
    if (isExpired) {
        return null; 
    }

    // 如果分享有效且未过期，返回完整的分享信息。
    return row;
}
// --- *** 关键修正 结束 *** ---

// --- *** 关键修正 开始 *** ---
async function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
        const sql = `
            WITH RECURSIVE shared_folder_tree(id) AS (
                -- Base case: the root folder with the share token. It must not be locked.
                SELECT id FROM folders WHERE share_token = ? AND password IS NULL
                UNION ALL
                -- Recursive step: find all children of the folders already in the tree.
                -- Crucially, do not include children that are themselves locked.
                SELECT f.id FROM folders f
                JOIN shared_folder_tree sft ON f.parent_id = sft.id
                WHERE f.password IS NULL
            )
            -- Final selection: get the file if its folder_id is in our allowed tree.
            SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files f
            WHERE f.message_id = ? AND f.folder_id IN (SELECT id FROM shared_folder_tree);
        `;

        // --- *** 最终修正：将 BigInt 转换为 String *** ---
        db.get(sql, [folderToken, fileId.toString()], (err, row) => {
            if (err) return reject(err);
            resolve(row); // row will be the file object or null if not found/not allowed
        });
    });
}
// --- *** 关键修正 结束 *** ---

async function renameFile(messageId, newFileName, userId) {
    // --- *** 最终修正：messageId 是 BigInt *** ---
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
            // --- *** 最终修正：将 BigInt 转换为 String *** ---
            db.run(sql, [newFileName, newRelativePath, messageId.toString(), userId], function(err) {
                 if (err) reject(err);
                 else resolve({ success: true });
            });
        });
    }

    const sql = `UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        // --- *** 最终修正：将 BigInt 转换为 String *** ---
        db.run(sql, [newFileName, messageId.toString(), userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '文件未找到。' });
            else resolve({ success: true });
        });
    });
}

async function renameAndMoveFile(messageId, newFileName, targetFolderId, userId) {
    // --- *** 最终修正：messageId 是 BigInt *** ---
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
            // --- *** 最终修正：将 BigInt 转换为 String *** ---
            db.run(sql, [newFileName, newRelativePath, targetFolderId, messageId.toString(), userId], (err) => err ? reject(err) : resolve({ success: true }));
        });
    }

    const sql = `UPDATE files SET fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
                // --- *** 最终修正：将 BigInt 转换为 String *** ---
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

// --- *** 关键修正 开始：新增 renameAndMoveFolder 函数 *** ---
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

            // 更新所有子文件的路径
            const descendantFiles = await getFilesRecursive(folderId, userId);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
                // --- *** 最终修正：将 BigInt 转换为 String *** ---
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id.toString()], (e) => e ? rej(e) : res()));
            }
        } catch(err) {
            throw new Error(`实体资料夾移动并重命名失败: ${err.message}`);
        }
    }

    // 更新数据库中的名称和父ID
    const sql = `UPDATE folders SET name = ?, parent_id = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newName, targetFolderId, folderId, userId], (err) => err ? reject(err) : resolve({ success: true }));
    });
}
// --- *** 关键修正 结束 *** ---

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


// --- *** 这是您要求修改的函数 *** ---
function createShareLink(itemId, itemType, expiresIn, userId, password = null, customExpiresAt = null) {
    // 方案：使用 4 字节随机数，生成 8 位 hex 字符串。
    // 这提供了 16^8 (约 43 亿) 种组合，使用 [0-9, a-f]，不区分大小写。
    // 兼顾了安全、短链接 和 可用性。
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
        // --- *** 最终修正：将 BigInt 转换为 String (如果 itemType 是 file) *** ---
        const stringItemId = itemType === 'folder' ? itemId : itemId.toString();
        db.run(sql, [token, expiresAt, hashedPassword, stringItemId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '项目未找到。' });
            else resolve({ success: true, token });
        });
    });
}
// --- *** 修改结束 *** ---

function deleteFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) {
        return Promise.resolve({ success: true, changes: 0 });
    }
    // --- *** 最终修正：将 BigInt 转换为 String *** ---
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
        // --- *** 最终修正：移除多余的 "as id" *** ---
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
        // --- *** 最终修正：将 BigInt 转换为 String (如果 itemType 是 file) *** ---
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
        // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
        const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID} FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?`;
        db.get(sql, [fileName, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function findItemInFolder(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        // --- *** 最终修正：移除多余的 "as id" *** ---
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?
            UNION ALL
            SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
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
        // --- *** 最终修正：使用 CAST(message_id AS TEXT) *** ---
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
            const result = await createFolder(part, parentId, userId);
            parentId = result.id;
        }
    }
    return parentId;
}

// --- *** 关键修正 开始 *** ---
// 重构 resolvePathToFolderId 函数以包含锁和原子化数据库操作
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
                    const selectSql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
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
// --- *** 关键修正 结束 *** ---


// --- 新增：管理 Auth Tokens 的函数 ---

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
        // 直接关联 users 表以获取使用者信息
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

// (可选，但推荐) 新增一个函数来清除所有过期的令牌
function deleteExpiredAuthTokens() {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const sql = `DELETE FROM auth_tokens WHERE expires_at <= ?`;
        db.run(sql, [now], function(err) {
            if (err) {
                // console.error("清除过期 token 时出错:", err);
                return reject(err);
            }
            resolve({ changes: this.changes });
        });
    });
}
// --- 新增结束 ---


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
    // --- *** 最终修正：移除 "D" *** ---
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
    // --- *** 关键修正：导出新函数 *** ---
    renameAndMoveFolder,
    getFolderDetails,
    setFolderPassword,
    verifyFolderPassword,
    isFileAccessible,
    findFolderBySharePath,
    // --- 新增 exports ---
    createAuthToken,
    findAuthToken,
    deleteAuthToken,
    deleteExpiredAuthTokens,
};
