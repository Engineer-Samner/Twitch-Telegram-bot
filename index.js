const { Telegraf } = require('telegraf');
const fs = require('fs');

const { log, getDate, writeToFile } = require('./scripts/log.js');
const { parseTelegramPost } = require('./scripts/rss.js');
const { streamStatus, getAccessToken, getUserId, getLatestClip } = require('./scripts/twitch.js');
const { updateEnvVariable, getEnvVariable } = require('./scripts/env.js');

require('dotenv').config();
const {
    BOT_TOKEN,                      // Токен телеграм бота
    OWNER_ID                        // ID владельца бота
} = process.env;

let {
    CHAT_ID,                        // ID чата
    TYPE_CHAT,                      // Тип чата
    THREAD_ALERTS_ID,               // ID потока чата-оповещения (опционально)
    THREAD_NEWS_ID,                 // ID потока чата-новости (опционально)
    THREAD_CLIPS_ID,
    TELEGRAM_CHANNEL,               // Телеграм канал
    DOMAIN,                         // URL-адрес RSS
    TWITCH_USERNAME,                // Имя стримера
    CLIENT_ID,                      // ID клиента
    CLIENT_SECRET                   // Секретный ключ клиента
} = process.env;

const LAST_POST_FILE = 'last_post.txt'; // Файл для хранения последнего поста
const LAST_CLIP_FILE = 'last_clip.txt'; // Файл для хранения последнего клипа
const ALERTS_MESSAGE_FILE = 'alerts_mes.txt' // Файл для хранения текста оповещения о начале стрима

let lastPost = '';
let lastClip = '';
let wasLive = false;
let accessToken = '';
let userId = undefined;
let mesAlerts = '';
let processNews = undefined;
let processAlerts = undefined;
let processClips = undefined;

// Переменные для временного хранения переменных при настройке бота
let action = 'cancel';
let chatid = undefined;
let client_id = '';
let phrase = '';
let threadId = '';

if (require.main === module) {
    if (!fs.existsSync('./.env')) {
        let env = fs.readFileSync('./.env.example');
        fs.writeFileSync('./.env', env);
    }
    if (!BOT_TOKEN) {
        if (!fs.existsSync('./token.txt')) {
            console.log('Для работы бота создайте файл \"token.txt\" и запишите в него API-токен телеграм-бота. Затем снова запустите скрипт');
            setTimeout(() => { }, 10000);
            return;
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

        if (!await forwardLastPost(object.text, object.media, object.link)) return;
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
            log('Оповещение о стриме отправлен в чат', CHAT_ID, 'поток', THREAD_ALERTS_ID);
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
                message_thread_id: THREAD_CLIPS_ID,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Смотреть клип', url: object.url }]
                    ]
                }
            }
        )
        lastClip = create_date.toString();
        saveLastData(LAST_CLIP_FILE, lastClip);
        log(`Клип "${object.title}" отправлен в чат ${CHAT_ID} поток ${THREAD_CLIPS_ID}`);
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
                message_thread_id: THREAD_ALERTS_ID,
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
            const captions = [text, ...Array(urls.length - 1).fill(undefined)];

            await bot.telegram.sendMediaGroup(
                CHAT_ID,
                urls.map((url, index) => ({
                    type: url[0],
                    media: url[1],
                    caption: captions[index],
                    parse_mode: 'HTML'
                })),
                {
                    message_thread_id: THREAD_NEWS_ID
                }
            );
        } else {
            // Если нет фото/видео, отправляем только текст
            await bot.telegram.sendMessage(CHAT_ID, text,
                {
                    parse_mode: 'HTML',
                    message_thread_id: THREAD_NEWS_ID
                }
            );
        }
        log(`Пост ${link} переслан в чат`, CHAT_ID, ' поток:', THREAD_NEWS_ID);
        return true;

    } catch (error) {
        log("❌ Ошибка при отправке поста:", error.message);
        return false;
    }
}

function info(){
    bot.telegram.sendMessage(OWNER_ID, `Пересылка постов: ${processNews ? '🟢включен' : '🔴отключен'}\n` +
        `Оповещения о стримах: ${processAlerts ? '🟢включен' : '🔴отключен'}\n` +
        `Публикация клипов: ${processClips ? '🟢включен' : '🔴отключен'}`
    );
    return;
}

