// storage/index.js
const telegramStorage = require('./telegram');
const localStorage = require('./local');
const webdavStorage = require('./webdav');
const s3Storage = require('./s3'); // 新增：引入 S3 模块
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            // 确保 webdav 设定存在且为物件
            if (!config.webdav || Array.isArray(config.webdav)) {
                config.webdav = {}; 
            }
            // 确保 s3 设定存在
            if (!config.s3) {
                config.s3 = {};
            }
            // 确保 uploadMode 存在
            if (!config.uploadMode) {
                config.uploadMode = 'stream';
            }
            return config;
        }
    } catch (error) {
        // console.error("读取设定档失败:", error);
    }
    // 预设值
    return { storageMode: 'local', uploadMode: 'stream', webdav: {}, s3: {} }; 
}

function writeConfig(config) {
    try {
        // 读取现有配置以保留未修改的字段
        const currentConfig = readConfig();
        const newConfig = { ...currentConfig, ...config };
        
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
        
        // 如果是 WebDAV 设定变更，则重置客户端
        if (newConfig.storageMode === 'webdav') {
            webdavStorage.resetClient();
        }
        // 如果是 S3 设定变更，则重置客户端
        if (newConfig.storageMode === 's3') {
            s3Storage.resetClient();
        }
        return true;
    } catch (error) {
        // console.error("写入设定档失败:", error);
        return false;
    }
}

let config = readConfig();

function getStorage() {
    config = readConfig(); 
    if (config.storageMode === 'local') {
        return localStorage;
    }
    if (config.storageMode === 'webdav') {
        return webdavStorage;
    }
    if (config.storageMode === 's3') { // 新增：S3 支持
        return s3Storage;
    }
    return telegramStorage;
}

function setStorageMode(mode) {
    if (['local', 'telegram', 'webdav', 's3'].includes(mode)) {
        const current = readConfig();
        current.storageMode = mode;
        return writeConfig(current);
    }
    return false;
}

// 设定上传模式
function setUploadMode(mode) {
    if (['stream', 'buffer'].includes(mode)) {
        const current = readConfig();
        current.uploadMode = mode;
        return writeConfig(current);
    }
    return false;
}

module.exports = {
    getStorage,
    setStorageMode,
    setUploadMode,
    readConfig,
    writeConfig
};
