const fs = require('fs');

const { log } = require('./log.js');

/**
 * Функция изменения переменной в файле .env
 * @param {String} key переменная окружения
 * @param {String} value значение переменной
 */
function updateEnvVariable(key, value) {
    if (!fs.existsSync('./.env')) {
        console.error('.env файл не найден.');
        return;
    }

    let envContent = fs.readFileSync('./.env', 'utf8');
    
    const key_space = key.concat(''.padEnd(20 - key.length, ' '));
    const regex = new RegExp(`${key_space}=.*`, 'm');

    if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key_space}= ${value}`);
    } else {
        envContent += `\n${key_space}= ${value}`;
    }

    fs.writeFileSync('./.env', envContent, 'utf8');
}

/**
 * Чтение переменной окружения из .env
 * @param {String} key имя переменной
 */
function getEnvVariable(key) {
    const envData = fs.readFileSync('./.env', 'utf8');
    const envLines = envData.split('\n');

    for (const line of envLines) {
        const [envKey, envValue] = line.split('=');
        if (envKey.trim() === key) return envValue?.trim();
    }
    return undefined;
}

module.exports = { updateEnvVariable, getEnvVariable };


if (require.main === module){
    // updateEnvVariable('TWITCH_USERNAME\t\t', 'username');
    // updateEnvVariable('DOMAIN', '127.0.0.1:3000');
    updateEnvVariable('TELEGRAM_CHANNEL', 'dvachannel');
}