// ==================== Телеграм бот =====================

bot.catch((err) => {
    log('Необработанное исключение бота:', err.message);
    bot.telegram.sendMessage(OWNER_ID, `Необработанное исключение бота: ${err.message}`);
});

bot.start(ctx => {

    if (!OWNER_ID) {
        updateEnvVariable('OWNER_ID', ctx.chat.id);
    }
    else if (OWNER_ID != ctx.chat.id) {
        ctx.reply('Вы не являетесь владельцем бота. Доступ запрещен');
        return;
    }
    const username = ctx.update.message.from.first_name || 'друг';
    ctx.reply(`Привет! Рад с тобой познакомится, ${username}!\n` +
        'Я тебя запомнил и в дальнейшем буду некоторые сообщения отправлять тебе. Теперь расскажу кратко, что я умею\n' +
        '<i>- Я умею копировать посты с других публичных телеграм каналов и пересылать в чат (даже в определённый поток (тему))</i>\n' +
        '<i>- отправлять оповещения о начале стрима в чат (также в определённый поток)</i>\n\n' +
        'Собственно, это всё, что я умею. Теперь пропиши /help, чтобы вывести команды, которые во мне заложены',
        {
            parse_mode: 'HTML'
        }
    );
});

bot.help(async ctx => {
    await ctx.reply('/info - вывод информации по боту\n' +
        '/log - вывод лога за текущий день (начиная с 00-00)\n' +
        '/stop - остановка бота. Могут использовать команду администраторы чата\n' +
        '/testalerts - отправляет тестовое сообщение оповещения в чат\n' +
        '/testnews - отправляет тестовое сообщение поста в чат\n' +
        '/settings - настройки бота\n\n' +
        'Собственно, это всё, что есть из набора. Если есть пожелания или ты обнаружил ошибку, напиши разработчику @enginrr'
    );
    if (!OWNER_ID)
        await ctx.reply('На этом всё, теперь необходимо перезагрузить меня для дальшнейшей настройки');
});

bot.command('info', () => {
    info();
});

bot.command('testalerts', async (ctx) => {
    await sendAlertsMessage(mesAlerts ?? 'Прилетело оповещение сюда');
    ctx.reply('Тестовое оповещение отправлено');
    log('Тестовое оповещение было отправлено в чат', CHAT_ID, 'поток', THREAD_ALERTS_ID);
});

bot.command('testnews', async (ctx) => {
    await forwardLastPost('Тестовый пост прилетел сюда', [], 'https://testpost');
    ctx.reply('Тестовый пост отправлен');
    log('Тестовый пост отправлен в чат', CHAT_ID, 'поток', THREAD_NEWS_ID);
});

bot.command('log', async () => {
    const date = getDate();
    const fileLog = `log-${date.year}-${date.month}-${date.day}.txt`;
    try {
        if (!fs.existsSync(`./logs/${fileLog}`)) {
            throw Error('файл не найден');
        }
        await bot.telegram.sendDocument(OWNER_ID, { source: `logs/${fileLog}` });
        log('Выгружен файл', fileLog);
    }
    catch (error) {
        bot.telegram.sendMessage(OWNER_ID, `Ошибка отправки файла ${fileLog}: ${error}`);
        log(`❌Ошибка отправки файла ${fileLog}: ${error}`);
    }
});

bot.command('stop', async ctx => {
    const user_id = ctx.update.message.from.id;
    const username = ctx.update.message.from.first_name;
    let flag = true;
    await bot.telegram.getChatAdministrators(CHAT_ID).then(admins => {
        for (let admin of admins) {
            if (admin.user.id == user_id) {
                ctx.reply('Бот остановил работу');
                bot.telegram.sendMessage(OWNER_ID, `Бот остановлен администратором ${admin.user.first_name}`);
                log('Бот остановлен администратором', admin.user.first_name);
                bot.stop('Бот остановлен администратором');
                flag = false;
                return;
            }
        }
    })
    if (flag) {
        ctx.reply('❌Для выполнения команды необходимы права администратора чата');
        log(username, 'использует команду /stop: необходимы права администратора');
    }
});


