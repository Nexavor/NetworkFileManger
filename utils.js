require('dotenv').config();
const crypto = require('crypto');

const secretKey = process.env.SESSION_SECRET || 'a8e2a32e9b1c7d5f6a7b3c4d5e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
const key = crypto.createHash('sha256').update(String(secretKey)).digest('base64').substring(0, 32);
const iv = Buffer.alloc(16, 0);

/**
 * 将 Base64 字符串转换为 URL 安全的格式
 * @param {string} base64str 标准的 Base64 字符串
 * @returns {string} URL 安全的 Base64 字符串
 */
function makeBase64UrlSafe(base64str) {
    return base64str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * 将 URL 安全的 Base64 字符串还原为标准格式
 * @param {string} safeBase64str URL 安全的 Base64 字符串
 * @returns {string} 标准的 Base64 字符串
 */
function unmakeBase64UrlSafe(safeBase64str) {
    let base64 = safeBase64str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return base64;
}

/**
 * 加密函式 (增强相容性)
 * @param {string} text 要加密的文字 (例如: 'folder/2')
 * @returns {string} URL 安全的 Base64 编码的加密后字串
 */
function encrypt(text) {
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const base64str = Buffer.from(encrypted, 'hex').toString('base64');
        return makeBase64UrlSafe(base64str);
    } catch (error) {
        console.error("加密失败:", error);
        return null;
    }
}

/**
 * 解密函式 (增强相容性)
 * @param {string} safeBase64str URL 安全的 Base64 编码的加密字串
 * @returns {string|null} 解密后的原始文字，如果失败则返回 null
 */
function decrypt(safeBase64str) {
    try {
        const base64str = unmakeBase64UrlSafe(safeBase64str);
        const encryptedBuffer = Buffer.from(base64str, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
        let decrypted = decipher.update(encryptedBuffer);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString('utf8');
    } catch (error) {
        // 解密失败是正常情况（例如输入了无效的字串），可以不用印出错误
        // console.error("解密失败:", error);
        return null;
    }
}

module.exports = { encrypt, decrypt };
