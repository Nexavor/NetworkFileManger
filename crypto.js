const crypto = require('crypto');
const ALGORITHM = 'aes-256-cbc';
// 使用 .env 档案中的 SESSION_SECRET 作为加密密钥，确保其足够复杂和安全
const SECRET_KEY = process.env.SESSION_SECRET || 'a8e2a32e9b1c7d5f6a7b3c4d5e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
const KEY = crypto.createHash('sha256').update(String(SECRET_KEY)).digest('base64').substr(0, 32);
const IV_LENGTH = 16;

/**
 * 加密函数
 * @param {string | number} text 要加密的文字或数字
 * @returns {string} 加密后的字串
 */
function encrypt(text) {
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(KEY), iv);
        let encrypted = cipher.update(String(text));
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        // 使用 Base64 URL 安全编码，以避免 URL 中的特殊字元问题
        return iv.toString('base64url') + ':' + encrypted.toString('base64url');
    } catch (error) {
        console.error("加密失败:", error);
        return text; // 加密失败时返回原文字
    }
}

/**
 * 解密函数
 * @param {string} text 要解密的字串
 * @returns {string|null} 解密后的字串，若失败则为 null
 */
function decrypt(text) {
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'base64url');
        const encryptedText = Buffer.from(textParts.join(':'), 'base64url');
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error(`解密失败: "${text}"`, error);
        return null; // 解密失败
    }
}

module.exports = { encrypt, decrypt };