bot.command('settings', ctx => {
    if (ctx.chat.id != OWNER_ID) {
        ctx.reply('❌Вы не являетесь владельцем бота. Доступ запрещен');
        return;
    }
    ctx.reply('Настройки бота',
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
});

bot.command('cancel', ctx => {
    action = 'cancel';
    threadId = undefined;
    phrase = '';
    client_id = '';
    chatid = '';
    ctx.reply('Действие отменено');
});

bot.action('settings', ctx => {
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
    ctx.editMessageText('Текущие настройки пересылки постов\n\n' +
        `Отслеживаемый канал: @${TELEGRAM_CHANNEL}\n` +
        `Адрес RSS-bridge: ${DOMAIN}`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Сменить отслеживаемый канал', callback_data: 'telegramchannel' }, { text: 'Сменить URL-адрес RSS-bridge', callback_data: 'rssbridge' }],
                    [{ text: '◀️Назад', callback_data: 'settings' }]
                ]
            }
        }
    );
});

bot.action('telegramchannel', ctx => {
    action = 'telegramchanneledit';
    ctx.reply('Окей, отправь мне ссылку на канал. Канал должен быть публичным\nДля отмены действия используй /cancel');
});

bot.action('rssbridge', ctx => {
    action = 'rssbridgeedit';
    ctx.reply('Окей, напиши адрес в формате адрес:порт, на котором развернут <a href=\"https://github.com/RSS-Bridge/rss-bridge/\">RSS-bridge</a>. Например, 127.0.0.1:3000\n' +
        'Для отмены действия используй /cancel',
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Использовать официальный сайт', callback_data: 'officialrssbridge' }]
                ]
            }
        }
    );
});

bot.action('officialrssbridge', ctx => {
    action = 'cancel';
    DOMAIN = 'rss-bridge.org/bridge01';
    updateEnvVariable('DOMAIN', DOMAIN);
    ctx.reply('✅Адрес изменен на официальный');
    log('Адрес сервера изменен на официальный');
});

// ==================== Настройки пересылки постов. Конец =====================
// ==================== Настройки чата =====================

bot.action('chatsettings', async ctx => {
    let chat = undefined;
    try {
        chat = await bot.telegram.getChat(CHAT_ID);
    }
    catch {

    }
    ctx.editMessageText('Текущие настройки чата\n\n' +
        `Чат группы/канал: ${chat?.title ?? 'Не задан или бот не состоит в группе/канале'}\n` +
        `Поток для оповещений о стриме: ${(isNaN(THREAD_ALERTS_ID) ? undefined : THREAD_ALERTS_ID) ?? 'Не задан'}\n` +
        `Поток для пересылки постов с канала ${TELEGRAM_CHANNEL}: ${(isNaN(THREAD_NEWS_ID) ? undefined : THREAD_NEWS_ID) ?? 'Не задан'}\n` +
        `Поток для опубликования клипов: ${(isNaN(THREAD_CLIPS_ID) ? undefined : THREAD_CLIPS_ID) ?? 'Не задан'}`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Сменить поток для алертов', callback_data: 'threadalerts' }, { text: 'Сменить чат/канал', callback_data: 'chatchannel' }],
                    [{ text: 'Сменить поток постов', callback_data: 'threadnews' }, { text: 'Сменить поток клипов', callback_data: 'threadclips' }],
                    [{ text: '◀️Назад', callback_data: 'settings' }]
                ]
            }
        }
    );
});

bot.action('chatchannel', ctx => {
    ctx.editMessageText('Выбери, куда хочешь добавить бота',
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Чат', callback_data: 'chat' }, { text: 'Телеграм канал', callback_data: 'channelsettings' }],
                    [{ text: '◀️Назад', callback_data: 'chatsettings' }]
                ]
            }
        }
    )
});

bot.action('channelsettings', ctx => {
    action = 'channelsettingsedit';
    ctx.reply('Окей, добавь меня в канал в качестве администратора, затем перешли мне любой пост\n' +
        '<b>🚨ВНИМАНИЕ!🚨</b>\n' +
        'После смены чата все потоки будут сброшены до заводских значений. Их восстановление будет невозможно.',
        {
            parse_mode: 'HTML'
        }
    );
});

