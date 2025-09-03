const crypto = require('crypto');

// 确保这里的 'default-secret-for-crypto' 和 'salt' 与您在 server.js 中使用的值相同
// 最好是从 .env 文件读取一个密钥
const ENCRYPTION_KEY = crypto.scryptSync(process.env.SESSION_SECRET || 'default-secret-for-crypto', 'salt', 32);
const IV_LENGTH = 16;
const ALGORITHM = 'aes-256-cbc';

/**
 * 加密一个ID
 * @param {number | string} id 要加密的ID
 * @returns {string} 加密后的字串
 */
function encryptId(id) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(String(id), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * 解密一个ID
 * @param {string} encryptedId 要解密的字串
 * @returns {number | null} 解密后的数字ID，如果失败则返回 null
 */
function decryptId(encryptedId) {
    try {
        const textParts = encryptedId.split(':');
        // 确保分割后至少有两部分 (IV 和密文)
        if (textParts.length < 2) return null;
        
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        const numId = parseInt(decrypted, 10);
        // 验证解密后的结果是否为有效数字
        return isNaN(numId) ? null : numId;
    } catch (error) {
        // console.error("解密失败:", error);
        return null;
    }
}

module.exports = { encryptId, decryptId };
