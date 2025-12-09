const { Telegraf } = require('telegraf');
const fs = require('fs');
const axios = require('axios');

const { log, getDate, writeToFile } = require('./scripts/log.js');
const { parseTelegramPost, getMedia } = require('./scripts/rss.js');
const { streamStatus, getAccessToken, getUserId, getLatestClip } = require('./scripts/twitch.js');
const { updateEnvVariable } = require('./scripts/env.js');
const { checkToken } = require('./scripts/token.js');
const path = require('path');

require('dotenv').config();
const {
    BOT_TOKEN                       // Токен телеграм бота
} = process.env;

let {
    OWNER_ID,                       // ID владельца бота
    CHAT_ID,                        // ID чата
    TYPE_CHAT,                      // Тип чата
    TOPIC_ALERTS_ID,               // ID потока чата-оповещения (опционально)
    TOPIC_NEWS_ID,                 // ID потока чата-новости (опционально)
    TOPIC_CLIPS_ID,
    TELEGRAM_CHANNEL,               // Телеграм канал
    DOMAIN,                         // URL-адрес RSS
    TWITCH_USERNAME,                // Имя стримера
    CLIENT_ID,                      // ID клиента
    CLIENT_SECRET                   // Секретный ключ клиента
} = process.env;

const LAST_POST_FILE = 'last_post.txt'; // Файл для хранения последнего поста
const LAST_CLIP_FILE = 'last_clip.txt'; // Файл для хранения последнего клипа
const ALERTS_MESSAGE_FILE = 'alerts_mes.txt' // Файл для хранения текста оповещения о начале стрима

let lastPost = undefined;
let lastClip = undefined;
let wasLive = false;
let accessToken = '';
let userId = null;
let mesAlerts = '';
let processNews = undefined;
let processAlerts = undefined;
let processClips = undefined;

// Переменные для временного хранения переменных при настройке бота
let action = 'cancel';
let chatid = null;
let client_id = '';
let phrase = '';
let threadId = '';
let adminlist = [];

if (require.main === module) {
    if (!checkToken(BOT_TOKEN)) {
        setTimeout(() => { }, 10000);
        return;
    }
}

const bot = new Telegraf(BOT_TOKEN);

process.on('uncaughtException', (err) => {
    log('❌Необработанное исключение: ', err);
    if (bot)
        bot.telegram.sendMessage(OWNER_ID, `Необработанное исключение: ${err.message}`);
});

// Читаем ID последнего поста из файла
function loadLastData(filename) {
    try {
        if (fs.existsSync(`./data/others/${filename}`)) {
            return fs.readFileSync(`./data/others/${filename}`, 'utf8').trim();
        }
    } catch (error) {
        log(`❌ Ошибка чтения файла ${filename}: `, error.message);
    }
    return null;
}

// Сохраняем ID последнего поста в файл
function saveLastData(filename, data) {
    try {
        if (fs.existsSync(`./data/others/${filename}`))
            fs.unlinkSync(`./data/others/${filename}`);
        writeToFile('/data/others/', filename, data);
    } catch (error) {
        log(`❌ Ошибка записи в файл ${filename}: `, error.message);
    }
}

async function checkNewPost() {
    try {
        const object = await parseTelegramPost(TELEGRAM_CHANNEL, DOMAIN);
        const numLink = object?.link.split('/')[object.link.split('/').length - 1];

        if (isNaN(numLink) || lastPost >= numLink) return;

        const media = await getMedia(object.media);

        if (!await forwardLastPost(object.text, media, object.link)) return;
        lastPost = numLink;
        saveLastData(LAST_POST_FILE, lastPost);
    }
    catch (error) {
        log("❌ Ошибка при проверке постов:", error.message);
    }
}

async function checkStream() {
    try {
        const isLive = await streamStatus(userId, CLIENT_ID, accessToken) ?? wasLive;
        if (isLive && !wasLive) {
            await sendAlertsMessage(mesAlerts);
            wasLive = true;
            log('Оповещение о стриме отправлен в чат', CHAT_ID, 'поток', TOPIC_ALERTS_ID);
        }
        else if (!isLive && wasLive) {
            wasLive = false;
        }
    }
    catch (err) {
        log('❌ Ошибка при проверке стрима:', err.message);
    }
}

async function checkNewClip() {
    try {
        const object = await getLatestClip(userId, CLIENT_ID, accessToken);
        const create_date = object?.create_date;

        if (Number(lastClip) >= create_date || !object) return;

        bot.telegram.sendMessage(CHAT_ID,
            `Клип: <a href="${object.url}">${object.title}</a>\nАвтор: ${object.creator}`,
            {
                parse_mode: 'HTML',
                message_thread_id: TOPIC_CLIPS_ID,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Смотреть клип', url: object.url }]
                    ]
                }
            }
        )
        lastClip = create_date.toString();
        saveLastData(LAST_CLIP_FILE, lastClip);
        log(`Клип "${object.title}" отправлен в чат ${CHAT_ID} поток ${TOPIC_CLIPS_ID}`);
    }
    catch (err) {
        log('❌ Ошибка при проверке последнего клипа:', err.message);
    }
}