bot.action('channelsettingsedit', ctx => {
    updateEnvVariable('TYPE_CHAT', 'channel');
    updateEnvVariable('CHAT_ID', chatid);

    updateEnvVariable('THREAD_ALERTS_ID', undefined);
    updateEnvVariable('THREAD_CLIPS_ID', undefined);
    updateEnvVariable('THREAD_NEWS_ID', undefined);
    THREAD_ALERTS_ID = THREAD_CLIPS_ID = THREAD_NEWS_ID = undefined;
    !fs.existsSync(`./data/others/${LAST_POST_FILE}`) || fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
    !fs.existsSync(`./data/others/${LAST_CLIP_FILE}`) || fs.unlinkSync(`./data/others/${LAST_CLIP_FILE}`);
    lastClip = lastPost = '';
    wasLive = false;
    clearInterval(processAlerts);
    clearInterval(processClips);
    clearInterval(processNews);

    ctx.reply('✅Смена канала/чата прошла успешно', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
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

bot.action('threadnews', ctx => {
    if (!DOMAIN && !TELEGRAM_CHANNEL) {
        ctx.reply('⚠️Пересылка постов не настроена.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Настроить пересылку постов', callback_data: 'forward' }]
                    ]
                }
            }
        );
        return;
    }
    else if (!DOMAIN) {
        ctx.reply('⚠️Адрес сервера не задан.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Задать адрес сервера', callback_data: 'rssbridge' }]
                    ]
                }
            }
        );
        return;
    }
    else if (!TELEGRAM_CHANNEL) {
        ctx.reply('⚠️Отслеживаемый канал не задан.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Задать канал', callback_data: 'telegramchannel' }]
                    ]
                }
            }
        );
        return;
    }

    if (TYPE_CHAT === 'group') {
        phrase = generatePhrase();
        action = 'threadnewsedit';
        ctx.reply('Окей, отправь фразу, написанная ниже, в тот поток, в который хочешь получать опубликованные посты\n' +
            'Для отмены дествия используй /cancel\n\n' +
            `<code>${phrase}</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Хочу отключить пересылку постов', callback_data: 'offnews' }]
                    ]
                }
            }
        );
    }
    else if (TYPE_CHAT === 'channel') {
        const flag = isNaN(THREAD_NEWS_ID) ? 'on' : '';
        ctx.reply('Окей, нажми ниже кнопку, чтобы включить/выключить пересылку постов\n' +
            'Для отмены дествия используй /cancel\n\n' +
            `<code>${phrase}</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: flag ? 'Включить пересылку' : 'Выключить пересылку', callback_data: `${flag || 'off'}news` }]
                    ]
                }
            }
        );
    }
});

bot.action('threadclips', ctx => {
    if (!CLIENT_ID && !CLIENT_SECRET && !TWITCH_USERNAME) {
        ctx.reply('⚠️Настройки twitch не заданы. ',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Настроить Twitch', callback_data: 'twitch' }]
                    ]
                }
            }
        );
        return;
    }
    else if (!CLIENT_ID && !CLIENT_SECRET) {
        ctx.reply('⚠️Токены не заданы.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Задать токены', callback_data: 'tokens' }]
                    ]
                }
            }
        );
        return;
    }
    else if (!TWITCH_USERNAME) {
        ctx.reply('⚠️Имя канала не задана.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Задать канал', callback_data: 'channel' }]
                    ]
                }
            }
        );
        return;
    }

    if (TYPE_CHAT === 'group') {
        action = 'threadclipsedit';
        phrase = generatePhrase();
        ctx.reply('Окей, отправь фразу, написанная ниже, в тот поток, в который хочешь получать опубликованные клипы\n' +
            'Для отмены дествия используй /cancel\n\n' +
            `<code>${phrase}</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Хочу отключить опубликование клипов', callback_data: 'offclips' }]
                    ]
                }
            }
        );
    }
    else if (TYPE_CHAT === 'channel') {
        const flag = isNaN(THREAD_CLIPS_ID) ? 'on' : '';
        ctx.reply('Окей, нажми ниже кнопку, чтобы включить/выключить публикование клипов\n' +
            'Для отмены дествия используй /cancel\n\n' +
            `<code>${phrase}</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: flag ? 'Включить публикование' : 'Выключить публикование', callback_data: `${flag || 'off'}clips` }]
                    ]
                }
            }
        );
    }
});

