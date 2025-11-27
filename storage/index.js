// storage/index.js
const telegramStorage = require('./telegram');
const localStorage = require('./local');
const webdavStorage = require('./webdav');
const s3Storage = require('./s3'); // 新增
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            if (!config.webdav || Array.isArray(config.webdav)) config.webdav = {}; 
            if (!config.s3) config.s3 = {}; // 确保 S3 配置存在
            if (!config.uploadMode) config.uploadMode = 'stream';
            return config;
        }
    } catch (error) {}
    return { storageMode: 'local', uploadMode: 'stream', webdav: {}, s3: {} }; 
}

function writeConfig(config) {
    try {
        const currentConfig = readConfig();
        const newConfig = { ...currentConfig, ...config };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
        if (newConfig.storageMode === 'webdav') webdavStorage.resetClient();
        if (newConfig.storageMode === 's3') s3Storage.resetClient(); // 重置 S3
        return true;
    } catch (error) {
        return false;
    }
}

let config = readConfig();

function getStorage() {
    config = readConfig(); 
    if (config.storageMode === 'local') return localStorage;
    if (config.storageMode === 'webdav') return webdavStorage;
    if (config.storageMode === 's3') return s3Storage; // 支持 S3
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

function setUploadMode(mode) {
    if (['stream', 'buffer'].includes(mode)) {
        const current = readConfig();
        current.uploadMode = mode;
        return writeConfig(current);
    }
    return false;
}

module.exports = { getStorage, setStorageMode, setUploadMode, readConfig, writeConfig };
