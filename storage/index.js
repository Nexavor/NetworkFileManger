// storage/index.js
const telegramStorage = require('./telegram');
const localStorage = require('./local');
const webdavStorage = require('./webdav');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            let config = JSON.parse(rawData);

            // *** 关键修改：确保 webdav 设定始终是一个阵列 ***
            // 向下相容旧版单物件设定
            if (config.webdav && !Array.isArray(config.webdav)) {
                config.webdav = [{ id: 1, ...config.webdav }];
                writeConfig(config); // 将旧格式自动升级并写入
            } else if (!config.webdav) {
                config.webdav = []; // 如果不存在，则初始化为空阵列
            }
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    // 预设值
    return { storageMode: 'telegram', webdav: [] }; 
}

function writeConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        // 重置 WebDAV 客户端以应用任何可能的变更
        webdavStorage.resetClient();
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
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
    return telegramStorage;
}

function setStorageMode(mode) {
    if (['local', 'telegram', 'webdav'].includes(mode)) {
        config.storageMode = mode;
        return writeConfig(config);
    }
    return false;
}

module.exports = {
    getStorage,
    setStorageMode,
    readConfig,
    writeConfig
};
