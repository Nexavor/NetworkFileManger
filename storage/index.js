const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify({ storageMode: 'local', webdav: [] }), 'utf8');
        return { storageMode: 'local', webdav: [] };
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function writeConfig(config) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        // 当设定变更时，重置 WebDAV 客户端以确保使用新设定
        const webdavStorage = require('./webdav');
        webdavStorage.resetClient();
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

function getStorage() {
    const config = readConfig();
    switch (config.storageMode) {
        case 'webdav':
            return require('./webdav');
        case 'local':
        default:
            return require('./local');
    }
}

function setStorageMode(mode) {
    if (['local', 'webdav'].includes(mode)) {
        let config = readConfig();
        config.storageMode = mode;
        return writeConfig(config);
    }
    return false;
}

// **新生：上传策略**
// 为新的上传任务决定一个储存目标。
// 目前的策略很简单：总是使用列表中的第一个 WebDAV 设定。
function getTargetStorageForUpload() {
    const config = readConfig();
    if (config.storageMode === 'webdav' && config.webdav && config.webdav.length > 0) {
        return {
            storage_id: config.webdav[0].id,
            storage_type: 'webdav'
        };
    }
    // 预设回退到本地储存
    return {
        storage_id: 'local',
        storage_type: 'local'
    };
}


module.exports = {
    readConfig,
    writeConfig,
    getStorage,
    setStorageMode,
    getTargetStorageForUpload // 导出新函数
};