async function sendAlertsMessage(text = undefined) {
    const message = text ?? `Привет! ${TWITCH_USERNAME} начал(a) трансляцию.\n`;
    try {
        await bot.telegram.sendMessage(CHAT_ID, message,
            {
                parse_mode: 'HTML',
                message_thread_id: TOPIC_ALERTS_ID,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Зайти на стрим', url: `https://www.twitch.tv/${TWITCH_USERNAME}` }]
                    ]
                }
            }
        )
    }
    catch (err) {
        log('❌ Ошибка при отправке уведомления:', err.message);
        return undefined;
    }
}

async function forwardLastPost(text, urls, link) {
    try {
        if (urls.length > 0) {
            // Создаем captions: текст только для первого элемента
            const captions = [text, ...Array(urls.length - 1).fill('')];

            await bot.telegram.sendMediaGroup(
                CHAT_ID,
                urls.map((url, index) => ({
                    type: url[0],
                    media: url[1],
                    caption: captions[index],
                    parse_mode: 'HTML'
                })),
                {
                    message_thread_id: TOPIC_NEWS_ID
                }
            );
        } else {
            // Если нет фото/видео, отправляем только текст
            await bot.telegram.sendMessage(CHAT_ID, text,
                {
                    parse_mode: 'HTML',
                    message_thread_id: TOPIC_NEWS_ID
                }
            );
        }
        log(`Пост ${link} переслан в чат`, CHAT_ID, ' поток:', TOPIC_NEWS_ID);
        return true;

    } catch (error) {
        log("❌ Ошибка при отправке поста:", error.message);
        return false;
    }
}

async function info(ctx) {
    const news = checkNews();
    const twitch = checkTwitch();
    const keyboard = [
        !news.ok ? news.button : [],
        !twitch.ok ? twitch.button : [],
    ];
    return await ctx.reply(CHAT_ID, `Пересылка постов: ${news.ok && processNews ? '🟢включен' : '🔴отключен'}\n` +
        `${news.ok ? '' : news.reason.concat('\n\n')}` +
        `Оповещения о стримах: ${twitch.ok && processAlerts ? '🟢включен' : '🔴отключен'}\n` +
        `Публикация клипов: ${twitch.ok && processClips ? '🟢включен' : '🔴отключен'}\n` +
        `${twitch.ok ? '' : twitch.reason}`,
        {
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    );
}

async function getAdminList(chat = CHAT_ID) {
    try {
        let list = await bot.telegram.getChatAdministrators(chat);
        let result = [];
        for (let admin of list) {
            result.push(admin.user.id);
        }
        return result;
    }
    catch (err) {
        log('Ошибка при сборе информации об администраторах:', err.message);
        return [];
    }
}

async function getBotPermissions(chat = CHAT_ID) {
    try {
        let list = await bot.telegram.getChatAdministrators(chat);
        let botInfo = await bot.telegram.getMe();
        for (let admin of list) {
            if (admin.user.id === botInfo.id) {
                return admin;
            }
        }
        return undefined;
    }
    catch (err) {
        log('Ошибка при получении прав бота:', err.message);
        return undefined;
    }
}

function isAdmin(ctx) {
    return adminlist.includes(ctx.update.message?.from.id || ctx.update.callback_query?.from.id);
}

async function testalerts(ctx) {
    await sendAlertsMessage(mesAlerts ?? 'Прилетело оповещение сюда');
    log('Тестовое оповещение было отправлено в чат', CHAT_ID, 'поток', TOPIC_ALERTS_ID);
    return await ctx.reply('Тестовое оповещение отправлено');
}

async function testnews(ctx) {
    await forwardLastPost('Тестовый пост прилетел сюда', [], 'https://testpost');
    log('Тестовый пост отправлен в чат', CHAT_ID, 'поток', TOPIC_NEWS_ID);
    return await ctx.reply('Тестовый пост отправлен');
}

async function getLog(ctx) {
    const date = getDate();
    const fileLog = `log-${date.year}-${date.month}-${date.day}.txt`;
    try {
        if (!fs.existsSync(`./logs/${fileLog}`)) {
            throw Error('файл не найден');
        }
        log('Выгружен файл', fileLog);
        return await ctx.replyWithDocument({ source: `logs/${fileLog}` });
    }
    catch (error) {
        log(`❌Ошибка отправки файла ${fileLog}: ${error}`);
        return await ctx.reply(OWNER_ID, `Ошибка отправки файла ${fileLog}: ${error}`);
    }
}

async function settings(ctx) {
    return await ctx.reply('Настройки бота',
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Чат', callback_data: 'chatsettings' }],
                    [{ text: 'Пересылка постов', callback_data: 'forward' }, { text: 'Twitch', callback_data: 'twitch' }],
                    // [{ text: 'Обновить бота', callback_data: 'botupdate' }]
                ]
            }
        }
    );
}

async function stop(ctx) {
    const username = ctx.update.message.from.first_name;
    ctx.reply('Бот остановил работу');
    log('Бот остановлен администратором', username);
    bot.stop('Бот остановлен администратором');
}

async function cancel(ctx) {
    action = 'cancel';
    threadId = undefined;
    phrase = '';
    client_id = '';
    chatid = '';
    return await ctx.reply('Действие отменено');
}

// ==================== Телеграм бот =====================

bot.catch((err) => {
    log('Необработанное исключение бота:', err.message);
    bot.telegram.sendMessage(OWNER_ID, `Необработанное исключение бота: ${err.message}`);
});

