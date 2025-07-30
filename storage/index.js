// storage/index.js
const telegramStorage = require('./telegram');
const localStorage = require('./local');
const webdavStorage = require('./webdav');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

let lastUsedWebdavIndex = -1;

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            let config = JSON.parse(rawData);

            if (config.webdav && !Array.isArray(config.webdav)) {
                config.webdav = [{ id: 1, ...config.webdav }];
                writeConfig(config);
            } else if (!config.webdav) {
                config.webdav = [];
            }
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    return { storageMode: 'telegram', webdav: [] }; 
}

function writeConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        webdavStorage.resetClient();
        lastUsedWebdavIndex = -1; 
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

let config = readConfig();

function getNextWebdavConfig() {
    const currentConfig = readConfig();
    const webdavConfigs = currentConfig.webdav || [];

    if (webdavConfigs.length === 0) {
        return null;
    }

    lastUsedWebdavIndex = (lastUsedWebdavIndex + 1) % webdavConfigs.length;
    return webdavConfigs[lastUsedWebdavIndex];
}

// *** 新生：允许外部模组设定最后使用的索引 ***
function setLastUsedWebdavIndex(index) {
    const configs = readConfig().webdav || [];
    if (index >= 0 && index < configs.length) {
        lastUsedWebdavIndex = index;
    }
}

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
    writeConfig,
    getNextWebdavConfig,
    setLastUsedWebdavIndex // *** 新增汇出 ***
};
