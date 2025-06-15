const fs = require('fs');
const { Telegraf } = require('telegraf');


// Чекает валидность токена
function checkToken(BOT_TOKEN) {
    if (!fs.existsSync('./.env')) {
        let env = fs.readFileSync('./.env.example');
        fs.writeFileSync('./.env', env);
    }
    if (!BOT_TOKEN) {
        if (!fs.existsSync('./token.txt')) {
            console.log('Для работы бота создайте файл \"token.txt\" и запишите в него API-токен телеграм-бота. Затем снова запустите скрипт');
            return false;
        }
        let token = fs.readFileSync('./token.txt', 'utf-8');
        const bot = new Telegraf(token);
        bot.telegram.getMe().then(() => {
            updateEnvVariable('BOT_TOKEN', token);
            fs.unlinkSync('./token.txt');
            console.log('Нашел файл с токеном бота. Перезапусти скрипт и запусти бота в телеграмме');

        }).catch(error => {
            console.log('Неверный токен. Запиши верный API-токен в \"token.txt\" и снова запусти этот скрипт');
        }); // Проверяем, отвечает ли API
        return false;
    }
    return true;
}

module.exports = {checkToken};