bot.start(async ctx => {
    const chatfrom = ctx.chat.id;
    if (chatfrom < 0) {
        adminlist = await getAdminList(chatfrom);
        if (isAdmin(ctx.message.from.id)) {
            updateEnvVariable('CHAT_ID', chatfrom);
            updateEnvVariable('TYPE_CHAT', 'group');
            TYPE_CHAT = 'group';
            CHAT_ID = chatfrom;
        }
        let response = await ctx.reply('Привет! Я бот, который помогает стримерам в их деятельности в пределах Telegram\n' +
            'Теперь расскажу кратко, что я умею\n' +
            '<i>- копировать посты с других публичных телеграм каналов и пересылать в чат (даже в определённый поток (тему))</i>\n' +
            '<i>- отправлять оповещения о начале стрима в чат (также в определённый поток)</i>\n\n' +
            'Собственно, это всё, что я умею. Теперь пропиши /help, чтобы вывести команды, которые во мне заложены',
            {
                parse_mode: 'HTML'
            }
        );
        let perm = await getBotPermissions(chatfrom);
        if (perm?.can_delete_messages && perm?.can_manage_topics) {
            bot.telegram.deleteMessage(chatfrom, ctx.message.message_id).catch(() => { });
            setTimeout((() => {
                bot.telegram.deleteMessage(chatfrom, response.message_id).catch(() => { });
            }), 60000);
        }
        else {
            await ctx.reply('Для дальнейшей настройки необходимы следующие права администратора боту:\n' +
                '<i>- Удаление сообщений</i>\n' +
                '<i>- Управление темами</i>',
                {
                    parse_mode: 'HTML'
                }
            )
        }
    }
    else {
        OWNER_ID = chatfrom;
        const username = ctx.update.message.from.first_name || 'друг';
        ctx.reply(`Привет! Рад с тобой познакомится, ${username}!\n` +
            'Если хочешь добавить меня в телеграм канал, нажми на кнопку ниже, иначе добавь в группу и пропиши \/start в нем для дальнейшей настройки\n',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Добавить бота в телеграм канал', callback_data: 'chatsettings:chatchannel:channel' }]
                    ]
                },
                parse_mode: 'HTML'
            }
        );
    }
});

bot.help(async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
        await ctx.reply('/info - вывод информации по боту\n' +
            '/log - вывод лога за текущий день (начиная с 00-00)\n' +
            '/stop - остановка работы бота\n' +
            '/testalerts - отправляет тестовое сообщение оповещения в чат\n' +
            '/testnews - отправляет тестовое сообщение поста в чат\n' +
            '/settings - настройки бота\n\n' +
            'Собственно, это всё, что есть из набора. Если есть пожелания или ты обнаружил ошибку, напиши разработчику @enginrr'
        );
});

bot.command(/(.+)/, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const command = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (command) {
        case 'info':
            response = await info(ctx);
            break;

        case 'testalerts':
            response = await testalerts(ctx);
            break;

        case 'testnews':
            response = await testnews(ctx);
            break;

        case 'log':
            response = await getLog(ctx);
            break;

        case 'stop':
            stop(ctx);
            break;

        case 'settings':
            if (chatfrom < 0) {
                let perm = await getBotPermissions(chatfrom);
                if (!(perm?.can_delete_messages && perm?.can_manage_topics)) {
                    await ctx.reply('Для дальнейшей настройки необходимо выдать следующие права администратора боту:\n' +
                        '<i>- Удаление сообщений</i>\n' +
                        '<i>- Управление темами</i>',
                        {
                            parse_mode: 'HTML'
                        }
                    );
                    break;
                }
            }
            response = await settings(ctx);
            break;

        case 'cancel':
            response = await cancel(ctx);
            break;

        default:
            break;
    }
    if (chatfrom < 0) {
        let perm = await getBotPermissions(chatfrom);
        if (perm?.can_delete_messages && perm?.can_manage_topics) {
            bot.telegram.deleteMessage(chatfrom, ctx.message.message_id).catch(() => { });
            setTimeout((() => {
                bot.telegram.deleteMessage(chatfrom, response.message_id).catch(() => { });
            }), 60000);
        }
    }
});

bot.action('settings', ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    ctx.editMessageText('Настройки бота',
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Чат', callback_data: 'chatsettings' }],
                    [{ text: 'Пересылка постов', callback_data: 'forward' }, { text: 'Twitch', callback_data: 'twitch' }],
                    // [{ text: 'Обновить бота', callback_data: 'botupdate' }]
                ]
            }
        }
    )
});

// ==================== Настройки пересылки постов =====================

bot.action('forward', ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    ctx.editMessageText('Текущие настройки пересылки постов\n\n' +
        `Отслеживаемый канал: @${TELEGRAM_CHANNEL}\n` +
        `Адрес RSS-bridge: ${DOMAIN}`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Сменить отслеживаемый канал', callback_data: 'forward:telegramchannel' }, { text: 'Сменить URL-адрес RSS-bridge', callback_data: 'forward:rssbridge' }],
                    [{ text: '◀️Назад', callback_data: 'settings' }]
                ]
            }
        }
    );
});

