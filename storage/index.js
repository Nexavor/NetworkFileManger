// storage/index.js
const telegramStorage = require('./telegram');
const localStorage = require('./local');
const webdavStorage = require('./webdav');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

let lastUsedWebdavIndex = -1;
// *** 新增：使用 Set 来储存满载的伺服器 ID ***
const fullWebdavServers = new Set();

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
        fullWebdavServers.clear(); // 设定变更时，清除所有标记
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

// *** 新生：提供管理熔断标记的函式 ***
function markWebdavAsFull(configId) {
    console.log(`[熔断机制] 将 WebDAV ID: ${configId} 标记为已满。`);
    fullWebdavServers.add(configId);
}

function unmarkWebdavAsFull(configId) {
    if (fullWebdavServers.has(configId)) {
        console.log(`[熔断机制] WebDAV ID: ${configId} 的档案已变更，移除“已满”标记。`);
        fullWebdavServers.delete(configId);
    }
}

// *** 新生：取得所有“可用”的 WebDAV 伺服器列表 ***
function getAvailableWebdavConfigs() {
    const allConfigs = readConfig().webdav || [];
    const availableConfigs = allConfigs.filter(c => !fullWebdavServers.has(c.id));
    return availableConfigs;
}


let config = readConfig();

function getNextWebdavConfig() {
    // *** 修改：从可用的伺服器中进行轮询 ***
    const availableConfigs = getAvailableWebdavConfigs();

    if (availableConfigs.length === 0) {
        return null;
    }

    lastUsedWebdavIndex = (lastUsedWebdavIndex + 1) % availableConfigs.length;
    return availableConfigs[lastUsedWebdavIndex];
}

function setLastUsedWebdavIndex(index) {
    const availableConfigs = getAvailableWebdavConfigs();
    if (index >= 0 && index < availableConfigs.length) {
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
    setLastUsedWebdavIndex,
    markWebdavAsFull,      // *** 汇出新函式 ***
    unmarkWebdavAsFull,    // *** 汇出新函式 ***
    getAvailableWebdavConfigs // *** 汇出新函式 ***
};