bot.action('threadalerts', ctx => {
    if (!CLIENT_ID && !CLIENT_SECRET && !TWITCH_USERNAME) {
        ctx.reply('⚠️Настройки twitch не заданы. ',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Настроить Twitch', callback_data: 'twitch' }]
                    ]
                }
            }
        );
        return;
    }
    else if (!CLIENT_ID && !CLIENT_SECRET) {
        ctx.reply('⚠️Токены не заданы.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Задать токены', callback_data: 'tokens' }]
                    ]
                }
            }
        );
        return;
    }
    else if (!TWITCH_USERNAME) {
        ctx.reply('⚠️Имя канала не задана.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Задать канал', callback_data: 'channel' }]
                    ]
                }
            }
        );
        return;
    }

    if (TYPE_CHAT === 'group') {
        action = 'threadalertsedit';
        phrase = generatePhrase();
        ctx.reply('Окей, отправь фразу, написанная ниже, в тот поток, в который хочешь получать оповещения о стриме\n' +
            'Для отмены дествия используй /cancel\n\n' +
            `<code>${phrase}</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Хочу отключить оповещения о стримах', callback_data: 'offalerts' }]
                    ]
                }
            }
        );
    }
    else if (TYPE_CHAT === 'channel') {
        const flag = isNaN(THREAD_ALERTS_ID) ? 'on' : '';
        ctx.reply('Окей, нажми ниже кнопку, чтобы включить/выключить оповещения о стриме\n' +
            'Для отмены дествия используй /cancel\n\n' +
            `<code>${phrase}</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: flag ? 'Включить оповещения' : 'Выключить оповещения', callback_data: `${flag || 'off'}alerts` }]
                    ]
                }
            }
        );
    }
});