bot.action(/^forward:(.+)/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const settingType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (settingType) {
        case 'telegramchannel':
            action = 'telegramchanneledit';
            response = await ctx.reply('Окей, отправь мне ссылку на канал. Канал должен быть публичным\nДля отмены действия используй /cancel');
            break;
        case 'rssbridge':
            action = 'rssbridgeedit';
            response = await ctx.reply('Окей, напиши адрес в формате адрес:порт, на котором развернут <a href=\"https://github.com/RSS-Bridge/rss-bridge/\">RSS-bridge</a>. Например, 127.0.0.1:3000\n' +
                'Для отмены действия используй /cancel',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Использовать официальный сайт', callback_data: 'forward:officialrssbridge' }]
                        ]
                    }
                }
            );
            break;
        case 'officialrssbridge':
            action = 'cancel';
            DOMAIN = 'rss-bridge.org/bridge01';
            updateEnvVariable('DOMAIN', DOMAIN);
            response = await ctx.reply('✅Адрес изменен на официальный');
            log('Адрес сервера изменен на официальный');
            break;
        default:
            ctx.reply(`Выбран ${settingType}`);
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

// ==================== Настройки пересылки постов. Конец =====================
// ==================== Настройки чата =====================

bot.action('chatsettings', async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    let chat = await bot.telegram.getChat(CHAT_ID).catch();
    ctx.editMessageText('Текущие настройки чата\n\n' +
        `Чат группы/канал: ${chat?.title ?? 'Не задан или бот не состоит в группе/канале'}\n` +
        `Поток для оповещений о стриме: ${(isNaN(TOPIC_ALERTS_ID) ? undefined : TOPIC_ALERTS_ID) ?? 'Не задан'}\n` +
        `Поток для пересылки постов с канала @${TELEGRAM_CHANNEL}: ${(isNaN(TOPIC_NEWS_ID) ? undefined : TOPIC_NEWS_ID) ?? 'Не задан'}\n` +
        `Поток для опубликования клипов: ${(isNaN(TOPIC_CLIPS_ID) ? undefined : TOPIC_CLIPS_ID) ?? 'Не задан'}`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Сменить поток для алертов', callback_data: 'chatsettings:threadalerts' }, { text: 'Сменить чат/канал', callback_data: 'chatsettings:chatchannel' }],
                    [{ text: 'Сменить поток постов', callback_data: 'chatsettings:threadnews' }, { text: 'Сменить поток клипов', callback_data: 'chatsettings:threadclips' }],
                    [{ text: '◀️Назад', callback_data: 'settings' }]
                ]
            },
            parse_mode: 'HTML'
        }
    );
});

