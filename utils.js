const crypto = require('crypto');

// 从 .env 档案中取得密钥，确保有预设值
const secretKey = process.env.SESSION_SECRET || 'a8e2a32e9b1c7d5f6a7b3c4d5e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
// 使用 SHA-256 确保密钥长度为 32 位元组，符合 aes-256-cbc 演算法要求
const key = crypto.createHash('sha256').update(String(secretKey)).digest('base64').substring(0, 32);
const iv = Buffer.alloc(16, 0); // 初始化向量 (IV)，为了简单起见我们使用固定的 IV

/**
 * 加密函式
 * @param {string} text 要加密的文字 (例如: 'folder/2')
 * @returns {string} Base64 编码的加密后字串
 */
function encrypt(text) {
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        // 使用 Base64 URL-safe 编码，替换特殊字元
        return Buffer.from(encrypted, 'hex').toString('base64url');
    } catch (error) {
        console.error("加密失败:", error);
        return null;
    }
}

/**
 * 解密函式
 * @param {string} encryptedText Base64 编码的加密字串
 * @returns {string|null} 解密后的原始文字，如果失败则返回 null
 */
function decrypt(encryptedText) {
    try {
        const encryptedBuffer = Buffer.from(encryptedText, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
        let decrypted = decipher.update(encryptedBuffer.toString('hex'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error("解密失败:", error);
        return null;
    }
}

module.exports = { encrypt, decrypt };