bot.action('threadalertsedit', ctx => {
    action = 'cancel';
    updateEnvVariable('THREAD_ALERTS_ID', threadId);
    THREAD_ALERTS_ID = threadId;
    processAlerts ??= setInterval(checkStream, 60 * 1000);
    ctx.reply('✅Поток для получения оповещений о стриме изменен\nДля тестирования используй /testalerts', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Поток для отправки оповещений о стриме изменен на', THREAD_ALERTS_ID);
});

bot.action('threadnewsedit', ctx => {
    action = 'cancel';
    updateEnvVariable('THREAD_NEWS_ID', threadId);
    THREAD_NEWS_ID = threadId;
    processNews ??= setInterval(checkNewPost, 60 * 1000);
    ctx.reply('✅Поток для пересылки постов изменен. Для тестрования используй /testnews', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Поток для пересылки постов изменен на', THREAD_NEWS_ID);
});

bot.action('threadclipsedit', ctx => {
    action = 'cancel';
    updateEnvVariable('THREAD_CLIPS_ID', threadId);
    THREAD_CLIPS_ID = threadId;
    processNews ??= setInterval(checkNewClip, 2 * 60 * 1000);
    ctx.reply('✅Поток для опубликования клипов изменен', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Поток для опубликования клипов изменен на', THREAD_CLIPS_ID);
});

bot.action('onclips', ctx => {
    updateEnvVariable('THREAD_CLIPS_ID', 0);
    THREAD_CLIPS_ID = 0;
    processClips ??= setInterval(checkNewClip, 60 * 1000);
    ctx.reply('🟢Публикование клипов включена', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Публикование клипов включена');
});

bot.action('offclips', ctx => {
    action = 'cancel';
    updateEnvVariable('THREAD_CLIPS_ID', undefined);
    THREAD_CLIPS_ID = undefined;
    clearInterval(processClips);
    fs.unlinkSync(`./data/others/${LAST_CLIP_FILE}`);
    lastClip = '';
    ctx.reply('🔴Отключил публикование клипов', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Публикование клипов отключено');
});

bot.action('onnews', ctx => {
    updateEnvVariable('THREAD_NEWS_ID', 0);
    THREAD_NEWS_ID = 0;
    processNews ??= setInterval(checkNewPost, 60 * 1000);
    ctx.reply('🟢Пересылка постов включена', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Пересылка постов включена');
});

bot.action('offnews', ctx => {
    action = 'cancel';
    updateEnvVariable('THREAD_NEWS_ID', undefined);
    THREAD_NEWS_ID = undefined;
    clearInterval(processNews);
    fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
    lastPost = '';
    ctx.reply('🔴Отключил пересылку постов', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Пересылка постов отключена');
});

bot.action('onalerts', ctx => {
    updateEnvVariable('THREAD_ALERTS_ID', 0);
    THREAD_ALERTS_ID = 0;
    processAlerts ??= setInterval(checkStream, 60 * 1000);
    ctx.reply('🟢Оповещения о стриме включена', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Оповещения о стриме включена');
});

bot.action('offalerts', ctx => {
    action = 'cancel';
    updateEnvVariable('THREAD_ALERTS_ID', undefined);
    THREAD_ALERTS_ID = undefined;
    clearInterval(processAlerts);
    wasLive = false;
    ctx.reply('🔴Отключил получение оповещений о запуске стрима', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
    log('Оповещения о стриме отключены');
});

bot.action('chat', ctx => {
    action = 'chatedit';
    ctx.reply('Окей, теперь добавь меня в новую группу и исключи со старого. Для отмены введи /cancel\n' +
        '<b>🚨ВНИМАНИЕ!🚨</b>\n' +
        'После смены чата все потоки будут сброшены до заводских значений. Их восстановление будет невозможно.',
        {
            parse_mode: 'HTML'
        }
    );
});

bot.action('chatedit', ctx => {
    updateEnvVariable('CHAT_ID', chatid);
    TYPE_CHAT = 'group';
    updateEnvVariable('TYPE_CHAT', TYPE_CHAT);

    updateEnvVariable('THREAD_ALERTS_ID', undefined);
    updateEnvVariable('THREAD_CLIPS_ID', undefined);
    updateEnvVariable('THREAD_NEWS_ID', undefined);
    THREAD_ALERTS_ID = THREAD_CLIPS_ID = THREAD_NEWS_ID = undefined;
    !fs.existsSync(`./data/others/${LAST_POST_FILE}`) || fs.unlinkSync(`./data/others/${LAST_POST_FILE}`);
    !fs.existsSync(`./data/others/${LAST_CLIP_FILE}`) || fs.unlinkSync(`./data/others/${LAST_CLIP_FILE}`);
    lastClip = lastPost = '';
    wasLive = false;
    clearInterval(processAlerts);
    clearInterval(processClips);
    clearInterval(processNews);

    log('Изменён чат/канал с', CHAT_ID, 'на', chatid);
    log('Потоки сброшены на значение undefined');
    CHAT_ID = chatid;
    ctx.editMessageText('✅Смена чата прошла успешно', 
        {
            reply_markup: {
                inline_keyboard: [
                    [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                ]
            }
        }
    );
});

bot.on('my_chat_member', ctx => {
    const title = ctx.chat.title;
    chatid = ctx.chat.id;
    if (ctx.update.my_chat_member.new_chat_member.status === 'member' && action === 'chatedit') {
        bot.telegram.sendMessage(OWNER_ID, `Чат: ${title}\nID: ${chatid}\nВсё верно?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅Подтверждаю', callback_data: `chatedit` }],
                    [{ text: '❌Нет, это не тот чат', callback_data: 'chat' }]
                ]
            }
        });
    }
});

// ==================== Настройки чата. Конец =====================
// ==================== Настройки взаимодействия с твичом =====================

bot.action('twitch', ctx => {
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
                    [{ text: 'Сменить канал', callback_data: 'channel' }, { text: 'Сменить токены', callback_data: 'tokens' }],
                    [{ text: 'Сменить текст оповещения', callback_data: 'alerts' }],
                    [{ text: '◀️Назад', callback_data: 'settings' }]
                ]
            }
        }
    );
});

bot.action('alerts', ctx => {
    action = 'alertsedit';
    const text = mesAlerts ?? `Привет! ${TWITCH_USERNAME} начал(а) трансляцию`;
    ctx.reply('Окей, можешь скопировать текст ниже и отредактировать или написать новый.\n' +
        'Для отмены действия напиши /cancel\n\n' +
        `<code>${text}</code>`,
        {
            parse_mode: 'HTML'
        }
    );
});

bot.action('channel', ctx => {
    action = 'channeledit';
    ctx.reply('Окей, напиши имя канала, который ты хочешь добавить/сменить. Используй /cancel для отмены действия');
});

bot.action('tokens', ctx => {
    action = 'tokensedit';
    ctx.reply('Окей, сначала напиши мне ID клиента. Его можно получить на странице https://dev.twitch.tv/console/apps\n' +
        'Для отмены действия используй /cancel'
    );
});

// ==================== Настройки взаимодействия с твичом. Конец =====================

bot.on('message', async ctx => {
    if (['cancel', 'chatedit'].includes(action)) return;

    const value = ctx.update.message.text;
    switch (action) {
        case 'channeledit':
            updateEnvVariable('TWITCH_USERNAME', value);
            TWITCH_USERNAME = value;
            userId = await getUserId(value, CLIENT_ID, accessToken);
            await ctx.reply('✅Смена канала прошла успешно.');
            break;

        case 'tokensedit':
            if (value.length !== 30) {
                await ctx.reply('⚠️Токен имеет нестандартную длину. Введи токен без пробелов, символов ещё раз')
                return;
            }
            client_id = value;
            await ctx.reply('Окей, теперь введи секрет клиента');
            action = 'tokenedit1';
            return;

        case 'tokenedit1':
            if (value.length !== 30) {
                await ctx.reply('⚠️Токен имеет нестандартную длину. Введи токен без пробелов, символов ещё раз')
                return;
            }
            ctx.reply('Подожди немного...');
            if (!(accessToken = await getAccessToken(client_id, value))) {
                await ctx.reply('Введены неправильные токены. Убедись, что токены получены верные. Введи ID клиента снова');
                log('❌Полученные токены неверные. Токен доступа не получен');
                action = 'tokensedit';
                return;
            }

            if (!TWITCH_USERNAME) {
                ctx.reply('⚠️Канал не был задан. Это не повлияет на работу системы, ' +
                    'однако рекомендуется добавить канал Twitch для корректного функционирования некоторых компонентов',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Добавить канал', callback_data: 'channel' }]
                            ]
                        }
                    });
            }

            userId ??= await getUserId(TWITCH_USERNAME, CLIENT_ID, accessToken);
            updateEnvVariable('CLIENT_ID', client_id);
            updateEnvVariable('CLIENT_SECRET', value);

            CLIENT_ID = client_id;
            CLIENT_SECRET = value;

            if (!isNaN(THREAD_ALERTS_ID))
                processAlerts ??= setInterval(checkStream, 60 * 1000);
            if (!isNaN(THREAD_CLIPS_ID))
                processClips ??= setInterval(checkNewClip, 2 * 60 * 1000);

            await ctx.reply('✅Смена токенов прошла успешно.', 
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{text: '◀️Назад в настройки Twitch', callback_data: 'twitch'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                        ]
                    }
                }
            );
            log('Токены были изменены');
            break;

        case 'alertsedit':
            saveLastData(ALERTS_MESSAGE_FILE, value);
            mesAlerts = value;
            await ctx.reply('✅Записал новый текст. Для проверки можешь воспользоваться командой /testalerts', 
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{text: '◀️Назад в настройки Twitch', callback_data: 'twitch'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                        ]
                    }
                }
            );
            log('Текст оповещения о начале стрима изменен');
            break;

        case 'threadnewsedit':
        case 'threadclipsedit':
        case 'threadalertsedit':
            if (value === phrase) {
                if (ctx.message.chat.id == CHAT_ID) {
                    const threadName = ctx.message.reply_to_message?.forum_topic_created.name;
                    threadId = ctx.message.message_thread_id ?? '0'
                    ctx.deleteMessage(ctx.message.message_id);
                    bot.telegram.sendMessage(OWNER_ID, `Поток: ${threadName ?? 'General'}\n` +
                        `ID: ${threadId}\n` +
                        'Все верно?',
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '✅Подтверждаю', callback_data: action }],
                                    [{ text: '❌Нет, это не тот поток', callback_data: action.slice(0, action.length - 4) }]
                                ]
                            }
                        }
                    );
                }
            }
            break;

        case 'telegramchanneledit':
            if (!value.includes('https://t.me/')) {
                ctx.reply('❌Это не ссылка на телеграм-канал. Введи верную ссылку ещё раз');
                return;
            }

            TELEGRAM_CHANNEL = value.split('https://t.me/')[1];
            updateEnvVariable('TELEGRAM_CHANNEL', TELEGRAM_CHANNEL);
            ctx.reply('✅Смена канала прошла успешно', 
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{text: '◀️Назад в настройки чата', callback_data: 'chatsettings'}, {text: '⏪Назад в настройки бота', callback_data: 'settings'}]
                        ]
                    }
                }
            );
            log('Канал изменен на', TELEGRAM_CHANNEL);
            break;

        case 'rssbridgeedit':
            DOMAIN = value;
            updateEnvVariable('DOMAIN', value);
            ctx.reply('✅Изменен адрес сервера RSS-bridge');
            log('Адрес сервера RSS-bridge изменен на', value);
            break;

        case 'channelsettingsedit':
            const channel = ctx.update.message.forward_origin?.chat;
            if (!channel && channel?.type !== 'channel') {
                ctx.reply('❌Это не пост с канала. Перешли любой пост с канала, на который хочешь добавить меня')
                return;
            }
            chatid = channel.id;
            bot.telegram.sendMessage(OWNER_ID, `Канал: ${channel.title}\n` +
                `ID: ${chatid}\n` +
                'Все верно?',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅Подтверждаю', callback_data: action }],
                            [{ text: '❌Нет, это не тот канал', callback_data: action.slice(0, action.length - 4) }]
                        ]
                    }
                }
            );
            break;

        default:
            bot.telegram.sendMessage(OWNER_ID, `⚠️Неизвестное действие. Вот, что получил: ${action}`);
            log('Действие', action, 'отсутствует');
            return;
    }
    action = 'cancel';
});

async function main() {
    lastPost = loadLastData(LAST_POST_FILE);
    lastClip = loadLastData(LAST_CLIP_FILE);
    mesAlerts = loadLastData(ALERTS_MESSAGE_FILE);
    bot.launch();
    if (OWNER_ID)
        await bot.telegram.sendMessage(OWNER_ID, 'Бот запущен');
    log('Бот запущен');

    if (!CHAT_ID && OWNER_ID)
        await bot.telegram.sendMessage(OWNER_ID, '🚨Чат группы/канал не задан. Добавьте бота в чат/канал перед его настройкой',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Добавить чат/канал', callback_data: 'chatchannel' }]
                    ]
                }
            });

    // Пересылка постов
    if (!isNaN(THREAD_NEWS_ID) && THREAD_NEWS_ID) {
        checkNewPost();
        processNews = setInterval(checkNewPost, 60 * 1000 * 1); // Проверять посты раз в минуту
    }

    // Взаимодействие с твичом
    if (CLIENT_ID && CLIENT_SECRET) {
        accessToken = await getAccessToken(CLIENT_ID, CLIENT_SECRET);
        if (!TWITCH_USERNAME && OWNER_ID) {
            bot.telegram.sendMessage(OWNER_ID, '⚠️Не был указан канал Twitch',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Задать канал', callback_data: 'channel' }]
                        ]
                    }
                }
            );
        }

        if (!accessToken && OWNER_ID) {
            bot.telegram.sendMessage(OWNER_ID, '🚨Срок действия токенов истёк\n' +
                'Поменяйте их в настройках',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Сменить токены', callback_data: 'tokens' }]
                        ]
                    }
                }
            );
        }
        else {
            userId = await getUserId(TWITCH_USERNAME, CLIENT_ID, accessToken);

            // Проверка стримов
            if (!isNaN(THREAD_ALERTS_ID) && THREAD_ALERTS_ID) {
                checkStream();
                processAlerts = await setInterval(checkStream, 60 * 1000 * 1);
            }

            // Проверка новых клипов
            if (!isNaN(THREAD_CLIPS_ID) && THREAD_CLIPS_ID) {
                checkNewClip();
                processClips = await setInterval(checkNewClip, 60 * 1000 * 2);
            }
        }
    }
    else {
        if (OWNER_ID)
            bot.telegram.sendMessage(OWNER_ID, '🚨Настройки взаимодействия с Twitch не были затронуты.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Настроить Twitch', callback_data: 'twitch' }]
                        ]
                    }
                }
            );
        log('Некоторые токены для взаимодействия с Twitch отсутствуют. Часть функций отключено');
    }
    info();
}

// Если модуль - main
if (require.main === module) {
    main();
}