bot.action(/^chatsettings:chatchannel:(.+)/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const chatType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (chatType) {
        case 'chat':
            // action = 'chatedit';
            response = await ctx.reply('Окей, теперь добавь меня в новую группу и пропиши команду /start в чате. Если необходимо сбросить настройки, нажми на кнопку ниже. Для отмены введи /cancel\n' +
                '<b>🚨ВНИМАНИЕ!🚨</b>\n' +
                'После нажатия на кнопку все настройки сбросяться до заводских значений. Их восстановление будет невозможно.',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Сбросить настройки', callback_data: 'chatsettings:chatchannel:chatedit' }]
                        ]
                    }
                }
            );
            break;

        case 'chatedit':
            // action = 'cancel';
            // updateEnvVariable('CHAT_ID', chatid);
            // TYPE_CHAT = 'group';
            // updateEnvVariable('TYPE_CHAT', TYPE_CHAT);

            updateEnvVariable('TOPIC_ALERTS_ID', undefined);
            updateEnvVariable('TOPIC_CLIPS_ID', undefined);
            updateEnvVariable('TOPIC_NEWS_ID', undefined);
            TOPIC_ALERTS_ID = TOPIC_CLIPS_ID = TOPIC_NEWS_ID = undefined;
            !fs.existsSync(`./data/others/${LAST_POST_FILE}`) || fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
            !fs.existsSync(`./data/others/${LAST_CLIP_FILE}`) || fs.unlinkSync(`./data/others/${LAST_CLIP_FILE}`);
            lastClip = lastPost = '';
            wasLive = false;
            clearInterval(processAlerts);
            clearInterval(processClips);
            clearInterval(processNews);
            processAlerts = processNews = processClips = undefined;

            log('Потоки сброшены на значение undefined');
            log('Таймеры были сброшены');
            log('Удалены данные о последнид постах и клипах');
            response = await ctx.editMessageText('✅Настройки были сброшены');
            break;

        case 'channel':
            action = 'channeledit';
            response = await ctx.reply('Окей, добавь меня в канал в качестве администратора, затем перешли мне любой пост\n' +
                '<b>🚨ВНИМАНИЕ!🚨</b>\n' +
                'После смены чата все потоки будут сброшены до заводских значений. Их восстановление будет невозможно.',
                {
                    parse_mode: 'HTML'
                }
            );
            break;

        case 'channeledit':
            action = 'cancel';
            updateEnvVariable('OWNER_ID', ctx.chat.id);
            updateEnvVariable('TYPE_CHAT', 'channel');
            updateEnvVariable('CHAT_ID', chatid);

            updateEnvVariable('TOPIC_ALERTS_ID', undefined);
            updateEnvVariable('TOPIC_CLIPS_ID', undefined);
            updateEnvVariable('TOPIC_NEWS_ID', undefined);
            TOPIC_ALERTS_ID = TOPIC_CLIPS_ID = TOPIC_NEWS_ID = undefined;
            !fs.existsSync(`./data/others/${LAST_POST_FILE}`) || fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
            !fs.existsSync(`./data/others/${LAST_CLIP_FILE}`) || fs.unlinkSync(`./data/others/${LAST_CLIP_FILE}`);
            lastClip = lastPost = '';
            wasLive = false;
            clearInterval(processAlerts);
            clearInterval(processClips);
            clearInterval(processNews);

            response = await ctx.reply('✅Смена канала прошла успешно',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            if (TYPE_CHAT === 'group') {
                log('ID чата был сменен на ID канала с', CHAT_ID, 'на', chatid);
            }
            else if (TYPE_CHAT === 'channel') {
                log('ID канала был сменен с', CHAT_ID, 'на', chatid);
            }
            CHAT_ID = chatid;
            TYPE_CHAT = 'channel';
            break;

        default:
            ctx.reply(`Выбран ${chatType}`);
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

function generatePhrase() {
    let length = 16,
        charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        retVal = "";
    for (let i = 0, n = charset.length; i < length; ++i) {
        retVal += charset.charAt(Math.floor(Math.random() * n));
    }
    return retVal;
}

function checkTwitch() {
    if (!CLIENT_ID && !CLIENT_SECRET && !TWITCH_USERNAME) {
        return {
            ok: false,
            reason: '⚠️Настройки twitch не заданы. ',
            button: [{ text: 'Настроить Twitch', callback_data: 'twitch' }]
        }
    }
    else if (!CLIENT_ID && !CLIENT_SECRET && !accessToken) {
        return {
            ok: false,
            reason: '⚠️Токены не заданы или срок их истек.',
            button: [{ text: 'Задать токены', callback_data: 'twitch:tokens' }]
        }
    }
    else if (!TWITCH_USERNAME) {
        return {
            ok: false,
            reason: '⚠️Имя канала не задана.',
            button: [{ text: 'Задать канал', callback_data: 'twitch:channel' }]
        }
    }
    return {
        ok: true
    }
}

function checkNews() {
    if (!DOMAIN && !TELEGRAM_CHANNEL) {
        return {
            ok: false,
            reason: '⚠️Пересылка постов не настроена.',
            button: [{ text: 'Настроить пересылку постов', callback_data: 'forward' }]
        }
    }
    else if (!DOMAIN) {
        return {
            ok: false,
            reason: '⚠️Адрес сервера не задан.',
            button: [{ text: 'Задать адрес сервера', callback_data: 'forward:rssbridge' }]
        }
    }
    else if (!TELEGRAM_CHANNEL) {
        return {
            ok: false,
            reason: '⚠️Отслеживаемый канал не задан.',
            button: [{ text: 'Задать канал', callback_data: 'forward:telegramchannel' }]
        }
    }
    return {
        ok: true
    }
}

bot.action(/^chatsettings:threadnews:(.+)$/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const settingType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (settingType) {
        case 'edit':
            action = 'cancel';
            updateEnvVariable('TOPIC_NEWS_ID', threadId);
            TOPIC_NEWS_ID = threadId;
            processNews ??= setInterval(checkNewPost, 60 * 1000);
            response = await ctx.reply('✅Поток для пересылки постов изменен. Для тестрования используй /testnews',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Поток для пересылки постов изменен на', TOPIC_NEWS_ID);
            break;

        case 'on':
            updateEnvVariable('TOPIC_NEWS_ID', 0);
            TOPIC_NEWS_ID = 0;
            processNews ??= setInterval(checkNewPost, 60 * 1000);
            response = await ctx.reply('🟢Пересылка постов включена',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Пересылка постов включена');
            break;

        case 'off':
            action = 'cancel';
            updateEnvVariable('TOPIC_NEWS_ID', undefined);
            TOPIC_NEWS_ID = undefined;
            clearInterval(processNews);
            processNews = undefined;
            !fs.existsSync(`./data/others/${LAST_POST_FILE}`) || fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
            lastPost = '';
            response = await ctx.reply('🔴Отключил пересылку постов',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Пересылка постов отключена');
            break;

        default:
            ctx.reply(`Выбран ${settingType}`);
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

bot.action(/^chatsettings:threadalerts:(.+)$/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const settingType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (settingType) {
        case 'edit':
            action = 'cancel';
            updateEnvVariable('TOPIC_ALERTS_ID', threadId);
            TOPIC_ALERTS_ID = threadId;
            processAlerts ??= setInterval(checkStream, 60 * 1000);
            response = await ctx.reply('✅Поток для получения оповещений о стриме изменен\nДля тестирования используй /testalerts',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Поток для отправки оповещений о стриме изменен на', TOPIC_ALERTS_ID);
            break;

        case 'on':
            updateEnvVariable('TOPIC_ALERTS_ID', 0);
            TOPIC_ALERTS_ID = 0;
            processAlerts ??= setInterval(checkStream, 60 * 1000);
            response = await ctx.reply('🟢Оповещения о стриме включена',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Оповещения о стриме включена');
            break;

        case 'off':
            action = 'cancel';
            updateEnvVariable('TOPIC_ALERTS_ID', undefined);
            TOPIC_ALERTS_ID = undefined;
            clearInterval(processAlerts);
            processAlerts = undefined;
            wasLive = false;
            response = await ctx.reply('🔴Отключил получение оповещений о запуске стрима',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Оповещения о стриме отключены');
            break;

        default:
            ctx.reply(`Выбран ${settingType}`);
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

bot.action(/^chatsettings:threadclips:(.+)$/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const settingType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (settingType) {
        case 'edit':
            action = 'cancel';
            updateEnvVariable('TOPIC_CLIPS_ID', threadId);
            TOPIC_CLIPS_ID = threadId;
            processNews ??= setInterval(checkNewClip, 2 * 60 * 1000);
            response = await ctx.reply('✅Поток для опубликования клипов изменен',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Поток для опубликования клипов изменен на', TOPIC_CLIPS_ID);
            break;

        case 'on':
            updateEnvVariable('TOPIC_CLIPS_ID', 0);
            TOPIC_CLIPS_ID = 0;
            processClips ??= setInterval(checkNewClip, 60 * 1000);
            response = await ctx.reply('🟢Публикование клипов включена',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Публикование клипов включена');
            break;

        case 'off':
            action = 'cancel';
            updateEnvVariable('TOPIC_CLIPS_ID', undefined);
            TOPIC_CLIPS_ID = undefined;
            clearInterval(processClips);
            processClips = undefined;
            !fs.existsSync(`./data/others/${LAST_CLIP_FILE}`) || fs.unlinkSync(`./data/others/${LAST_CLIP_FILE}`);
            lastClip = '';
            response = await ctx.reply('🔴Отключил публикование клипов',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки чата', callback_data: 'chatsettings' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Публикование клипов отключено');
            break;

        default:
            ctx.reply(`Выбран ${settingType}`);
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

bot.action(/^chatsettings:(.+)$/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const settingType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (settingType) {
        case 'chatchannel':
            ctx.editMessageText('Выбери, куда хочешь добавить бота',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Чат', callback_data: 'chatsettings:chatchannel:chat' }, { text: 'Телеграм канал', callback_data: 'chatsettings:chatchannel:channel' }],
                            [{ text: '◀️Назад', callback_data: 'chatsettings' }]
                        ]
                    }
                }
            );
            break;

        case 'threadalerts':
            let objAlerts = checkTwitch();
            if (!objAlerts.ok) {
                ctx.reply(objAlerts.reason, {
                    reply_markup: {
                        inline_keyboard: [
                            objAlerts.button
                        ]
                    }
                });
                return;
            }
            if (TYPE_CHAT === 'group') {
                action = 'threadalerts';
                phrase = generatePhrase();
                response = await ctx.reply('Окей, отправь фразу, написанная ниже, в тот поток, в который хочешь получать оповещения о стриме\n' +
                    'Для отмены дествия используй /cancel\n\n' +
                    `<code>${phrase}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Хочу отключить оповещения о стримах', callback_data: 'chatsettings:threadalerts:off' }]
                            ]
                        }
                    }
                );
            }
            else if (TYPE_CHAT === 'channel') {
                const flag = isNaN(TOPIC_ALERTS_ID) ? 'on' : '';
                ctx.reply('Окей, нажми ниже кнопку, чтобы включить/выключить оповещения о стриме\n' +
                    'Для отмены дествия используй /cancel\n\n' +
                    `<code>${phrase}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: flag ? 'Включить оповещения' : 'Выключить оповещения', callback_data: `chatsettings:threadalerts:${flag || 'off'}` }]
                            ]
                        }
                    }
                );
            }
            break;

        case 'threadnews':
            let objNews = checkNews();
            if (!objNews.ok) {
                ctx.reply(objNews.reason, {
                    reply_markup: {
                        inline_keyboard: [
                            objNews.button
                        ]
                    }
                });
                return;
            }

            if (TYPE_CHAT === 'group') {
                phrase = generatePhrase();
                action = 'threadnews';
                response = await ctx.reply('Окей, отправь фразу, написанная ниже, в тот поток, в который хочешь получать опубликованные посты\n' +
                    'Для отмены дествия используй /cancel\n\n' +
                    `<code>${phrase}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Хочу отключить пересылку постов', callback_data: 'chatsettings:threadnews:off' }]
                            ]
                        }
                    }
                );
            }
            else if (TYPE_CHAT === 'channel') {
                const flag = isNaN(TOPIC_NEWS_ID) ? 'on' : '';
                ctx.reply('Окей, нажми ниже кнопку, чтобы включить/выключить пересылку постов\n' +
                    'Для отмены дествия используй /cancel\n\n' +
                    `<code>${phrase}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: flag ? 'Включить пересылку' : 'Выключить пересылку', callback_data: `chatsettings:threadnews:${flag || 'off'}` }]
                            ]
                        }
                    }
                );
            }
            break;

        case 'threadclips':
            const obj = checkTwitch();
            if (!obj.ok) {
                ctx.reply(obj.reason, {
                    reply_markup: {
                        inline_keyboard: [
                            obj.button
                        ]
                    }
                });
                return;
            }

            if (TYPE_CHAT === 'group') {
                action = 'threadclips';
                phrase = generatePhrase();
                response = await ctx.reply('Окей, отправь фразу, написанная ниже, в тот поток, в который хочешь получать опубликованные клипы\n' +
                    'Для отмены дествия используй /cancel\n\n' +
                    `<code>${phrase}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Хочу отключить опубликование клипов', callback_data: 'chatsettings:threadclips:off' }]
                            ]
                        }
                    }
                );
            }
            else if (TYPE_CHAT === 'channel') {
                const flag = isNaN(TOPIC_CLIPS_ID) ? 'on' : '';
                ctx.reply('Окей, нажми ниже кнопку, чтобы включить/выключить публикование клипов\n' +
                    'Для отмены дествия используй /cancel\n\n' +
                    `<code>${phrase}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: flag ? 'Включить публикование' : 'Выключить публикование', callback_data: `chatsettings:threadclips:${flag || 'off'}` }]
                            ]
                        }
                    }
                );
            }
            break;

        default:
            ctx.reply(`Выбран ${settingType}`);
            break;
    }

    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            ctx.deleteMessage(response.message_id).catch();
        }, 60000);
    }
});

// ==================== Настройки чата. Конец =====================
// ==================== Настройки взаимодействия с твичом =====================

bot.action('twitch', ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const arrStars = ''.padEnd(25, '*');
    ctx.editMessageText('Текущие настройки Twitch\n\n' +
        `Канал ${TWITCH_USERNAME}\n` +
        `ID клиента: ${CLIENT_ID.slice(0, 5)}${arrStars}\n` +
        `Секретный ключ: ${CLIENT_SECRET.slice(0, 5)}${arrStars}\n\n` +
        'Текст оповещения\n' + `<i>${mesAlerts ?? 'Текст отсутствует'}</i>`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Сменить канал twitch', callback_data: 'twitch:channel' }, { text: 'Сменить токены', callback_data: 'twitch:tokens' }],
                    [{ text: 'Сменить текст оповещения', callback_data: 'twitch:alerts' }],
                    [{ text: '◀️Назад', callback_data: 'settings' }]
                ]
            }
        }
    );
});

bot.action(/twitch:(.+)/gi, async ctx => {
    if (!(isAdmin(ctx) || OWNER_ID)) return;
    const settingsType = ctx.match[1];
    const chatfrom = ctx.chat.id;
    let response = undefined;
    switch (settingsType) {
        case 'alerts':
            action = 'alertsedit';
            const text = mesAlerts ?? `Привет! ${TWITCH_USERNAME} начал(а) трансляцию`;
            response = await ctx.reply('Окей, можешь скопировать текст ниже и отредактировать или написать новый.\n' +
                'Для отмены действия напиши /cancel\n\n' +
                `<code>${text}</code>`,
                {
                    parse_mode: 'HTML'
                }
            );
            break;

        case 'channel':
            action = 'ttvchanneledit';
            response = await ctx.reply('Окей, напиши имя канала, который ты хочешь добавить/сменить. Используй /cancel для отмены действия');
            break;

        case 'tokens':
            action = 'tokensedit';
            response = await ctx.reply('Окей, сначала напиши мне ID клиента. Его можно получить на странице https://dev.twitch.tv/console/apps\n' +
                'Для отмены действия используй /cancel'
            );
            break;

        default:
            ctx.reply(`Выбран ${settingsType}`);
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

// ==================== Настройки взаимодействия с твичом. Конец =====================

bot.on('message', async ctx => {
    if (['cancel', 'chatedit'].includes(action)) return;
    if (!(isAdmin(ctx) || OWNER_ID)) return;

    const value = ctx.update.message.text;
    const chatfrom = ctx.chat.id;
    let response = undefined;
    ctx.deleteMessage(ctx.message.message_id);
    switch (action) {
        case 'ttvchanneledit':
            action = 'cancel';
            updateEnvVariable('TWITCH_USERNAME', value);
            TWITCH_USERNAME = value;
            userId = await getUserId(value, CLIENT_ID, accessToken);
            response = await ctx.reply('✅Смена канала прошла успешно.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки Twitch', callback_data: 'twitch' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Был сменен твич канал на', value);
            break;

        case 'tokensedit':
            if (value.length !== 30) {
                response = await ctx.reply('⚠️Токен имеет нестандартную длину. Введи токен без пробелов, символов ещё раз')
                break;
            }
            client_id = value;
            response = await ctx.reply('Окей, теперь введи секрет клиента');
            action = 'tokenedit1';
            break;

        case 'tokenedit1':
            if (value.length !== 30) {
                response = await ctx.reply('⚠️Токен имеет нестандартную длину. Введи токен без пробелов, символов ещё раз')
                break;
            }
            response = await ctx.reply('Подожди немного...');
            if (!(accessToken = await getAccessToken(client_id, value))) {
                ctx.deleteMessage(response.message_id);
                response = await ctx.reply('Введены неправильные токены. Убедись, что токены получены верные. Введи ID клиента снова');
                log('❌Полученные токены неверные. Токен доступа не получен');
                action = 'tokensedit';
                break;
            }

            if (!TWITCH_USERNAME) {
                await ctx.reply('⚠️Канал не был задан. Это не повлияет на работу системы, ' +
                    'однако рекомендуется добавить канал Twitch для корректного функционирования некоторых компонентов'
                );
            }

            action = 'cancel';
            ctx.deleteMessage(response.message_id);
            userId ??= await getUserId(TWITCH_USERNAME, client_id, accessToken);
            updateEnvVariable('CLIENT_ID', client_id);
            updateEnvVariable('CLIENT_SECRET', value);

            CLIENT_ID = client_id;
            CLIENT_SECRET = value;

            if (!isNaN(TOPIC_ALERTS_ID))
                processAlerts ??= setInterval(checkStream, 60 * 1000);
            if (!isNaN(TOPIC_CLIPS_ID))
                processClips ??= setInterval(checkNewClip, 60 * 1000 * 15);

            response = await ctx.reply('✅Смена токенов прошла успешно.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки Twitch', callback_data: 'twitch' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Токены были изменены');
            break;

        case 'alertsedit':
            action = 'cancel';
            saveLastData(ALERTS_MESSAGE_FILE, value);
            mesAlerts = value;
            response = await ctx.reply('✅Записал новый текст. Для проверки можешь воспользоваться командой /testalerts',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки Twitch', callback_data: 'twitch' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Текст оповещения о начале стрима изменен');
            break;

        case 'threadnews':
        case 'threadclips':
        case 'threadalerts':
            if (value === phrase) {
                if (ctx.message.chat.id == CHAT_ID) {
                    const threadName = ctx.message.reply_to_message?.forum_topic_created.name;
                    threadId = ctx.message.message_thread_id ?? '0'
                    response = await ctx.reply(`Поток: ${threadName ?? 'General'}\n` +
                        `ID: ${threadId}\n` +
                        'Все верно?',
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '✅Подтверждаю', callback_data: `chatsettings:${action}:edit` }],
                                    [{ text: '❌Нет, это не тот поток', callback_data: `chatsettings:${action}` }]
                                ]
                            }
                        }
                    );
                }
            }
            break;

        case 'telegramchanneledit':
            if (!value.includes('https://t.me/')) {
                response = await ctx.reply('❌Это не ссылка на телеграм-канал. Введи верную ссылку ещё раз');
                break;
            }

            action = 'cancel';
            TELEGRAM_CHANNEL = value.split('https://t.me/')[1];
            updateEnvVariable('TELEGRAM_CHANNEL', TELEGRAM_CHANNEL);
            !fs.existsSync(`./data/others/${LAST_POST_FILE}`) || fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
            lastPost = '';
            response = await ctx.reply('✅Смена канала прошла успешно',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️Назад в настройки пересылки постов', callback_data: 'forward' }, { text: '⏪Назад в настройки бота', callback_data: 'settings' }]
                        ]
                    }
                }
            );
            log('Канал изменен на', TELEGRAM_CHANNEL);
            break;

        case 'rssbridgeedit':
            action = 'cancel';
            DOMAIN = value;
            updateEnvVariable('DOMAIN', value);
            response = await ctx.reply('✅Изменен адрес сервера RSS-bridge');
            log('Адрес сервера RSS-bridge изменен на', value);
            break;

        case 'channeledit':
            const channel = ctx.update.message.forward_origin?.chat;
            if (!channel && channel?.type !== 'channel') {
                response = await ctx.reply('❌Это не пост с канала. Перешли любой пост с канала, на который хочешь добавить меня')
                break;
            }

            chatid = channel.id;
            response = await ctx.reply(`Канал: ${channel.title}\n` +
                `ID: ${chatid}\n` +
                'Все верно?',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅Подтверждаю', callback_data: `chatsettings:chatchannel:${action}` }],
                            [{ text: '❌Нет, это не тот канал', callback_data: `chatsettings:chatchannel:${action.slice(0, action.length - 4)}` }]
                        ]
                    }
                }
            );
            break;

        default:
            ctx.reply(`⚠️Неизвестное действие. Вот, что получил: ${action}`);
            log('Действие', action, 'отсутствует');
            break;
    }
    if (chatfrom < 0) {
        setTimeout(() => {
            if (action !== 'cancel') { cancel(ctx); }
            bot.telegram.deleteMessage(CHAT_ID, response.message_id).catch();
        }, 60000);
    }
});

async function main() {
    lastPost = loadLastData(LAST_POST_FILE);
    lastClip = loadLastData(LAST_CLIP_FILE);
    mesAlerts = loadLastData(ALERTS_MESSAGE_FILE);
    bot.launch();
    log('Бот запущен');
    if (!(OWNER_ID || CHAT_ID)) {
        console.log('Для дальнейшей работы бота необходимо добавить его в групповой чат, или написать ему в личные сообщения для добавления в телеграм канал');
    }

    // Пересылка постов
    if (!isNaN(TOPIC_NEWS_ID) && TOPIC_NEWS_ID) {
        checkNewPost();
        processNews = setInterval(checkNewPost, 60 * 1000 * 1); // Проверять посты раз в минуту
    }

    // Взаимодействие с твичом
    if (CLIENT_ID && CLIENT_SECRET) {
        accessToken = await getAccessToken(CLIENT_ID, CLIENT_SECRET);

        if (accessToken) {
            userId = await getUserId(TWITCH_USERNAME, CLIENT_ID, accessToken);

            // Проверка стримов
            if (!isNaN(TOPIC_ALERTS_ID) && TOPIC_ALERTS_ID) {
                checkStream();
                processAlerts = await setInterval(checkStream, 60 * 1000 * 1);
            }

            // Проверка новых клипов
            if (!isNaN(TOPIC_CLIPS_ID) && TOPIC_CLIPS_ID) {
                checkNewClip();
                processClips = await setInterval(checkNewClip, 60 * 1000 * 2);
            }
        }
    }
}

// Если модуль - main
if (require.main === module) {
    (async () => {
        main();
        if (!OWNER_ID) {
            adminlist = await getAdminList(CHAT_ID);
        }
    })();
}
